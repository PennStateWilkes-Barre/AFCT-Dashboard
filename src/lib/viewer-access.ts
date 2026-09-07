import { prisma } from '@/lib/prisma';
import { canManageCourse } from '@/lib/permissions';
import type { PermissionUser } from '@/lib/permissions';
import type { ViewerFileKind } from '@/lib/viewer-link';

/**
 * Who may open a file in the standalone viewer window.
 *
 * Course staff, and nobody else. The window is a marking tool: it opens several machines at
 * once, keeps an arrangement per file, draws states and transitions that are not in the file,
 * and carries comments that live in the reader's own browser. A student looking at one attempt
 * of their own wants none of that, and the preview they get in the page is the whole job.
 *
 * Server-only, and enforced here rather than by leaving the link off the student's page. The
 * viewer's URL is guessable, bookmarkable and shareable, so "no student surface links to it" is
 * a statement about buttons, not about access.
 *
 * The file routes underneath are unchanged and still authorise every fetch on their own: a
 * student may read their own submission, which is what the preview does. This decides only who
 * gets the window around it.
 *
 * Staffness is per course, and a person can be faculty in one and a student in another. So the
 * question is always asked of the course the file belongs to, never of the account in general.
 */
export async function canOpenViewerFile(
  kind: ViewerFileKind,
  file: string,
  user: PermissionUser,
): Promise<boolean> {
  if (!user?.id) return false;

  if (kind === 'submissions') {
    const submission = await prisma.submission.findFirst({
      where: { fileName: file },
      select: { courseId: true },
    });
    // No such file reads as "not yours", the same way the properties do: telling the two apart
    // would let somebody probe for which files exist by watching the window open.
    if (!submission) return false;
    return canManageCourse(user, submission.courseId);
  }

  // A problem's own file and the solution posted with it are already staff-only at their file
  // routes. Asked again here so the window's rule is stated in one place rather than inferred
  // from what the routes happen to allow today.
  const problem = await prisma.problem.findFirst({
    where: { fileName: file },
    select: { courseId: true },
  });
  if (!problem) return false;
  return canManageCourse(user, problem.courseId);
}
