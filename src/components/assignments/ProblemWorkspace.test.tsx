/** @vitest-environment jsdom */

import React from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import ProblemWorkspace from './ProblemWorkspace';

vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: { user: { id: 'fac1' } } }),
}));
vi.mock('@/hooks/use-effective-timezone', () => ({
  useEffectiveTimezone: () => ({ timezone: 'UTC' }),
}));
// Partial mock: stubbing the whole module drops the other formatters this tree uses, and
// the failure surfaces as an unrelated "No export is defined" error.
vi.mock('@/lib/date-format', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  formatDateTimeInTimeZone: () => 'a while ago',
}));

const problem = {
  id: 'p1',
  title: 'Traffic Light',
  type: 'FA',
  maxPoints: 10,
  maxSubmissions: 3,
};

const baseProps = {
  problem,
  submissions: [],
  comments: [],
  commentText: '',
  onCommentTextChange: vi.fn(),
  onSaveComment: vi.fn(),
  onViewSubmission: vi.fn(),
  courseIsArchived: false,
  isPrivilegedUser: true,
};

const grantButton = <button type="button">Grant extra submissions</button>;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ProblemWorkspace submissions area', () => {
  // The table carries its own toolbar, headers and pager, so it is rendered in place rather
  // than inside a panel whose only content was a heading.
  it('names the table for assistive tech', () => {
    render(
      <ProblemWorkspace
        {...baseProps}
        submissions={[
          {
            id: 's1',
            status: 'COMPLETED',
            correct: true,
            fileName: 'traffic.jff',
            originalFileName: 'traffic.jff',
            problemId: 'p1',
            submittedAt: '2026-01-01T00:00:00.000Z',
          } as never,
        ]}
        submissionsAction={grantButton}
      />,
    );

    expect(screen.getByRole('table', { name: /Problem attempts/i })).toBeInTheDocument();
  });

  // Granting sits on the problem's own title row, beside what it acts on, rather than in
  // the table toolbar where it competed with the table's controls.
  it('offers the grant action on the problem row', () => {
    render(
      <ProblemWorkspace
        {...baseProps}
        submissions={[
          {
            id: 's1',
            status: 'COMPLETED',
            correct: true,
            fileName: 'traffic.jff',
            originalFileName: 'traffic.jff',
            problemId: 'p1',
            submittedAt: '2026-01-01T00:00:00.000Z',
          } as never,
        ]}
        submissionsAction={grantButton}
      />,
    );

    expect(screen.getByRole('button', { name: 'Grant extra submissions' })).toBeInTheDocument();
  });

  /**
   * The case that is easy to lose: with no attempts the table is not rendered at all, so an
   * action living in its toolbar would disappear exactly when a student has nothing yet,
   * which is a moment staff may well want to grant them another attempt.
   */
  it('keeps the grant action reachable when there are no attempts', () => {
    render(<ProblemWorkspace {...baseProps} submissionsAction={grantButton} />);

    expect(screen.getByText('No attempts yet.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Grant extra submissions' })).toBeInTheDocument();
  });

  it('renders the empty state without an action when none is given', () => {
    render(<ProblemWorkspace {...baseProps} />);

    expect(screen.getByText('No attempts yet.')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Grant extra submissions' }),
    ).not.toBeInTheDocument();
  });
});

/**
 * The verdict has to reach a screen reader.
 *
 * Result and Feedback are ordinary table cells, and a cell changing in place announces
 * nothing: a submission went from Pending to Incorrect and a counterexample appeared in a row
 * the reader had already passed, in silence. This is the student's own page, so it is the one
 * that matters most.
 */
describe('what a screen reader is told about the latest attempt', () => {
  const region = () => document.querySelector('[role="status"][aria-live="polite"]');

  const attempt = (over: Record<string, unknown> = {}) =>
    ({
      id: 's1',
      status: 'COMPLETED',
      correct: false,
      fileName: 'traffic.jff',
      originalFileName: 'traffic.jff',
      problemId: 'p1',
      submittedAt: '2026-01-01T00:00:00.000Z',
      ...over,
    }) as never;

  it('is present and empty before anything has been submitted', () => {
    render(<ProblemWorkspace {...baseProps} submissions={[]} />);

    // Mounted up front: a region inserted with its first message is not reliably announced.
    expect(region()).toBeInTheDocument();
    expect(region()).toHaveTextContent('');
  });

  it('names the attempt, the verdict and the feedback', () => {
    render(
      <ProblemWorkspace
        {...baseProps}
        submissions={[attempt({ feedback: 'Rejected on input aab' })]}
      />,
    );

    expect(region()).toHaveTextContent('Attempt 1: Incorrect. Rejected on input aab');
  });

  /**
   * A withheld result is not an empty one, and the two must not look alike. The dash the table
   * shows for "the evaluator said nothing" would tell a student exactly the wrong thing.
   */
  it('says the feedback is not shown rather than showing nothing', () => {
    render(
      <ProblemWorkspace
        {...baseProps}
        submissions={[attempt({ feedback: null, feedbackVisible: false })]}
      />,
    );

    expect(screen.getAllByText('Feedback is not shown for this problem.').length).toBeGreaterThan(
      0,
    );
    // And the same words are announced, so a screen reader is not left with the verdict alone.
    expect(region()).toHaveTextContent('Feedback is not shown for this problem.');
  });

  /** The newest attempt is the one that holds the standing grade, so it is the one announced. */
  it('reports the newest attempt, not the first', () => {
    render(
      <ProblemWorkspace
        {...baseProps}
        submissions={[
          attempt({ id: 's1', submittedAt: '2026-01-01T00:00:00.000Z' }),
          attempt({ id: 's2', correct: true, submittedAt: '2026-01-02T00:00:00.000Z' }),
        ]}
      />,
    );

    expect(region()).toHaveTextContent('Attempt 2: Correct');
  });

  it('says a submission is still waiting rather than saying nothing', () => {
    render(
      <ProblemWorkspace
        {...baseProps}
        submissions={[attempt({ status: 'PENDING', correct: null })]}
      />,
    );

    expect(region()).toHaveTextContent('Attempt 1: Pending');
  });
});

/**
 * The discussion's wait, and its end.
 *
 * The loading notice carried `role="status"` but was mounted with its own text and then
 * replaced wholesale by the panel, so a live region that announces changes had nothing to
 * change: neither the wait nor its end was ever spoken.
 */
describe('loading the discussion', () => {
  const regions = () => Array.from(document.querySelectorAll('[role="status"]'));
  const textOf = () =>
    regions()
      .map((n) => n.textContent)
      .join(' | ');

  it('says it is loading', () => {
    render(<ProblemWorkspace {...baseProps} commentsLoading />);

    expect(textOf()).toContain('Loading the discussion.');
  });

  it('says so once it has arrived, rather than falling silent', () => {
    render(<ProblemWorkspace {...baseProps} commentsLoading={false} />);

    expect(textOf()).toContain('Discussion loaded.');
  });
});

/**
 * The right column is three independent cards now: the grade, the group, then the
 * discussion. They used to be one box holding the grade and the group under a rule, which
 * made a group read as part of the marking controls rather than a fact about the work.
 */
describe('the right column', () => {
  const studentProps = { ...baseProps, isPrivilegedUser: false };

  it('gives a student their own grade card, out of the attempts card it used to hang off', () => {
    render(<ProblemWorkspace {...studentProps} currentGrade={8} />);

    const heading = screen.getByRole('heading', { name: 'Problem Grade' });
    const card = heading.closest('div')?.parentElement as HTMLElement;
    expect(card).toHaveTextContent('8');
    expect(card).toHaveTextContent('/ 10');
  });

  it('says so rather than showing nothing when the problem is not marked yet', () => {
    render(<ProblemWorkspace {...studentProps} currentGrade={null} />);

    expect(screen.getByRole('heading', { name: 'Problem Grade' })).toBeInTheDocument();
    expect(screen.getByText('Not graded yet.')).toBeInTheDocument();
  });

  it('names the group and its members on a group assignment', () => {
    render(
      <ProblemWorkspace
        {...studentProps}
        currentGrade={8}
        group={{ id: 'g1', name: 'Team Turing' }}
        groupMembers={[{ id: 'u2', firstName: 'Ada', lastName: 'Lovelace' }]}
        subjectName="You"
      />,
    );

    // Two members: the viewer plus one groupmate. The viewer is counted and listed, because
    // a list that omitted them would read as "everyone else".
    expect(screen.getByRole('heading', { name: /Team Turing · 2 members/ })).toBeInTheDocument();
    expect(screen.getByText('You, Ada Lovelace')).toBeInTheDocument();
  });

  it('shows no group card on an individual assignment', () => {
    render(<ProblemWorkspace {...studentProps} currentGrade={8} />);

    expect(screen.queryByRole('button', { name: /members/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Group' })).not.toBeInTheDocument();
  });

  it('says they are in no group, and that they submit on their own rather than blocked', () => {
    // The case that prompted this: the banner says "Type: Group" and the card was simply
    // absent, so the page never mentioned why. Submitting without a group is permitted (the
    // attempt is written with no studentGroupId), so this states the consequence and does not
    // tell them to go and get added to one.
    render(<ProblemWorkspace {...studentProps} currentGrade={null} isGroupWork group={null} />);

    expect(screen.getByRole('heading', { name: 'Group' })).toBeInTheDocument();
    expect(screen.getByText(/not in a group for this assignment/i)).toBeInTheDocument();
    expect(screen.getByText(/but you can still submit on your own/i)).toBeInTheDocument();
    expect(screen.getByText(/contact your instructor/i)).toBeInTheDocument();
    expect(screen.queryByText(/cannot submit/i)).not.toBeInTheDocument();
  });

  it('names the student rather than addressing them when a grader is looking', () => {
    render(
      <ProblemWorkspace
        {...baseProps}
        isGroupWork
        group={null}
        subjectName="Ada Lovelace"
        currentGrade={null}
        gradeInput=""
        onGradeInputChange={vi.fn()}
        onSaveGrade={vi.fn()}
      />,
    );

    expect(screen.getByText(/Ada Lovelace is not in a group/i)).toBeInTheDocument();
    expect(screen.getByText(/can still submit on their own/i)).toBeInTheDocument();
  });

  it('gives a grader the grade form instead of the readout', () => {
    render(
      <ProblemWorkspace
        {...baseProps}
        currentGrade={8}
        gradeInput="8"
        onGradeInputChange={vi.fn()}
        onSaveGrade={vi.fn()}
      />,
    );

    // One card named Problem Grade either way: the two never render together.
    expect(screen.getAllByRole('heading', { name: 'Problem Grade' })).toHaveLength(1);
    expect(screen.queryByText('Not graded yet.')).not.toBeInTheDocument();
  });
});

/**
 * The attempts table on a group assignment is the GROUP's table: every member's attempts,
 * against one shared cap. Without a name on the row a student cannot tell their own work
 * from a groupmate's, which is the question the column exists to answer.
 */
describe('the Submitted by column', () => {
  const groupSubmissions = [
    {
      id: 's1',
      status: 'COMPLETED',
      correct: true,
      fileName: 'traffic.jff',
      originalFileName: 'traffic.jff',
      submittedAt: '2026-03-01T10:00:00.000Z',
      feedback: null,
      problemId: 'p1',
      submittedBy: 'Ada Lovelace',
    },
  ];

  it('names the submitter on a group assignment', () => {
    render(<ProblemWorkspace {...baseProps} submissions={groupSubmissions} showSubmitter />);

    expect(screen.getByRole('columnheader', { name: /Submitted by/ })).toBeInTheDocument();
    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
  });

  it('leaves the column out on an individual assignment', () => {
    render(<ProblemWorkspace {...baseProps} submissions={groupSubmissions} />);

    expect(screen.queryByRole('columnheader', { name: /Submitted by/ })).not.toBeInTheDocument();
    expect(screen.queryByText('Ada Lovelace')).not.toBeInTheDocument();
  });

  it('shows a placeholder rather than a blank cell when the name did not arrive', () => {
    render(
      <ProblemWorkspace
        {...baseProps}
        submissions={[{ ...groupSubmissions[0], submittedBy: undefined }]}
        showSubmitter
      />,
    );

    expect(screen.getByRole('columnheader', { name: /Submitted by/ })).toBeInTheDocument();
  });
});

/**
 * The comment shape the student page actually sends.
 *
 * The staff view passes comments with a nested `author`; `student-context` sends a flat
 * `authorName` and `authorRole`, and this converter is what bridges them. It was the branch a
 * student's own page runs through every time and the one branch nothing exercised.
 */
describe('comments as the student page sends them', () => {
  // The flat shape `student-context` sends, as a StudentProblemComment.
  const studentShaped = {
    id: 'cm1',
    content: 'Try a dead state for the reject case.',
    createdAt: '2026-03-01T10:00:00.000Z',
    authorId: 'prof',
    authorName: 'Ada Lovelace',
    authorRole: 'FACULTY' as const,
    problemId: 'p1',
  };

  it('splits the flat name into an author the panel can render', () => {
    render(<ProblemWorkspace {...baseProps} comments={[studentShaped]} />);

    expect(screen.getByText('Try a dead state for the reject case.')).toBeInTheDocument();
    expect(screen.getByText(/Ada Lovelace/)).toBeInTheDocument();
  });

  it('keeps a multi-word surname whole rather than dropping it', () => {
    render(
      <ProblemWorkspace
        {...baseProps}
        comments={[{ ...studentShaped, authorName: 'Ada King Lovelace' }]}
      />,
    );

    expect(screen.getByText(/Ada King Lovelace/)).toBeInTheDocument();
  });

  it('survives a comment with no author name at all', () => {
    // A deleted account leaves the name empty; the thread still has to render.
    render(<ProblemWorkspace {...baseProps} comments={[{ ...studentShaped, authorName: '' }]} />);

    expect(screen.getByText('Try a dead state for the reject case.')).toBeInTheDocument();
  });
});

/**
 * Downloading your own attempt back, which is how a student gets the file they sent in order
 * to carry on from it. Entirely untested until now.
 */
describe('downloading an attempt', () => {
  const submission = {
    id: 's1',
    status: 'COMPLETED',
    correct: true,
    fileName: 'stored-abc123.jff',
    originalFileName: 'traffic light.jff',
    submittedAt: '2026-03-01T10:00:00.000Z',
    feedback: null,
    problemId: 'p1',
  };

  /**
   * The download builds an anchor and clicks it, so the anchor's own click is what to
   * intercept. Spying on `document.createElement` recurses the second time a test installs the
   * spy over the first one, which is a slower way to learn the same thing.
   */
  const clickDownload = async (over: Record<string, unknown> = {}) => {
    const clicked: { href?: string; download?: string } = {};
    const realClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      clicked.href = this.href;
      clicked.download = this.download;
    };
    try {
      render(<ProblemWorkspace {...baseProps} submissions={[{ ...submission, ...over }]} />);
      await userEvent.click(screen.getByRole('button', { name: 'Attempt actions' }));
      await userEvent.click(screen.getByRole('menuitem', { name: /download/i }));
    } finally {
      HTMLAnchorElement.prototype.click = realClick;
    }
    return clicked;
  };

  it('sends the stored file and names it what the student called it', async () => {
    const clicked = await clickDownload();

    expect(clicked.href).toContain('stored-abc123.jff');
    expect(clicked.href).toContain('download=1');
    // The name they gave it, not the one storage gave it.
    expect(clicked.download).toBe('traffic light.jff');
  });

  it('offers no actions at all for an attempt whose file is gone', async () => {
    // Nothing to download and nothing to preview, so the menu is absent rather than present
    // with a dead item in it.
    render(<ProblemWorkspace {...baseProps} submissions={[{ ...submission, fileName: null }]} />);

    expect(screen.queryByRole('button', { name: 'Attempt actions' })).not.toBeInTheDocument();
  });
});

/**
 * The two things on this page that fold away. Both default the way they do for a reason: the
 * discussion is open because feedback is what a student came for, and the group is closed
 * because the member count in its heading answers the usual question on its own.
 */
describe('the panels that collapse', () => {
  it('starts with the discussion open and closes it on request', async () => {
    render(<ProblemWorkspace {...baseProps} />);

    const toggle = screen.getByRole('button', { name: 'Collapse discussion' });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');

    await userEvent.click(toggle);

    expect(screen.getByRole('button', { name: 'Expand discussion' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  it('starts with the group members closed and opens them on request', async () => {
    render(
      <ProblemWorkspace
        {...baseProps}
        isGroupWork
        group={{ id: 'g1', name: 'Team Turing' }}
        groupMembers={[{ id: 'u2', firstName: 'Ada', lastName: 'Lovelace' }]}
        subjectName="You"
      />,
    );

    const toggle = screen.getByRole('button', { name: 'Expand members' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    await userEvent.click(toggle);

    expect(screen.getByRole('button', { name: 'Collapse members' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(screen.getByText('You, Ada Lovelace')).toBeVisible();
  });
});

/**
 * The Late badge, which is the deadline arriving in the one place a student looks for it.
 *
 * Two ways to be late and they are not the same: the server can stamp the submission LATE, or
 * the timestamp can simply fall after the deadline this viewer is held to. The second is what
 * an extension changes, so both branches matter.
 */
describe('marking an attempt late', () => {
  const at = (iso: string, over: Record<string, unknown> = {}) => ({
    id: 's1',
    status: 'COMPLETED',
    correct: true,
    fileName: 'a.jff',
    originalFileName: 'a.jff',
    submittedAt: iso,
    feedback: null,
    problemId: 'p1',
    ...over,
  });

  it('marks an attempt sent after the deadline', () => {
    render(
      <ProblemWorkspace
        {...baseProps}
        assignmentDueDate="2026-03-01T00:00:00.000Z"
        submissions={[at('2026-03-02T10:00:00.000Z')]}
      />,
    );

    // Twice over: the badge under the timestamp and the Status column's own chip. Both are
    // the same fact, which is worth knowing if either is ever reworded.
    expect(screen.getAllByText('Late').length).toBeGreaterThan(0);
  });

  it('leaves an attempt sent before it alone', () => {
    render(
      <ProblemWorkspace
        {...baseProps}
        assignmentDueDate="2026-03-01T00:00:00.000Z"
        submissions={[at('2026-02-27T10:00:00.000Z')]}
      />,
    );

    expect(screen.queryByText('Late')).not.toBeInTheDocument();
  });

  it('trusts a LATE status even with no deadline to compare against', () => {
    // The server decided this one. Without a due date there is nothing to measure it by, and
    // dropping the badge here would hide a fact somebody already established.
    render(
      <ProblemWorkspace
        {...baseProps}
        submissions={[at('2026-03-02T10:00:00.000Z', { status: 'LATE' })]}
      />,
    );

    expect(screen.getAllByText('Late').length).toBeGreaterThan(0);
  });
});

/**
 * The two actions on an attempt: opening it, and (staff only) sending it back through the
 * autograder.
 */
describe('acting on an attempt', () => {
  const submission = {
    id: 's1',
    status: 'COMPLETED',
    correct: true,
    fileName: 'stored-abc.jff',
    originalFileName: 'traffic light.jff',
    submittedAt: '2026-03-01T10:00:00.000Z',
    feedback: null,
    problemId: 'p1',
  };

  it('opens the attempt the row belongs to', async () => {
    const onViewSubmission = vi.fn();
    render(
      <ProblemWorkspace
        {...baseProps}
        submissions={[submission]}
        onViewSubmission={onViewSubmission}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: /traffic light\.jff/ }));

    expect(onViewSubmission).toHaveBeenCalledWith(submission);
  });

  it("names the file by the stored name when the student's own name is missing", async () => {
    render(
      <ProblemWorkspace {...baseProps} submissions={[{ ...submission, originalFileName: null }]} />,
    );

    expect(screen.getByRole('button', { name: /stored-abc\.jff/ })).toBeInTheDocument();
  });

  it('offers a rerun to staff and sends the right attempt', async () => {
    const onRerunSubmission = vi.fn();
    render(
      <ProblemWorkspace
        {...baseProps}
        submissions={[submission]}
        onRerunSubmission={onRerunSubmission}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Attempt actions' }));
    await userEvent.click(screen.getByRole('menuitem', { name: /rerun/i }));

    expect(onRerunSubmission).toHaveBeenCalledWith(submission);
  });

  it('offers no rerun to a student', async () => {
    render(
      <ProblemWorkspace
        {...baseProps}
        isPrivilegedUser={false}
        submissions={[submission]}
        onRerunSubmission={vi.fn()}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Attempt actions' }));

    expect(screen.queryByRole('menuitem', { name: /rerun/i })).not.toBeInTheDocument();
  });
});

/** The two states before there is a table to show. */
describe('before there are attempts to show', () => {
  it('asks for a problem when none is selected', () => {
    render(<ProblemWorkspace {...baseProps} problem={null} />);

    expect(screen.getByText(/select a problem/i)).toBeInTheDocument();
  });

  it('says it is loading rather than showing an empty table', () => {
    render(<ProblemWorkspace {...baseProps} submissionsLoading />);

    // Two live regions on this page: the table's loading announcement and the sr-only one
    // that reports the latest attempt. Only the first says anything here.
    const announced = screen.getAllByRole('status').map((el) => el.textContent ?? '');
    expect(announced.some((t) => /loading/i.test(t))).toBe(true);
  });
});

/**
 * The group card's own arithmetic. The heading counts the reader in, and a member with no
 * name still has to appear: a list that silently dropped them would misstate the size of the
 * group somebody is being graded with.
 */
describe('counting a group', () => {
  const withGroup = (
    members: { id: string; firstName: string | null; lastName: string | null }[],
  ) => (
    <ProblemWorkspace
      {...baseProps}
      isGroupWork
      group={{ id: 'g1', name: 'Team Turing' }}
      groupMembers={members}
      subjectName="You"
    />
  );

  it('counts the reader in, and says member rather than members for a group of one', () => {
    render(withGroup([]));

    expect(screen.getByRole('heading', { name: /Team Turing · 1 member$/ })).toBeInTheDocument();
  });

  it('pluralises once there is somebody else', () => {
    render(withGroup([{ id: 'u2', firstName: 'Ada', lastName: 'Lovelace' }]));

    expect(screen.getByRole('heading', { name: /Team Turing · 2 members/ })).toBeInTheDocument();
  });

  it('still lists a member whose name is missing', async () => {
    render(withGroup([{ id: 'u2', firstName: null, lastName: null }]));

    await userEvent.click(screen.getByRole('button', { name: 'Expand members' }));

    // "Student" rather than an empty gap, so the list length still matches the count above it.
    expect(screen.getByText('You, Student')).toBeInTheDocument();
  });
});

/**
 * The grader's own panel: the grade form, the LMS passback row, and the control that decides
 * whether the autograder may overwrite a mark a person entered.
 *
 * Staff-only by construction, and the reason the student's Problem Grade card exists as a
 * separate readout rather than a disabled version of this.
 */
describe('the grade panel a grader sees', () => {
  const graderProps = {
    ...baseProps,
    // The hold control only exists where the autograder could overwrite a mark, so the
    // problem has to have it switched on for there to be anything to decide.
    problem: { ...problem, autograderEnabled: true },
    currentGrade: 8,
    gradeInput: '8',
    onGradeInputChange: vi.fn(),
    onSaveGrade: vi.fn(),
  };

  it('offers the hold control, which is what stops a rerun overwriting a person', async () => {
    const onManualHoldChange = vi.fn();
    render(
      <ProblemWorkspace
        {...graderProps}
        gradeSource="MANUAL"
        gradedManually
        onManualHoldChange={onManualHoldChange}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Release to autograder' }));

    // Releasing is confirmed first: it hands a mark a person entered back to a process that
    // may overwrite it, and nothing says so until the dialog does.
    const confirm = screen.getByRole('dialog', { name: /release this grade/i });
    expect(onManualHoldChange).not.toHaveBeenCalled();

    await userEvent.click(within(confirm).getByRole('button', { name: 'Release to autograder' }));

    expect(onManualHoldChange).toHaveBeenCalledWith(false);
  });

  it('renders the LMS row once it knows which assignment to sync', () => {
    render(<ProblemWorkspace {...graderProps} assignmentId="a1" studentId="stu1" />);

    // The card decides for itself whether the course is linked to an LMS, so the assertion is
    // that the panel got as far as mounting it rather than what it then chose to show.
    expect(screen.getByRole('heading', { name: 'Problem Grade' })).toBeInTheDocument();
  });

  it('shows a student the readout instead, with no controls to press', () => {
    render(<ProblemWorkspace {...baseProps} isPrivilegedUser={false} currentGrade={8} />);

    expect(screen.getByRole('heading', { name: 'Problem Grade' })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /release to autograder/i }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /lock this grade/i })).not.toBeInTheDocument();
  });
});
