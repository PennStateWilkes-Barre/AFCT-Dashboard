/**
 * Course Join API
 *
 * Responsibilities:
 * - Accept a course registration code
 * - Validate course visibility (published + not archived)
 * - Prevent duplicate enrollment
 * - Create a roster entry as STUDENT
 *
 * Notes:
 * - Admins cannot join courses via this route.
 * - Unpublished/archived courses are masked as "not found".
 */

import { auth } from '@/lib/auth';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { NextResponse } from 'next/server';
import { createEnhancedActivityLog } from '@/lib/activity-log-utils';
import { logError } from '@/lib/api/activity';
import { evaluateJoinCodeRateLimit, formatRetryAfterSeconds } from '@/lib/security/rate-limiter';
import { isAdmin } from '@/lib/permissions';
import { readJson } from '@/lib/api/request';
import { parseValidDate } from '@/lib/date-format';

// Accept both legacy 6-char codes and the current 8-char ones (and a little slack);
// the real check is the DB lookup below.
const JoinBody = z.object({
  code: z.string().trim().min(6, 'Invalid course code').max(16, 'Invalid course code'),
});

/**
 * Enrolls the signed-in user in a course via its registration code,
 * as a STUDENT. Users never learn that an unpublished/archived course exists
 * (masked as 404). Global admins can't self-enroll, and the registration window
 * must be open.
 * @openapi
 * summary: Join a course by registration code
 * requestBody:
 *   required: true
 *   content:
 *     application/json:
 *       schema:
 *         type: object
 *         required: [code]
 *         properties:
 *           code: { type: string, description: course registration code }
 * responses:
 *   200:
 *     description: Joined; returns a message and the course.
 *   400: { description: "Invalid code, admin join attempt, already enrolled, or registration not open." }
 *   401: { description: Not signed in. }
 *   403: { description: "Enrollment was dropped; re-enrollment is a staff action." }
 *   404: { description: "Course not found (also returned for unpublished/archived courses)." }
 *   429: { description: "Too many join-code attempts; wait and retry (Retry-After header)." }
 *   500: { description: Server error. }
 */
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user || session.user.inactive) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const parsed = await readJson(req, JoinBody);
  if (!parsed.ok) return parsed.response;
  const { code } = parsed.data;

  // Before the lookup: the code space is what makes registration codes safe, and that
  // only holds if nobody gets to walk it. Keyed on the signed-in user, so a shared
  // campus address never locks a lab out of joining.
  const limit = evaluateJoinCodeRateLimit({ identifier: session.user.id });
  if (limit.status === 'blocked') {
    await createEnhancedActivityLog(prisma, req, {
      userId: session.user.id,
      action: 'COURSE_JOIN_RATE_LIMIT',
      severity: 'SECURITY',
      category: 'COURSE',
      metadata: { reason: 'too many join-code attempts' },
    });
    return NextResponse.json(
      { error: 'Too many attempts. Wait a few minutes and try again.' },
      { status: 429, headers: { 'Retry-After': formatRetryAfterSeconds(limit.retryAfterMs) } },
    );
  }

  const course = await prisma.course.findUnique({
    where: { regCode: code.toUpperCase() },
  });

  if (!course) {
    return NextResponse.json({ error: 'Course not found' }, { status: 404 });
  }

  const userId = session.user.id;

  const existing = await prisma.roster.findUnique({
    where: {
      courseId_userId: {
        courseId: course.id,
        userId,
      },
    },
  });

  if (!course.isPublished || course.isArchived) {
    // Do not reveal that an unpublished/archived course exists; say it does not exist.
    return NextResponse.json({ error: 'Course not found' }, { status: 404 });
  }

  if (isAdmin(session.user)) {
    return NextResponse.json({ error: 'Admins cannot register for courses' }, { status: 400 });
  }

  if (existing) {
    // A dropped student can't re-enroll themselves with the code: dropping is a staff
    // action, so re-enrollment is too. Tell them what to do rather than silently
    // re-adding them. (They already know they were in the course, so this reveals nothing.)
    if (existing.role === 'STUDENT' && existing.status === 'DROPPED') {
      return NextResponse.json(
        {
          error:
            'Your enrollment in this course was dropped. Contact your instructor to be re-enrolled.',
        },
        { status: 403 },
      );
    }
    return NextResponse.json(
      { error: `You are already registered for this course as ${existing.role}` },
      { status: 400 },
    );
  }

  const registrationOpenAt = parseValidDate(course.registrationOpenAt);
  const registrationCloseAt = parseValidDate(course.registrationCloseAt);

  if (!registrationOpenAt || !registrationCloseAt) {
    return NextResponse.json(
      { error: 'Registration is currently closed for this course.' },
      { status: 400 },
    );
  }

  const now = Date.now();
  if (now < registrationOpenAt.getTime()) {
    return NextResponse.json(
      { error: 'Registration is not open yet for this course.' },
      { status: 400 },
    );
  }

  if (now > registrationCloseAt.getTime()) {
    return NextResponse.json({ error: 'Registration is closed for this course.' }, { status: 400 });
  }

  // Create roster entry
  try {
    await prisma.roster.create({
      data: {
        courseId: course.id,
        userId,
        role: 'STUDENT', // self-service join always enrolls as a student
      },
    });

    await createEnhancedActivityLog(prisma, req, {
      userId,
      action: 'COURSE_JOINED',
      severity: 'INFO',
      category: 'COURSE',
      courseId: course.id,
      metadata: {
        userId,
        courseId: course.id,
        courseCode: course.code,
        courseName: course.name,
        role: 'STUDENT',
      },
    });
  } catch (error) {
    console.error('POST /api/courses/join error:', error);
    await logError(req, {
      userId,
      action: 'COURSE_JOIN_ERROR',
      error,
      category: 'COURSE',
      courseId: course.id,
    });
    return NextResponse.json({ error: 'Failed to join the course.' }, { status: 500 });
  }

  const message = `You have successfully joined ${course.name} as a Student.`;

  // The course, narrowed to what the caller needs: the toast names it and the page routes to
  // it. The whole row went back before, `regCode` included, which contradicts the rule the
  // course route states in as many words ("never send it to a student's client"). They had
  // just typed this one, so nothing was learned, but a policy that holds in one route and not
  // its neighbour is one nobody can rely on.
  return NextResponse.json({
    success: true,
    message,
    course: { id: course.id, name: course.name, code: course.code },
  });
}
