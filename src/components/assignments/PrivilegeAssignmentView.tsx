'use client';
import { DataTable } from '@/components/ui/data-table';
import { Button } from '@/components/ui/button';
import LoadingSpinner from '@/components/ui/loading-spinner';
import {
  AlignLeft,
  BarChart3,
  ClipboardList,
  FileText,
  Fingerprint,
  Package,
  Plus,
  Shapes,
  Users,
  SlidersHorizontal,
} from 'lucide-react';
import { useParams, useSearchParams, useRouter } from 'next/navigation';
import React, { useState, useCallback, useMemo, useEffect } from 'react';
import dynamic from 'next/dynamic';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { SearchableSelect } from '@/components/ui/SearchableSelect';
import { Switch } from '@/components/ui/switch';
import {
  IdentityPanel,
  IdentityPanelIcon,
  IDENTITY_BADGE,
  IDENTITY_LINK,
} from '@/components/IdentityPanel';
import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogClose,
} from '@/components/ui/dialog';
import { showToast } from '@/lib/toast';
import { AssignmentTypeCard } from '@/components/assignments/AssignmentTypeCard';
import { AssignmentBasicsForm } from '@/components/assignments/AssignmentBasicsForm';
import { AssignmentStatisticsPanel } from '@/components/assignments/AssignmentStatisticsPanel';
import { AssignmentSimilarityPanel } from '@/components/assignments/AssignmentSimilarityPanel';
import { useCommonShare } from '@/lib/similarity-threshold';
import { Tabs, TabsContent } from '@/components/ui/tabs';
import { TabBar, TabRail } from '@/components/course/course-tabs';
import { LocalNavLayout } from '@/components/local-nav';
import { useIsDesktopNav } from '@/hooks/use-desktop-nav';
import { useConfirmIfDirty } from '@/components/unsaved-changes/UnsavedChangesProvider';
import AssignmentSubmissions from '@/components/AssignmentSubmissions';
import Link from 'next/link';
import type { Prisma, Problem } from '@prisma/client';
import { useEmptyStringSymbol } from '@/hooks/use-empty-string-symbol';
import { useEffectiveTimezone } from '@/hooks/use-effective-timezone';
import type { AssignmentWithDetails } from '@/lib/assignment-details';
import { apiPaths } from '@/lib/api-paths';
import { apiClient, ApiError } from '@/lib/api/fetch-client';
import { queryKeys } from '@/lib/query-keys';
import { asRichDescription } from '@/lib/rich-description';
import { RichDescription } from '@/components/rich-description/RichDescription';
import { buildProblemColumns } from './problem-columns';
import { GradeSyncCard } from '@/components/assignments/GradeSyncCard';
import { LmsLinkBadge } from '@/components/lti/LmsLinkBadge';
import { AssignmentLmsLinksCard } from '@/components/lti/AssignmentLmsLinksCard';
import { fetchAssignmentLmsLinks, type AssignmentLmsLink } from '@/lib/lti/fetch-assignment-links';
import { cn } from '@/lib/utils';

/**
 * The dialogs and the settings tab load on demand. Between them they were the only things
 * putting the form stack on this route, and none of them is on screen when the page opens: the
 * viewer needs a submission chosen, the settings card needs its tab selected, and the rest need
 * a menu item clicked.
 *
 * `ConfirmDialog` stays a normal import; it is small, has no form machinery, and is shared
 * app-wide, so splitting it would add a request without removing bytes.
 */
const AssociateProblemsDialog = dynamic(
  () =>
    import('@/components/dialogs/AssociateProblemsDialog').then((m) => m.AssociateProblemsDialog),
  { ssr: false },
);
const CreateProblemDialog = dynamic(
  () => import('@/components/dialogs/CreateProblemDialog').then((m) => m.CreateProblemDialog),
  { ssr: false },
);
const SubmissionViewerDialog = dynamic(
  () => import('@/components/dialogs/SubmissionViewerDialog').then((m) => m.SubmissionViewerDialog),
  { ssr: false },
);
const AssignmentProblemSettingsDialog = dynamic(
  () =>
    import('@/components/dialogs/AssignmentProblemSettingsDialog').then(
      (m) => m.AssignmentProblemSettingsDialog,
    ),
  { ssr: false },
);
const AssignmentSettingsCard = dynamic(
  () =>
    import('@/components/assignments/AssignmentSettingsCard').then((m) => m.AssignmentSettingsCard),
  {
    ssr: false,
    // This one fills the panel the author is looking at rather than appearing over it, so an
    // empty panel would read as a bug. Same reasoning as the course settings form.
    loading: () => <p className="text-muted-foreground text-sm">Loading assignment settings…</p>,
  },
);

/** True once `open` has first been true, so a dynamic import stays deferred until first use. */
function useMountedOnce(open: boolean): boolean {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    if (open) setMounted(true);
  }, [open]);
  return mounted || open;
}

type ProblemLinkSettings = {
  problemId: string;
  maxPoints: number;
  maxSubmissions: number;
  autograderEnabled: boolean;
};

type AssignmentSummary = {
  id: string;
  title: string;
};

// The "Add existing problem" picker wants optional (not nullable) description/type, so
// widen a DB problem row to that shape. Shared by its candidate and used-problem lists.
function normalizeProblem(p: Problem) {
  return {
    ...p,
    description: p.description ?? undefined,
    type: typeof p.type === 'string' ? p.type : undefined,
  };
}

// Sections that are a form get a readable measure; everything else is a table, a chart
// or a comparison and takes the full column.
const FORM_TABS = new Set(['description', 'type', 'assign-to', 'settings']);

type PrivilegeAssignmentViewProps = {
  initialAssignment?: AssignmentWithDetails | null;
  initialAssignments?: AssignmentSummary[];
};

export default function AssignmentDashboardPage({
  initialAssignment = null,
  initialAssignments,
}: PrivilegeAssignmentViewProps) {
  const { timezone } = useEffectiveTimezone();
  // xl rather than lg: a rail plus a submissions table needs the room.
  const railNav = useIsDesktopNav(1280);
  const { id, aid } = useParams<{ id: string; aid: string }>();
  const epsSymbol = useEmptyStringSymbol(id);
  const searchParams = useSearchParams();
  const router = useRouter();

  const queryClient = useQueryClient();
  const [problemToRemove, setProblemToRemove] = useState<Problem | null>(null);
  // Holds the requested publish state while the confirmation dialog is open.
  const [publishTarget, setPublishTarget] = useState<boolean | null>(null);
  const [addProblemDialogOpen, setAddProblemDialogOpen] = useState(false);
  const [createProblemOpen, setCreateProblemOpen] = useState(false);
  const associateMounted = useMountedOnce(addProblemDialogOpen);
  const createProblemMounted = useMountedOnce(createProblemOpen);
  const [editProblemDialogOpen, setEditProblemDialogOpen] = useState(false);
  const [problemToEdit, setProblemToEdit] = useState<Problem | null>(null);
  const [tab, setTab] = useState(searchParams.get('tab') || 'description');

  // Assignment shell, cached and keyed to this course/assignment via the shared
  // queryKeys.assignment.shell key, so this privileged view and the embedded
  // StudentNavigator (plus StudentAssignmentView / the max-points cell) dedupe onto
  // one read of the same ?view=problems payload instead of fetching it twice.
  // Seeded from the SSR-provided initialAssignment (view=problems shape) so there's
  // no refetch on mount when the server already sent it, and back-navigation is
  // warm. Mutations invalidate this key, triggering a background refetch that does
  // NOT blank the page; the previous data stays visible until the new payload
  // arrives.
  const assignmentQuery = useQuery({
    queryKey: queryKeys.assignment.shell(id, aid),
    queryFn: async () => {
      const res = await fetch(apiPaths.assignment(id, aid, { view: 'problems' }));
      if (!res.ok) throw new Error('Failed to fetch assignment');
      return (await res.json()) as AssignmentWithDetails;
    },
    initialData: initialAssignment ?? undefined,
    enabled: !!id && !!aid,
    staleTime: 30_000,
  });
  const assignment = assignmentQuery.data ?? null;
  const loading = assignmentQuery.isPending;

  // Invalidate the whole course->assignment prefix (the shell plus its sibling queries:
  // assignees, overrides, etc.) so a type change or audience edit doesn't leave the Assign
  // To tab reading stale sub-queries.
  const invalidateAssignment = useCallback(
    () => queryClient.invalidateQueries({ queryKey: queryKeys.assignment.all(id, aid) }),
    [queryClient, id, aid],
  );

  // Stable prop for the Assign To card. Built here (not inline in JSX) so unrelated parent
  // re-renders don't mint fresh Date objects, which would retrigger the card's reset() and
  // wipe unsaved edits. Recomputes only when the query data itself changes.
  const settingsAssignment = useMemo(() => {
    if (!assignment) return null;
    const toDate = (v: Date | string | null | undefined): Date | null =>
      v ? (typeof v === 'string' ? new Date(v) : v) : null;
    return {
      ...assignment,
      groupSetId: assignment.groupSetId ?? null,
      description: assignment.description ?? null,
      // Settings card edits dates/audience only, so the description fields are just carried
      // through to satisfy the Assignment type.
      descriptionFormat: assignment.descriptionFormat ?? ('PLAIN_TEXT' as const),
      descriptionJson: (assignment.descriptionJson ?? null) as Prisma.JsonValue,
      createdAt: assignment.createdAt ?? new Date(),
      updatedAt: assignment.updatedAt ?? new Date(),
      dueDate: toDate(assignment.dueDate) ?? new Date(),
      allowLateSubmissions: assignment.allowLateSubmissions ?? false,
      lateCutoff: toDate(assignment.lateCutoff),
      unlockAt: toDate(assignment.unlockAt),
      assignedToEveryone: assignment.assignedToEveryone ?? true,
      missingWorkIsZero: assignment.missingWorkIsZero ?? false,
      // Carried through like the description fields: the settings card does not edit it, but
      // the Assignment type requires it.
      ltiAutoSync: true,
    };
  }, [assignment]);

  const [descOpen, setDescOpen] = useState(false);
  // Both forms of the problem's description, so the dialog can render the rich one and fall
  // back to the plain text exactly like every other read surface.
  const [descTarget, setDescTarget] = useState<{
    description: string | null;
    descriptionJson: unknown;
  }>({ description: null, descriptionJson: null });
  // This privileged view is only rendered for course staff (admin or the course's
  // FACULTY/TA), so problem-management actions are gated only on the archived state.
  const courseIsArchived = assignment?.course?.isArchived ?? false;

  // JFLAP viewer dialog state
  const [viewerOpen, setViewerOpen] = useState(false);
  const [viewerSrc, setViewerSrc] = useState<string | null>(null);
  const [viewerTitle, setViewerTitle] = useState<string | undefined>(undefined);
  // Kept beside the composed title: the standalone window's tab wants the file's own name,
  // and it cannot be split back out of a heading reliably.
  const [viewerFileName, setViewerFileName] = useState<string | undefined>(undefined);
  const [jffType, setJffType] = useState<string | null>(null);

  // Allow optional file fields even if not in generated Prisma type
  type ProblemFileFields = Problem & { fileName?: string | null; originalFileName?: string | null };

  // Stable identities so the memoized column defs below don't rebuild each render.
  const openRenderViewer = useCallback((problem: Problem) => {
    const p = problem as ProblemFileFields;
    const fileName = p.fileName ?? null;
    const original = p.originalFileName ?? null;
    if (!fileName) {
      showToast.error('This problem has no file to preview.');
      return;
    }
    const src = apiPaths.files.solution(encodeURIComponent(fileName));
    setViewerSrc(src);
    setViewerTitle(`${original || fileName} - ${problem.title}`);
    setViewerFileName(original || fileName);
    setViewerOpen(true);
    setJffType(problem.type);
  }, []);

  const openDescription = useCallback((problem: Problem) => {
    setDescTarget({
      description: problem.description ?? null,
      descriptionJson: (problem as { descriptionJson?: unknown }).descriptionJson ?? null,
    });
    setDescOpen(true);
  }, []);

  // Tab switches flip local state BEFORE the URL changes, unmounting the current tab's
  // content, so a router-level guard would fire too late: the edits are already gone. Ask
  // first. `confirmIfDirty` resolves true immediately when nothing is dirty, so the pristine
  // path is unchanged.
  const confirmIfDirty = useConfirmIfDirty();
  const handleTabChange = useCallback(
    (value: string) => {
      void confirmIfDirty().then((proceed) => {
        if (!proceed) return;
        setTab(value);
        const params = new URLSearchParams(searchParams.toString());
        params.set('tab', value);
        router.replace(`?${params.toString()}`);
      });
    },
    [confirmIfDirty, searchParams, router],
  );

  // Read 1: all course problems (used by the problems tab and the add/create
  // dialogs). Only fetched when one of those surfaces needs it. On any failure
  // the queryFn returns [] (no toast), matching the previous .catch behavior.
  const problemsEnabled = tab === 'problems' || addProblemDialogOpen || createProblemOpen;
  // Reads the course's problems via ?view=problems and shares the course-detail
  // hook's ['course', id, 'problems'] cache entry, so the ProblemsCard and this
  // picker dedupe (one canonical way to list a course's problems).
  const problemsQuery = useQuery({
    queryKey: queryKeys.course.problems(id),
    queryFn: async () => {
      const res = await fetch(apiPaths.course(id, { view: 'problems' }));
      if (!res.ok) throw new Error('Failed to fetch problems');
      return (await res.json()) as { problems?: Problem[] };
    },
    enabled: !!id && problemsEnabled,
    staleTime: 30_000,
  });
  const allProblems = problemsQuery.data?.problems ?? [];
  const problemsLoading = problemsEnabled && problemsQuery.isFetching;

  // Read 2: assignment list for the dropdown. Seeded from the SSR-provided
  // initialAssignments so there's no refetch on mount when the server sent it.
  const assignmentsQuery = useQuery({
    queryKey: queryKeys.course.assignmentsList(id),
    queryFn: () =>
      fetch(apiPaths.courseAssignments(id, { includeUnpublished: true }))
        .then((res) => res.json())
        .then((data) =>
          Array.isArray(data)
            ? data.map((a: { id: string; title: string }) => ({ id: a.id, title: a.title }))
            : [],
        )
        .catch(() => [] as AssignmentSummary[]),
    initialData: initialAssignments,
    enabled: !!id,
    staleTime: 30_000,
  });
  const allAssignments = assignmentsQuery.data ?? [];
  const assignmentsLoading = assignmentsQuery.isFetching;

  // Read 3: which LMS courses open this assignment. Held here rather than inside the settings
  // card because the header badge reads the same answer, and removing a link has to change
  // both at once.
  const lmsLinksQuery = useQuery({
    queryKey: queryKeys.assignment.lmsLinks(id, aid),
    /**
     * A failure here is a failure, not an answer.
     *
     * This used to map any refusal or network error onto an empty list, so the card told
     * somebody "this assignment is not linked from an LMS course yet", which is a statement
     * about their LMS made from no information at all. Acting on it means adding a second link
     * for work that already has one. Throwing lets the card say it could not check.
     */
    queryFn: () => fetchAssignmentLmsLinks(id, aid),
    enabled: !!id && !!aid,
    staleTime: 30_000,
  });
  const lmsLinks = lmsLinksQuery.data ?? [];
  /**
   * The badge says an LMS opens this assignment, so it may only count links an LMS has opened.
   * A link the platform refused would otherwise put "In Canvas" on the header, which is the
   * same wrong claim in a smaller place. The card below gets all of them, because saying a link
   * is unconfirmed is the one screen that should.
   */
  const confirmedLmsLinks = lmsLinks.filter((link) => link.confirmedAt);

  // The course, written exactly the way the course page's own title writes it, so the two
  // screens name the same thing the same way. It used to read "Theory (CS401)" here and
  // "CS401: Theory" there, which is the sort of small disagreement that makes two pages feel
  // like two products. The code is not always present, so the name has to stand alone.
  // Optional chaining because this sits above the loading guard, where `assignment` is still
  // null; the banner that reads it only renders below that guard.
  const courseCode = assignment?.course?.code ?? assignment?.courseCode ?? '';
  const courseName = assignment?.course?.name ?? assignment?.courseName ?? assignment?.courseId;
  const courseLabel = courseCode ? `${courseCode}: ${courseName}` : courseName;

  async function handleAddProblems(
    problemIds: string[],
    problemSettings?: {
      problemId: string;
      maxPoints: number;
      maxSubmissions: number;
      autograderEnabled: boolean;
    }[],
  ) {
    if (!id || !aid) return;
    try {
      const payload: {
        problemIds: string[];
        problemSettings?: ProblemLinkSettings[];
      } = { problemIds };
      if (problemSettings && problemSettings.length > 0) payload.problemSettings = problemSettings;

      const res = await fetch(apiPaths.assignmentProblems(id, aid), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error();
      showToast.added(problemIds.length === 1 ? 'Problem' : `${problemIds.length} problems`);
    } catch {
      showToast.error(
        `Could not add the ${problemIds.length === 1 ? 'problem' : 'problems'} to this assignment. Check your connection and try again.`,
      );
    }
    await invalidateAssignment();
  }

  async function handleConfirmRemoveProblem() {
    if (!id || !aid || !problemToRemove) return;
    try {
      const res = await fetch(apiPaths.assignmentProblems(id, aid), {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ problemId: problemToRemove.id }),
      });
      if (!res.ok) throw new Error();
      showToast.removed('Problem', { name: problemToRemove.title });
    } catch {
      showToast.error(
        'Could not remove the problem from this assignment. Check your connection and try again.',
      );
    }
    await invalidateAssignment();
    setProblemToRemove(null);
  }

  const handleAddExistingProblem = () => setAddProblemDialogOpen(true);
  const handleCreateProblem = () => setCreateProblemOpen(true);
  const handleEditProblem = useCallback(
    (problem: Problem) => {
      const problemWithCourseId = {
        ...problem,
        courseId: id,
      };
      setProblemToEdit(problemWithCourseId);
      setEditProblemDialogOpen(true);
    },
    [id],
  );

  const problemTableData = useMemo(
    () =>
      (assignment?.problems ?? []).map((ap) => ({
        ...ap.problem,
        description: ap.problem.description ?? null,
        assignmentMaxPoints: ap.maxPoints,
        assignmentMaxSubmissions: ap.maxSubmissions,
        assignmentAutograderEnabled: ap.autograderEnabled,
        assignmentShowFeedback: ap.showFeedback,
      })),
    [assignment?.problems],
  );

  const submissionTabProblems = useMemo(
    () =>
      (assignment?.problems ?? []).map((ap) => ({
        id: ap.problem.id,
        title: ap.problem.title,
        description: ap.problem.description ?? undefined,
        type: ap.problem.type ? String(ap.problem.type) : undefined,
        maxStates: ap.problem.maxStates ?? undefined,
        isDeterministic: ap.problem.isDeterministic ?? undefined,
        fileName: ap.problem.fileName ?? undefined,
        originalFileName: ap.problem.originalFileName ?? undefined,
        maxPoints: ap.maxPoints,
        maxSubmissions: ap.maxSubmissions,
        autograderEnabled: ap.autograderEnabled,
      })),
    [assignment?.problems],
  );

  const usedProblems = useMemo(
    () => (assignment?.problems ?? []).map((ap) => normalizeProblem(ap.problem)),
    [assignment?.problems],
  );

  // Memoized so the DataTable isn't handed a fresh column model on every render
  // (this view re-renders on tab/dialog state and every query settle). All closed-
  // over handlers are useCallback-stable.
  const problemColumns = useMemo(
    () =>
      buildProblemColumns({
        courseIsArchived,
        openDescription,
        openRenderViewer,
        handleEditProblem,
        onRemoveProblem: setProblemToRemove,
      }),
    [courseIsArchived, openDescription, openRenderViewer, handleEditProblem],
  );

  async function handlePublishChange(checked: boolean) {
    if (!id || !aid) return;
    try {
      await apiClient.put(apiPaths.assignment(id, aid), { isPublished: checked });
      await invalidateAssignment();
    } catch (err) {
      showToast.error(err instanceof ApiError ? err.message : 'Failed to update publish state');
    }
  }

  // How many matches are worth a look, for the Similarity tab's count. Counts only, so it
  // discloses nothing about a student and writes no access entry; without it nobody in a
  // large course finds out there is anything to read without opening the tab on the off
  // chance.
  const [commonShare] = useCommonShare();
  const similarityCountQuery = useQuery({
    queryKey: queryKeys.assignment.similarityCount(id, aid, commonShare),
    queryFn: async () => {
      const res = await fetch(apiPaths.assignmentSimilarityCount(id, aid, commonShare));
      if (!res.ok) throw new Error('Failed to fetch similarity counts');
      return (await res.json()) as { matches: number; notable: number; reusedAfterPass: number };
    },
    enabled: !!id && !!aid,
    staleTime: 60_000,
  });
  const notableMatches = similarityCountQuery.data?.notable ?? 0;

  if (loading) return <LoadingSpinner label="Loading" />;
  if (!assignment) return <div className="text-destructive p-6">Assignment not found.</div>;

  const assignmentProblemForDialog = problemToEdit
    ? ((assignment.problems ?? []).find((ap) => ap.problem.id === problemToEdit.id) ?? null)
    : null;

  const assignmentSettingsForDialog = assignmentProblemForDialog
    ? {
        maxPoints: assignmentProblemForDialog.maxPoints,
        maxSubmissions: assignmentProblemForDialog.maxSubmissions,
        autograderEnabled: assignmentProblemForDialog.autograderEnabled,
        showFeedback: assignmentProblemForDialog.showFeedback,
      }
    : undefined;

  // Single source of truth for the assignment tab strip and its mobile select
  // fallback, so the two stay in sync.
  const assignmentTabs = [
    { value: 'description', label: 'Details', Icon: AlignLeft },
    { value: 'type', label: 'Type', Icon: Shapes },
    { value: 'assign-to', label: 'Assign To', Icon: Users },
    { value: 'problems', label: 'Problems', Icon: FileText },
    { value: 'submissions', label: 'Submissions', Icon: Package },
    { value: 'statistics', label: 'Statistics', Icon: BarChart3 },
    {
      value: 'similarity',
      label: 'Similarity',
      Icon: Fingerprint,
      // No badge at zero: an empty count on every assignment trains people to ignore it.
      ...(notableMatches > 0 ? { count: notableMatches } : {}),
    },
    { value: 'settings', label: 'Settings', Icon: SlidersHorizontal },
  ] as const;

  return (
    <div className="mx-auto w-full text-sm">
      <Tabs
        value={tab}
        onValueChange={handleTabChange}
        orientation={railNav ? 'vertical' : 'horizontal'}
        // gap-6, and the number is not arbitrary: `dashboard/layout.tsx` puts py-6 above
        // the banner, so this is what makes the air under it match the air over it. It was
        // gap-4, set when that padding was 16px, and it has read as a squeeze ever since.
        //
        // A gap, not a space-y-*. The Tabs primitive is `flex flex-col gap-2`, and a space-y-*
        // on top of that does not replace the gap, it ADDS to it: tailwind-merge only
        // reconciles classes that set the same property, and gap and margin are not the same
        // property. One mechanism, one value.
        className="gap-6"
      >
        {/* The same banner the course page leads with, so an assignment reads as the same kind
            of object one level down. The navy, the network, the padding and the height floor
            all come from the shared component; only what goes inside differs.

            That surface is dark in every theme, which is why the controls below carry explicit
            colours instead of the ones their primitives ship with. See the note on IdentityPanel
            for the rule and IDENTITY_BADGE / IDENTITY_LINK for the two common cases. */}
        <IdentityPanel labelledBy="assignment-page-title" tone="operational">
          {/*
            Two columns that stretch to the same height: the identity on the left, the two
            controls on the right. items-stretch plus justify-between in that right column is
            what floats the assignment picker down to the foot of the banner rather than
            leaving it tucked under the toggle; without the stretch the column is only as tall
            as its own content and there is no room to float anything into.

            Same basis split as the course banner, and load-bearing for the same reason. The
            control column is shrink-0 at the picker's 224px. At a plain `flex-1` the left
            column's basis is zero, so back when the right side was a 550px row of four things
            a 768px screen left the title about 55px and it came down one letter per line: the
            banner measured 674px tall. A full basis below sm gives the identity its own row,
            and the 24rem floor above sm makes flex-wrap drop the controls to their own line
            until there is genuinely room for both.
          */}
          <div className="flex flex-wrap items-stretch justify-between gap-x-6 gap-y-4">
            <div className="flex min-w-0 basis-full flex-col gap-3 sm:min-w-96 sm:grow sm:basis-0">
              {/*
                Title row then metadata row, which is the course banner's shape rather than a
                shape of its own, and that is the point. This used to be the icon beside a
                COLUMN holding both the title and the metadata. Same pixels, different geometry:
                the row was as tall as title plus gap plus metadata instead of as tall as the
                icon, so the two banners centred content blocks of different heights inside the
                same 118px and the text landed 4px and 8px out between the two pages. Matching
                the structure is what makes the text land in the same place; matching the height
                alone did not.
              */}
              <div className="flex items-start gap-3 sm:gap-4">
                {/* ClipboardList, not the BookOpen this used to carry. The course banner leads
                    with a Book, and at banner size an open book beside a closed one is not a
                    distinction anybody reads: the two pages looked like the same page. A
                    clipboard says "a thing set to be done" and is the one glyph here that could
                    not be mistaken for a course. */}
                <IdentityPanelIcon icon={ClipboardList} />
                {/*
                  break-words, not overflow-wrap:anywhere. `anywhere` also shrinks an element's
                  min-content width, which is what let the title collapse to one letter per line
                  at 768px; this only breaks a word that genuinely cannot fit. Never truncated:
                  this is the one place the whole title belongs.
                */}
                <h1
                  id="assignment-page-title"
                  className="min-w-0 text-2xl leading-tight font-semibold tracking-tight break-words"
                >
                  {assignment.title}
                </h1>
              </div>
              {/*
                Everything that DESCRIBES the assignment, on one wrapping row under the title, in
                the same muted-label / medium-value shape the course banner uses for Faculty and
                TAs. The split this row exists to make is passive against active: what the
                assignment is belongs here, and the column on the right is only the two things you
                operate. Type and the LMS link were both chips in that column, and four objects
                competing there made the right side the busiest part of a banner whose job is to
                name one assignment.

                min-h-6 and the 4.5rem indent are both borrowed from the course banner's metadata
                row rather than chosen here: 24px because that row is as tall as the copy buttons
                in it, and 72px because that is the icon slot plus its gap. Matching them is what
                puts this line at the same height on both pages.

                gap-x-5 with gap-y-1: far enough apart to read as separate facts on one line,
                close enough to read as one row when a long course name wraps them onto two.
              */}
              <div className="flex min-h-6 flex-wrap items-center gap-x-5 gap-y-1 text-sm sm:pl-[4.5rem]">
                {/* The course is the context the assignment hangs from, and the only value
                        here that is a link. Written the way the course page's own title writes
                        it, so the two screens name it the same. */}
                <span className="max-w-full">
                  <span className="text-course-banner-muted-foreground">Course: </span>
                  <Link
                    href={`/dashboard/courses/${assignment.course?.id || assignment.courseId}`}
                    className={cn(IDENTITY_LINK, 'font-medium break-words')}
                  >
                    {courseLabel}
                  </Link>
                </span>
                {/*
                      Text, not a chip, and no Users glyph beside it. As a tinted badge this read
                      as a state worth acting on, which group work is not: it is a fact about the
                      assignment in the same class as which course owns it. "Individual" rather
                      than "Individual assignment" because the banner it sits in has already said
                      what kind of thing this is.

                      Same groupSetId test as before, unchanged: a group set means group work.
                      The word is the whole signal now, which is a gain rather than a loss, since
                      the two hues it used to rely on were never readable by everyone anyway.
                    */}
                <span>
                  <span className="text-course-banner-muted-foreground">Type: </span>
                  <span className="font-medium">
                    {assignment.groupSetId ? 'Group' : 'Individual'}
                  </span>
                </span>
                {/* Only when an LMS opens it, which is why the badge renders nothing
                        otherwise. Kept as the shared badge rather than restated as a
                        "LMS: Canvas" pair, because that component is how an LMS link is written
                        everywhere else in the app, including the course banner beside it. */}
                <LmsLinkBadge links={confirmedLmsLinks} className={IDENTITY_BADGE} />
              </div>
            </div>

            {/*
              Controls only. Two rows, and both of them do something: the publish state, and the
              jump to another assignment underneath because it is the only thing here that leaves
              the page. The type and LMS chips that used to share this column are descriptive
              rather than actionable and have moved to the metadata row on the left, which is the
              whole point of the change: nothing in this column is here to be read.

              Right-aligned to the picker's edge, the only fixed width here, once the group is
              actually beside the title. Below sm it has wrapped underneath instead, and
              right-aligning inside a fixed block sitting at the left of the banner just indents
              everything for no reason, so it squares up on the left there. justify-between so a
              title long enough to grow the banner leaves the picker at its foot rather than
              stranding it in the middle.
            */}
            <div className="flex shrink-0 flex-col items-start justify-between gap-2 sm:items-end">
              {/* Server enforces the guards (e.g. no unpublish after submissions). */}
              <label className="flex shrink-0 items-center gap-2 text-sm font-medium">
                {/* The switch ships with page-token colours: an --input track that goes pure
                    black in high contrast (invisible on a black banner) and a thumb that flips
                    to near-white in dark mode. Pinned here instead. The thumb stays white in
                    both states and the track carries the state, which is how a switch is
                    normally read, and the white border keeps the track findable whatever is
                    behind it. The important modifier is not decoration: the thumb's own
                    `dark:` rules are a specificity step above a plain descendant selector. */}
                <Switch
                  aria-label="Published"
                  checked={!!assignment.isPublished}
                  onCheckedChange={(checked) => setPublishTarget(!!checked)}
                  disabled={courseIsArchived}
                  className={
                    'border-white/40 data-[state=checked]:bg-blue-400 ' +
                    'data-[state=unchecked]:bg-white/20 dark:data-[state=unchecked]:bg-white/20 ' +
                    'focus-visible:border-white focus-visible:ring-white/80 ' +
                    '[&_[data-slot=switch-thumb]]:bg-white!'
                  }
                />
                Published
              </label>
              {/* Quick jump to another assignment in this course. */}
              <div className="w-56 shrink-0">
                <SearchableSelect
                  items={allAssignments.map((a) => ({ id: a.id, label: a.title }))}
                  onSelect={(assignmentId) => {
                    // Switching assignments unmounts every form on this page; ask first when
                    // one of them holds pending edits.
                    void confirmIfDirty().then((proceed) => {
                      if (!proceed) return;
                      // Carry the current tab across the jump so switching assignments keeps
                      // you on the same view (e.g. staying on Submissions or Statistics).
                      const tabQuery = `?tab=${encodeURIComponent(tab)}`;
                      if (id) router.push(`/dashboard/courses/${id}/${assignmentId}${tabQuery}`);
                      // Without the course id there is no absolute path to push, so this
                      // falls back to a RELATIVE navigation resolved against the current
                      // URL. next/navigation's router has no relative form, which is what
                      // the lint rule below cannot express.
                      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
                      else window.location.href = `${assignmentId}${tabQuery}`;
                    });
                  }}
                  placeholder={assignmentsLoading ? 'Loading…' : 'Switch assignment'}
                  searchPlaceholder="Search assignments..."
                  emptyStateText="No assignments found."
                  disabled={assignmentsLoading}
                  // h-9, a step down from the shared field height. At h-11 this one control set
                  // the banner's height on its own and left it taller than the course page's.
                  //
                  // The trigger's shared field class is otherwise built for a light page: a
                  // --card fill and a --muted-foreground label, both of which vanish on navy.
                  // The chevron is coloured inside the component, so it takes a descendant rule.
                  triggerClassName={
                    'h-9 text-sm border-white/25 bg-white/10 text-white hover:bg-white/15 ' +
                    'focus-visible:border-white focus-visible:ring-white/80 [&_svg]:text-white/70'
                  }
                />
              </div>
            </div>
          </div>
        </IdentityPanel>

        {/* Below xl this is a plain stack, so the strip sits above the panels as it did.
            At xl the rail takes a fixed column beside them. One control at a time: two
            tablists under one Tabs root would duplicate its ARIA wiring. */}
        {/* Form sections stay a readable measure; the data sections (Problems,
            Submissions, Statistics, Similarity) take the whole column, since they are
            tables, charts and comparisons. */}
        <LocalNavLayout
          contentClassName={cn(FORM_TABS.has(tab) && 'max-w-3xl')}
          nav={
            railNav ? (
              <TabRail
                tabs={assignmentTabs}
                ariaLabel="Assignment sections"
                menuLabel="Assignment Menu"
              />
            ) : (
              <TabBar
                ariaLabel="Assignment sections"
                selectId="assignment-tab-select"
                value={tab}
                onValueChange={handleTabChange}
                tabs={assignmentTabs}
              />
            )
          }
        >
          <TabsContent value="description">
            <div className="space-y-4">
              <h2 className="flex items-center gap-2 text-xl font-semibold">
                <AlignLeft className="h-6 w-6" />
                Details
              </h2>
              <AssignmentBasicsForm
                courseId={id}
                assignmentId={assignment.id}
                initialTitle={assignment.title}
                initialDescription={assignment.description ?? ''}
                initialDescriptionJson={asRichDescription(assignment.descriptionJson)}
                courseIsArchived={courseIsArchived}
                onSaved={() => void invalidateAssignment()}
              />
            </div>
          </TabsContent>
          <TabsContent value="type">
            <div className="space-y-4">
              <h2 className="flex items-center gap-2 text-xl font-semibold">
                <Shapes className="h-6 w-6" />
                Type
              </h2>
              <AssignmentTypeCard
                courseId={id}
                assignmentId={assignment.id}
                groupSetId={assignment.groupSetId ?? null}
                courseIsArchived={courseIsArchived}
                onChanged={() => void invalidateAssignment()}
              />
            </div>
          </TabsContent>
          <TabsContent
            value="problems"
            className="animate-fade-in-up transition-opacity duration-300"
          >
            <div className="space-y-4">
              {/* flex-wrap and a gap: the heading and the two buttons do not fit on one line
                  on a phone, and justify-between alone just pushed the buttons off the edge. */}
              <div className="flex w-full flex-wrap items-center justify-between gap-2">
                <h2 className="flex items-center gap-2 text-xl font-semibold">
                  <FileText className="h-6 w-6" />
                  Problems
                </h2>
                {/* flex-wrap: "Create Problem" and "Add Existing Problem" side by side are
                    wider than a phone, and neither label shortens. */}
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="default"
                    aria-label="Create Problem"
                    onClick={handleCreateProblem}
                    disabled={problemsLoading}
                    hidden={courseIsArchived}
                  >
                    <Plus />
                    Create Problem
                  </Button>
                  <Button
                    variant="default"
                    aria-label="Add Existing Problem"
                    onClick={handleAddExistingProblem}
                    disabled={problemsLoading}
                    hidden={courseIsArchived}
                  >
                    <Plus />
                    Add Existing Problem
                  </Button>
                </div>
              </div>
              <p
                className="text-muted-foreground max-w-3xl text-sm text-balance"
                hidden={courseIsArchived}
              >
                This assignment consists of the following problems. You may add an existing problem
                from this course using the <strong>Add Existing Problem</strong> button in the
                upper-right corner, or create a new problem using the{' '}
                <strong>Create Problem</strong> button.
              </p>
              <DataTable
                columns={problemColumns}
                data={problemTableData}
                tableLabel="Assignment problems table"
                defaultSorting={[{ id: 'title', desc: false }]}
                // Max States and Deterministic are niche; hide them by default. They
                // stay available through the Columns menu.
                defaultColumnVisibility={{ maxStates: false, isDeterministic: false }}
                emptyTitle="No problems on this assignment"
                emptyDescription="Add problems so students have something to solve."
                emptyIcon={FileText}
              />
            </div>
          </TabsContent>
          <TabsContent value="submissions">
            <AssignmentSubmissions
              courseIsArchived={courseIsArchived}
              courseId={id}
              assignmentId={aid}
              maxAssignmentGrade={assignment.maxPoints}
              problems={submissionTabProblems}
            />
          </TabsContent>
          <TabsContent value="statistics">
            <AssignmentStatisticsPanel />
          </TabsContent>
          <TabsContent value="similarity">
            {/* A group set means the work belongs to teams, which changes who a finding is
                about: any member may submit for the team. The panel is told rather than
                left to infer it from the rows. */}
            <AssignmentSimilarityPanel groupAssignment={!!assignment.groupSetId} />
          </TabsContent>
          <TabsContent value="settings">
            {/* This tab had no heading at all: two panels appeared under the tab rail with
                nothing naming what they were. */}
            <div className="space-y-4">
              <h2 className="flex items-center gap-2 text-xl font-semibold">
                <SlidersHorizontal className="h-6 w-6" />
                Settings
              </h2>
              <GradeSyncCard assignmentId={aid} variant="settings" />
              <AssignmentLmsLinksCard
                courseId={id}
                assignmentId={aid}
                links={lmsLinks}
                loading={lmsLinksQuery.isLoading}
                failed={lmsLinksQuery.isError}
                onRetry={() => void lmsLinksQuery.refetch()}
                courseIsArchived={courseIsArchived}
                onRemoved={(linkId) =>
                  queryClient.setQueryData(
                    ['course', id, 'assignment', aid, 'lms-links'],
                    (current: AssignmentLmsLink[] | undefined) =>
                      (current ?? []).filter((link) => link.id !== linkId),
                  )
                }
              />
            </div>
          </TabsContent>

          <TabsContent value="assign-to">
            <div className="space-y-4">
              <h2 className="flex items-center gap-2 text-xl font-semibold">
                <Users className="h-6 w-6" />
                Assign To
              </h2>
              {settingsAssignment ? (
                <AssignmentSettingsCard
                  courseId={id}
                  courseIsArchived={courseIsArchived}
                  // Edit the dates in the COURSE's zone (what the server stores them in).
                  timeZone={assignment.course?.timezone ?? timezone}
                  assignment={settingsAssignment}
                  onSaved={() => {
                    void invalidateAssignment();
                  }}
                />
              ) : null}
            </div>
          </TabsContent>
        </LocalNavLayout>
      </Tabs>
      {/* Submission viewer dialog, keyed off the problem type. */}
      {viewerOpen && viewerSrc && (
        <SubmissionViewerDialog
          open={viewerOpen}
          onOpenChange={setViewerOpen}
          problemType={jffType}
          src={viewerSrc}
          title={viewerTitle}
          fileName={viewerFileName}
          epsSymbol={epsSymbol}
          width="80vw"
          height="80vh"
          showGridDefault={true}
        />
      )}
      {/* Description dialog */}
      <Dialog open={descOpen} onOpenChange={(v) => setDescOpen(v)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Problem Description</DialogTitle>
          </DialogHeader>
          {/* asChild swaps the default <p> for a div, because a rich description can contain
              headings, lists, and rules, which are invalid inside a paragraph. Radix keeps the
              generated id and the dialog's aria-describedby pointing at this element either
              way, so the dialog stays described. */}
          <DialogDescription asChild>
            <div>
              {descTarget.description || descTarget.descriptionJson ? (
                <RichDescription
                  // Heading base: dialog title is an h2, so the description starts one level below it.
                  headingBaseLevel={3}
                  description={descTarget.description}
                  descriptionJson={descTarget.descriptionJson}
                />
              ) : (
                'No description.'
              )}
            </div>
          </DialogDescription>
          <DialogClose asChild>
            <Button variant="secondary">Close</Button>
          </DialogClose>
        </DialogContent>
      </Dialog>
      {associateMounted && (
        <AssociateProblemsDialog
          open={addProblemDialogOpen}
          onClose={() => setAddProblemDialogOpen(false)}
          courseId={id}
          assignmentId={aid}
          courseIsArchived={courseIsArchived}
          allProblems={allProblems.map(normalizeProblem)}
          usedProblems={usedProblems}
          onAddProblems={(selectedProblemIds, problemSettings) => {
            return handleAddProblems(selectedProblemIds, problemSettings);
          }}
        />
      )}
      {createProblemMounted && (
        <CreateProblemDialog
          open={createProblemOpen}
          setOpen={setCreateProblemOpen}
          courseId={id}
          courseIsArchived={courseIsArchived}
          assignmentId={aid}
          onCreated={async (created) => {
            await queryClient.invalidateQueries({ queryKey: queryKeys.course.problems(id) });
            if (created?.id && !aid) {
              await handleAddProblems([created.id]);
            }
          }}
        />
      )}
      <ConfirmDialog
        open={!!problemToRemove}
        variant="destructive"
        title="Remove problem from assignment?"
        description={
          problemToRemove
            ? `"${problemToRemove.title}" is removed from this assignment. The problem itself stays in the course problem bank.`
            : undefined
        }
        confirmText="Remove problem"
        onConfirm={handleConfirmRemoveProblem}
        onCancel={() => setProblemToRemove(null)}
      />

      <ConfirmDialog
        open={publishTarget !== null}
        title={publishTarget ? 'Publish assignment?' : 'Unpublish assignment?'}
        description={
          publishTarget
            ? 'This assignment becomes visible to the students it is assigned to.'
            : 'Students will no longer see this assignment.'
        }
        confirmText={publishTarget ? 'Publish' : 'Unpublish'}
        onConfirm={async () => {
          const next = publishTarget;
          if (next === null) return;
          await handlePublishChange(next);
          setPublishTarget(null);
        }}
        onCancel={() => setPublishTarget(null)}
      />
      {problemToEdit && assignmentSettingsForDialog && (
        <AssignmentProblemSettingsDialog
          open={editProblemDialogOpen}
          setOpen={setEditProblemDialogOpen}
          courseId={id}
          assignmentId={aid}
          problemId={problemToEdit.id}
          problemTitle={problemToEdit.title}
          settings={assignmentSettingsForDialog}
          courseIsArchived={courseIsArchived}
          onSaved={() => {
            void invalidateAssignment();
          }}
        />
      )}
    </div>
  );
}
