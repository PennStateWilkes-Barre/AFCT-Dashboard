import { describe, it, expect, vi, beforeEach } from 'vitest';

const prismaMock = vi.hoisted(() => ({
  submission: { findFirst: vi.fn(), count: vi.fn() },
  problem: { findFirst: vi.fn() },
}));
const canManageCourseMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }));
vi.mock('@/lib/permissions', () => ({ canManageCourse: canManageCourseMock }));

import { loadViewerProperties } from './viewer-properties';

const STAFF = { id: 'staff-1', isAdmin: false };
const OWNER = { id: 'student-1', isAdmin: false };
const OUTSIDER = { id: 'someone-else', isAdmin: false };

const submission = {
  id: 'sub-3',
  originalFileName: 'answer.jff',
  createdAt: new Date('2026-03-04T09:05:00Z'),
  submittedAt: new Date('2026-03-04T09:05:00Z'),
  evaluatedAt: new Date('2026-03-04T09:07:00Z'),
  status: 'COMPLETED',
  correct: false,
  feedback: 'Rejects 0110, which the language contains.',
  assignmentId: 'assignment-1',
  problemId: 'problem-1',
  studentId: 'student-1',
  courseId: 'course-1',
  student: { firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.test' },
  studentGroup: null,
  course: { name: 'Automata', code: 'CMPEN 331' },
  assignmentProblem: {
    showFeedback: true,
    assignment: { title: 'Homework 2' },
    problem: { title: 'Three consecutive 1s', type: 'FA' },
  },
};

const value = (rows: { label: string; value: string }[], label: string) =>
  rows.find((r) => r.label === label)?.value;

describe('loadViewerProperties', () => {
  beforeEach(() => {
    prismaMock.submission.findFirst.mockReset();
    prismaMock.submission.count.mockReset();
    prismaMock.submission.count.mockResolvedValue(3);
    prismaMock.problem.findFirst.mockReset();
    canManageCourseMock.mockReset();
  });

  it('tells course staff where a submission came from', async () => {
    prismaMock.submission.findFirst.mockResolvedValue(submission);
    canManageCourseMock.mockResolvedValue(true);

    const props = await loadViewerProperties('submissions', 'stored.jff', STAFF);
    expect(value(props!.rows, 'Course')).toBe('CMPEN 331 Automata');
    expect(value(props!.rows, 'Assignment')).toBe('Homework 2');
    expect(value(props!.rows, 'Problem')).toBe('Three consecutive 1s');
    expect(value(props!.rows, 'Kind')).toBe('Student submission');
    expect(value(props!.rows, 'Student')).toBe('Ada Lovelace');
    expect(value(props!.rows, 'Submitted')).toContain('2026-03-04');
  });

  it('says nothing about the recorded grade, which is the gradebook to state', async () => {
    // The evaluator's verdict on one attempt and a student's grade for a problem are two
    // different facts. The first is here; the second is not, and a properties panel is exactly
    // where that line would quietly erode.
    prismaMock.submission.findFirst.mockResolvedValue(submission);
    canManageCourseMock.mockResolvedValue(true);

    const props = await loadViewerProperties('submissions', 'stored.jff', STAFF);
    const labels = props!.rows.map((r) => r.label.toLowerCase()).join(' ');
    expect(labels).not.toMatch(/grade|score|mark|points|released/);
  });

  it("numbers the attempt among that student's own run at that problem", async () => {
    prismaMock.submission.findFirst.mockResolvedValue(submission);
    prismaMock.submission.count.mockResolvedValue(3);
    canManageCourseMock.mockResolvedValue(true);

    const props = await loadViewerProperties('submissions', 'stored.jff', STAFF);

    expect(value(props!.rows, 'Attempt')).toBe('3');
    // Their own attempts at this problem in this assignment, up to and including this one.
    expect(prismaMock.submission.count).toHaveBeenCalledWith({
      where: {
        assignmentId: 'assignment-1',
        problemId: 'problem-1',
        studentId: 'student-1',
        submittedAt: { lte: submission.submittedAt },
      },
    });
  });

  it('says when it was sent and when the evaluator finished with it', async () => {
    prismaMock.submission.findFirst.mockResolvedValue(submission);
    canManageCourseMock.mockResolvedValue(true);

    const props = await loadViewerProperties('submissions', 'stored.jff', STAFF);

    expect(value(props!.rows, 'Submitted')).toBe('2026-03-04 09:05 UTC');
    expect(value(props!.rows, 'Evaluated')).toBe('2026-03-04 09:07 UTC');
  });

  it('leaves out the grading time for an attempt that has not reached one', async () => {
    prismaMock.submission.findFirst.mockResolvedValue({
      ...submission,
      evaluatedAt: null,
      status: 'PENDING',
      correct: null,
    });
    canManageCourseMock.mockResolvedValue(true);

    const props = await loadViewerProperties('submissions', 'stored.jff', STAFF);

    expect(value(props!.rows, 'Evaluated')).toBeUndefined();
    // Where it got to, rather than "Incorrect": those are opposite things to read.
    expect(value(props!.rows, 'Result')).toBe('Waiting to be graded');
  });

  it("gives staff the evaluator's verdict and its feedback", async () => {
    prismaMock.submission.findFirst.mockResolvedValue(submission);
    canManageCourseMock.mockResolvedValue(true);

    const props = await loadViewerProperties('submissions', 'stored.jff', STAFF);

    expect(value(props!.rows, 'Result')).toBe('Incorrect');
    expect(value(props!.rows, 'Feedback')).toBe('Rejects 0110, which the language contains.');
  });

  /**
   * The student's own way to the feedback is the assignment page, where the course's own
   * show-or-hide setting applies and where reading it is recorded for the study. A second,
   * silent way here would risk showing what a course withheld and would leave a hole in the
   * record of what students do with feedback.
   */
  it('withholds the feedback text from the student, and still tells them the verdict', async () => {
    prismaMock.submission.findFirst.mockResolvedValue(submission);
    canManageCourseMock.mockResolvedValue(false);

    const props = await loadViewerProperties('submissions', 'stored.jff', OWNER);

    expect(value(props!.rows, 'Feedback')).toBeUndefined();
    expect(value(props!.rows, 'Result')).toBe('Incorrect');
    expect(value(props!.rows, 'Attempt')).toBe('3');
  });

  it('lets the submitting student see their own', async () => {
    prismaMock.submission.findFirst.mockResolvedValue(submission);
    canManageCourseMock.mockResolvedValue(false);

    expect(await loadViewerProperties('submissions', 'stored.jff', OWNER)).not.toBeNull();
  });

  it('refuses somebody who is neither, without saying which reason', async () => {
    // "No such file" and "not yours" return the same null, so the panel cannot be used to
    // probe for which files exist.
    prismaMock.submission.findFirst.mockResolvedValue(submission);
    canManageCourseMock.mockResolvedValue(false);
    expect(await loadViewerProperties('submissions', 'stored.jff', OUTSIDER)).toBeNull();

    prismaMock.submission.findFirst.mockResolvedValue(null);
    expect(await loadViewerProperties('submissions', 'missing.jff', STAFF)).toBeNull();
  });

  it('names the group and the person who uploaded, on group work', async () => {
    // The grade counts for the group, so the group has to be named. Somebody still uploaded
    // the file, and losing that would make it impossible to say who did.
    prismaMock.submission.findFirst.mockResolvedValue({
      ...submission,
      studentGroup: { name: 'Team 4' },
    });
    canManageCourseMock.mockResolvedValue(true);

    const props = await loadViewerProperties('submissions', 'stored.jff', STAFF);
    expect(value(props!.rows, 'Kind')).toBe('Student submission (group work)');
    expect(value(props!.rows, 'Group')).toBe('Team 4');
    expect(value(props!.rows, 'Uploaded by')).toBe('Ada Lovelace');
  });

  it('says outright whether a file is a solution or a student attempt', async () => {
    // The two look identical on the canvas, and mistaking the answer key for a student's work
    // is the expensive confusion here.
    prismaMock.problem.findFirst.mockResolvedValue({
      title: 'Three consecutive 1s',
      type: 'FA',
      originalFileName: 'solution.jff',
      createdAt: new Date('2026-01-02T00:00:00Z'),
      updatedAt: new Date('2026-02-03T00:00:00Z'),
      courseId: 'course-1',
      course: { name: 'Automata', code: 'CMPEN 331' },
    });
    canManageCourseMock.mockResolvedValue(true);

    const solution = await loadViewerProperties('solutions', 'stored.jff', STAFF);
    expect(value(solution!.rows, 'Kind')).toBe("Instructor's solution");

    const problemFile = await loadViewerProperties('problems', 'stored.jff', STAFF);
    expect(value(problemFile!.rows, 'Kind')).toBe('Problem file');
  });

  it('falls back to the email when a student has no name recorded', async () => {
    prismaMock.submission.findFirst.mockResolvedValue({
      ...submission,
      student: { firstName: null, lastName: null, email: 'ada@example.test' },
    });
    canManageCourseMock.mockResolvedValue(true);

    const props = await loadViewerProperties('submissions', 'stored.jff', STAFF);
    expect(value(props!.rows, 'Student')).toBe('ada@example.test');
  });

  it('describes a solution file, and refuses a non-staff reader', async () => {
    prismaMock.problem.findFirst.mockResolvedValue({
      title: 'Three consecutive 1s',
      type: 'FA',
      originalFileName: 'solution.jff',
      createdAt: new Date('2026-01-02T00:00:00Z'),
      updatedAt: new Date('2026-02-03T00:00:00Z'),
      courseId: 'course-1',
      course: { name: 'Automata', code: 'CMPEN 331' },
    });

    canManageCourseMock.mockResolvedValue(true);
    const props = await loadViewerProperties('solutions', 'stored.jff', STAFF);
    expect(value(props!.rows, 'Problem')).toBe('Three consecutive 1s');
    expect(value(props!.rows, 'Added')).toContain('2026-01-02');

    // A solution is the answer key. A student must never reach it, even as metadata.
    canManageCourseMock.mockResolvedValue(false);
    expect(await loadViewerProperties('solutions', 'stored.jff', OWNER)).toBeNull();
  });
});
