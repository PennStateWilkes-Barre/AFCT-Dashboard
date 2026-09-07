'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import type { OnChangeFn, PaginationState, SortingState } from '@tanstack/react-table';
import { DataTable } from '@/components/ui/data-table';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { CategoryBadge } from '@/components/ui/category-badge';
import { WorkspaceSurface } from '@/components/WorkspaceSurface';
import { DataTableFilterMenu } from '@/components/ui/data-table-faceted-filter';
import { FileText, Logs, ScrollText } from 'lucide-react';
import { LogViewerDialog } from '@/components/dialogs/LogViewerDialog';
import dynamic from 'next/dynamic';

// On demand: the export dialog is the only thing putting the form stack on this page.
const DownloadLogsDialog = dynamic(
  () => import('@/components/dialogs/DownloadLogsDialog').then((m) => m.DownloadLogsDialog),
  { ssr: false },
);
/** True once `open` has first been true, so a dynamic import stays deferred until first use. */
function useMountedOnce(open: boolean): boolean {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    if (open) setMounted(true);
  }, [open]);
  return mounted || open;
}
import { apiPaths } from '@/lib/api-paths';
import { LOG_CATEGORIES, LOG_SEVERITIES } from '@/lib/activity-log-values';
import {
  actionLabel,
  describeActivity,
  displayIpAddress,
  formatActivityDetails,
  summaryParts,
  SUMMARY_SEPARATOR,
} from '@/lib/activity-log-summary';
import { PAGE_HEADER_ICON_CLASS } from '@/lib/page-header';
import { clientDescription } from '@/lib/user-agent';
import { CompactDate } from '@/components/ui/CompactDate';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { formatDateTimeInTimeZone } from '@/lib/date-format';
import { useEffectiveTimezone } from '@/hooks/use-effective-timezone';
import { ACTIVITY_SEVERITY_BADGE, ACTIVITY_SEVERITY_FALLBACK } from '@/lib/badge-presets';
import { queryKeys } from '@/lib/query-keys';

type Severity = 'INFO' | 'WARNING' | 'ERROR' | 'SECURITY';

// Shape returned by GET /api/logging. `userId` is the real id, which is what Copy JSON needs;
// `userDisplayName` is the same person in words.
type LogRow = {
  id: string;
  timestamp: string;
  userId: string | null;
  userDisplayName: string | null;
  userFirstName: string | null;
  userLastName: string | null;
  userEmail: string | null;
  action: string;
  category: string | null;
  severity: Severity;
  metadata?: unknown;
  ipAddress?: string | null;
  userAgent?: string | null;
  /** The course, assignment, problem or submission this entry is about, named by the API. */
  related?: {
    course?: string | null;
    assignment?: string | null;
    problem?: string | null;
    submission?: string | null;
  } | null;
};

// 50, matching the API's own default: the page is a scan for one entry among many, and a
// short page meant reading a morning's activity a handful of lines at a time. Server mode
// does not remember a reader's choice (the page-size memory is client-mode only), so this is
// what every visit starts at.
const DEFAULT_PAGE_SIZE = 50;

const SEVERITIES: readonly Severity[] = LOG_SEVERITIES;
const CATEGORIES = LOG_CATEGORIES;

// Search scope options (server-side): restrict the text search to one field.
const SEARCH_FIELDS = [
  { value: 'all', label: 'All fields' },
  { value: 'action', label: 'Action' },
  { value: 'category', label: 'Category' },
  { value: 'name', label: 'Name' },
  { value: 'email', label: 'Email' },
];

// Title-case a coded category (e.g. ASSIGNMENT → Assignment) for display.
const titleCase = (s: string) => s.charAt(0) + s.slice(1).toLowerCase();

// Badge palette per severity level.
export default function SystemLogsClient() {
  // The timezone every other table formats in, rather than the browser's.
  const { timezone, hour12 } = useEffectiveTimezone();
  const [pageIndex, setPageIndex] = useState(0);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);

  // searchInput is what the user is typing; search is the committed (debounced)
  // query actually sent to the server.
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [searchField, setSearchField] = useState('all');
  const [severities, setSeverities] = useState<string[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [sorting, setSorting] = useState<SortingState>([{ id: 'timestamp', desc: true }]);

  const [selectedData, setSelectedData] = useState('');
  const [selectedJson, setSelectedJson] = useState('');
  const [title, setTitle] = useState('');
  const [viewerOpen, setViewerOpen] = useState(false);
  const [downloadOpen, setDownloadOpen] = useState(false);
  const downloadMounted = useMountedOnce(downloadOpen);

  // Debounce typing, and jump back to the first page when the query changes.
  useEffect(() => {
    const t = setTimeout(() => {
      setSearch(searchInput.trim());
      setPageIndex(0);
    }, 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  // Stable, serializable description of the current query, used both as the
  // React Query cache key and to build the request params. Each distinct
  // combination of page/size/search/severity/sort is cached separately.
  const sort = sorting[0];
  const queryParams = {
    page: pageIndex + 1,
    pageSize,
    q: search || undefined,
    field: searchField !== 'all' ? searchField : undefined,
    severities,
    categories,
    sortBy: sort?.id,
    sortDir: sort ? (sort.desc ? 'desc' : 'asc') : undefined,
  };

  // Cached, server-paginated log list. keepPreviousData keeps the current page
  // visible while the next one loads, so the table doesn't flash empty.
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: queryKeys.admin.logs(queryParams),
    queryFn: async () => {
      const params = new URLSearchParams({
        page: String(queryParams.page),
        pageSize: String(queryParams.pageSize),
      });
      if (queryParams.q) params.set('q', queryParams.q);
      if (queryParams.field) params.set('field', queryParams.field);
      queryParams.severities.forEach((s) => params.append('severity', s));
      queryParams.categories.forEach((c) => params.append('category', c));
      if (queryParams.sortBy) params.set('sortBy', queryParams.sortBy);
      if (queryParams.sortDir) params.set('sortDir', queryParams.sortDir);

      const res = await fetch(`${apiPaths.admin.logs()}?${params.toString()}`, {
        cache: 'no-store',
      });
      if (!res.ok) throw new Error('Failed to fetch logs');
      return (await res.json()) as { rows: LogRow[]; total: number };
    },
    placeholderData: keepPreviousData,
  });

  const logs = data?.rows ?? [];
  const total = data?.total ?? 0;
  // Blocking spinner only on the cold first load; page/search/sort changes keep the
  // previous page visible (keepPreviousData) instead of flashing "loading".
  const loading = isLoading;

  const handleViewerOpen = useCallback((row: LogRow) => {
    // Readable rather than the raw row: what happened, then who and where, then the rest.
    setSelectedData(
      formatActivityDetails({
        ...row,
        metadata: row.metadata as Record<string, unknown> | null,
        related: row.related ?? null,
        userAgent: row.userAgent ?? null,
        // The zone this table formats in, so the detail and the row it came from agree.
        timeZone: timezone,
        hour12,
      }),
    );
    // The entry as it arrived, for the Copy JSON button: the rendered text above reads well
    // but renames things, and a bug report or a disclosure record wants the real field names.
    setSelectedJson(JSON.stringify(row, null, 2));
    setTitle(formatDateTimeInTimeZone(row.timestamp, timezone, hour12));
    setViewerOpen(true);
  }, [timezone, hour12]);

  const handlePaginationChange: OnChangeFn<PaginationState> = (updater) => {
    const next = typeof updater === 'function' ? updater({ pageIndex, pageSize }) : updater;
    setPageIndex(next.pageIndex);
    setPageSize(next.pageSize);
  };

  // Sorting is done server-side; changing it resets to the first page.
  const handleSortingChange: OnChangeFn<SortingState> = (updater) => {
    const next = typeof updater === 'function' ? updater(sorting) : updater;
    setSorting(next);
    setPageIndex(0);
  };

  // Columns sort server-side (see the API's orderBy). The Full Log action isn't sortable.
  // Memoized so the array keeps a stable identity across renders (otherwise the
  // DataTable re-renders every time). Only `handleViewerOpen` is closed over.
  const columns = useMemo(
    () => [
      {
        accessorKey: 'timestamp',
        header: 'Time',
        meta: { priority: 1 },
        // The same two-line cell the Courses and User Accounts tables use: the date on top,
        // the time muted underneath, so the column stays narrow instead of forcing one wide
        // "MM/DD/YY HH:MM AM" line. It also moves this column onto the effective timezone,
        // which is what the rest of the app formats in; it was reading the browser's.
        cell: ({ getValue }: { getValue: () => unknown }) => (
          <CompactDate value={getValue() as string | null} timeZone={timezone} hour12={hour12} />
        ),
      },
      {
        accessorKey: 'severity',
        header: 'Severity',
        meta: { priority: 2 },
        // One width for every badge in the column, so their left AND right edges line up and
        // the column reads as a column rather than as chips of four different lengths. The
        // width lives here rather than on Badge: it is a fact about this table, and a global
        // fixed-width badge would wreck every other place one is used.
        //
        // 5rem, not the 4rem a glance at INFO/ERROR suggests: SECURITY is the longest value
        // and needs about 78px with its padding. The text stays centred because Badge is
        // already a centred flex box.
        //
        // min-w, not w: the widths are rem so they already scale with the reader's text size,
        // but Badge clips what overflows it, and a clipped label is a silent failure. A
        // minimum aligns the column in every ordinary case and lets the badge grow in the one
        // where the alternative was hiding half a word.
        cell: ({ getValue }: { getValue: () => unknown }) => {
          const s = ((getValue() as string) || 'INFO') as Severity;
          return (
            <Badge
              variant={ACTIVITY_SEVERITY_BADGE[s] ?? ACTIVITY_SEVERITY_FALLBACK}
              className="min-w-20"
            >
              {s}
            </Badge>
          );
        },
      },
      {
        accessorKey: 'category',
        header: 'Category',
        meta: { priority: 3 },
        // 6rem: ASSIGNMENT and SUBMISSION are the longest at about 92px, and a minimum rather
        // than a fixed width for the reason given on Severity above.
        cell: ({ getValue }: { getValue: () => unknown }) => (
          <CategoryBadge category={getValue() as string | null} className="min-w-24" />
        ),
      },
      {
        // Keyed on the last name, which is both what the column sorts by (the server's sortBy
        // allows `userLastName`) and what it leads with. One column rather than the two it
        // replaced: on a log you scan for a person, and a surname split from its given name
        // across two columns is two things to read for one answer.
        accessorKey: 'userLastName',
        header: 'User',
        meta: { priority: 2 },
        // Upper-cased the way the Action and Subject columns are, and styled rather than
        // transformed for the same reason: what a screen reader announces and what Copy JSON
        // carries stay in ordinary case.
        cell: ({ row }: { row: { original: LogRow } }) => {
          const last = row.original.userLastName?.trim();
          const first = row.original.userFirstName?.trim();
          const email = row.original.userEmail?.trim();
          if (!last && !first) return '—';
          // Two lines, the same shape the Time column uses: the name to read, the address
          // underneath in the muted size to tell two people of the same name apart. Not
          // upper-cased, because an email address is a value somebody may copy.
          return (
            <div className="leading-tight">
              <div className="uppercase">{[last, first].filter(Boolean).join(', ')}</div>
              {email ? <div className="text-muted-foreground text-xs">{email}</div> : null}
            </div>
          );
        },
      },
      {
        accessorKey: 'action',
        header: 'Action',
        meta: { priority: 1 },
        // The verb, from the shared formatter. The cell shows "Viewed"; sorting, search,
        // filters and exports still use the stored COURSE_GRADES_VIEWED. Metadata goes in too,
        // since a few verbs depend on which field an update touched.
        //
        // Upper-cased in CSS rather than transformed, the same as the User and Subject
        // columns, so what a screen reader announces and what Copy JSON carries stay in
        // ordinary case.
        cell: ({ row }: { row: { original: LogRow } }) => (
          <span className="uppercase">
            {actionLabel(
              row.original.action || '',
              row.original.metadata as Record<string, unknown> | null,
            )}
          </span>
        ),
      },
      {
        // The id is the column's own name and the header is what a reader sees; they differ
        // here because the column was called "What happened" first.
        id: 'summary',
        header: 'Subject',
        meta: { priority: 2 },
        enableSorting: false,
        // Upper-cased in CSS rather than transformed, so what a screen reader announces and
        // what Copy JSON carries stay in ordinary case.
        //
        // The separator between the object and what happened to it is punctuation between two
        // facts, so it is hidden from assistive tech the way the dashboard hides the dot in
        // "2 courses · 5 assignments". Read aloud it is "middle dot" in the middle of a
        // sentence; on screen it is what keeps the two halves apart.
        cell: ({ row }: { row: { original: LogRow } }) => {
          const parts = summaryParts(
            describeActivity(
              row.original.action,
              row.original.metadata as Record<string, unknown> | null,
              row.original.related,
            ),
          );
          if (parts.length === 0) return <span className="uppercase">—</span>;
          return (
            <span className="uppercase">
              {parts.map((part, i) => (
                <span key={i}>
                  {i > 0 ? <span aria-hidden="true">{SUMMARY_SEPARATOR}</span> : null}
                  {part}
                </span>
              ))}
            </span>
          );
        },
      },
      {
        accessorKey: 'ipAddress',
        header: 'IP Address',
        meta: { priority: 4 },
        // Two lines, the shape the Time and User columns use: the address, and under it the
        // browser and platform the request came from. An address on its own rarely settles
        // "was that really them"; the same address from a phone rather than the lab machine
        // often does. The whole header is still in the full log entry.
        cell: ({ row }: { row: { original: LogRow } }) => {
          const ip = displayIpAddress(row.original.ipAddress);
          const client = clientDescription(row.original.userAgent);
          if (!ip && !client) return '—';
          return (
            <div className="leading-tight">
              <div>{ip ?? '—'}</div>
              {client ? <div className="text-muted-foreground text-xs">{client}</div> : null}
            </div>
          );
        },
      },
      {
        // `actions`, not a name of its own: that id is what the shared mobile card view looks
        // for to put a row's action in the card's corner. Named anything else it would have
        // stayed a labelled field in the card's body, which is a one-off nobody asked for.
        id: 'actions',
        header: 'Details',
        meta: { priority: 1, align: 'center' as const },
        enableSorting: false,
        // A ghost icon rather than the solid "Full Log" button this replaces. One per row, so a
        // column of filled buttons ran down the right edge of the table with more weight than
        // the log it was pointing at. Same click, same dialog; only the presentation changed.
        cell: ({ row }: { row: { original: LogRow } }) => {
          const when = row.original.timestamp
            ? formatDateTimeInTimeZone(row.original.timestamp, timezone, hour12)
            : null;
          const what = actionLabel(
            row.original.action || '',
            row.original.metadata as Record<string, unknown> | null,
          );
          // Every row carries one of these, so the name says WHICH log: a page of buttons all
          // called "View full log" is what a screen reader would otherwise read out.
          const label = when ? `View full log for ${what} at ${when}` : `View full log for ${what}`;
          return (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={label}
                  onClick={() => handleViewerOpen(row.original)}
                >
                  {/* Bigger than the default 16px, which read as a speck in a wide row. The
                      button stays size-9 either way, so the row height does not move. */}
                  <FileText className="size-5" aria-hidden="true" />
                </Button>
              </TooltipTrigger>
              {/* The tooltip repeats the action in short form; it is not the accessible name,
                  which the button carries itself. */}
              <TooltipContent>View full log</TooltipContent>
            </Tooltip>
          );
        },
      },
    ],
    [handleViewerOpen, timezone, hour12],
  );

  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  return (
    // Same shape as the Courses page: a work page on the white surface, no outer card
    // around a table that already has a border, and a real <h1> in place of the CardTitle
    // that was carrying role="heading" aria-level={1}.
    <WorkspaceSurface>
      <section className="space-y-6" aria-labelledby="system-logs-title">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <h1
            id="system-logs-title"
            className="flex items-center gap-3 text-2xl font-semibold tracking-tight"
          >
            {/* Decorative: the heading beside it already says what this is. The icon the
                sidebar already uses for this page, on the neutral muted surface the other
                admin pages use. */}
            <Logs className={PAGE_HEADER_ICON_CLASS} aria-hidden="true" />
            <span>System Logs</span>
          </h1>
          <Button onClick={() => setDownloadOpen(true)}>Download Logs</Button>
        </div>

        {isError ? (
          <div className="border-status-danger-border bg-status-danger-bg flex items-center justify-between gap-3 rounded-md border px-3 py-2">
            <p role="alert" className="text-status-danger text-sm">
              Failed to load logs. Please try again.
            </p>
            <Button variant="outline" size="sm" onClick={() => void refetch()}>
              Retry
            </Button>
          </div>
        ) : null}

        <DataTable
          columns={columns}
          data={logs}
          loading={loading}
          tableLabel="System logs table"
          showExportButton={false}
          emptyTitle="No log entries"
          emptyDescription="No activity matches the current search and filters."
          emptyIcon={ScrollText}
          loadingMessage="Loading log entries, please wait..."
          actionButtons={
            <DataTableFilterMenu
              groups={[
                {
                  key: 'severity',
                  label: 'Severity',
                  options: SEVERITIES.map((s) => ({ label: s, value: s })),
                  selected: severities,
                  onChange: (v) => {
                    setSeverities(v);
                    setPageIndex(0);
                  },
                },
                {
                  key: 'category',
                  label: 'Category',
                  options: CATEGORIES.map((c) => ({ label: titleCase(c), value: c })),
                  selected: categories,
                  onChange: (v) => {
                    setCategories(v);
                    setPageIndex(0);
                  },
                },
              ]}
            />
          }
          manualPagination
          pageCount={pageCount}
          rowCount={total}
          pagination={{ pageIndex, pageSize }}
          onPaginationChange={handlePaginationChange}
          manualFiltering
          globalFilter={searchInput}
          onGlobalFilterChange={setSearchInput}
          searchScopeOptions={SEARCH_FIELDS}
          searchScope={searchField}
          onSearchScopeChange={(v) => {
            setSearchField(v);
            setPageIndex(0);
          }}
          manualSorting
          sorting={sorting}
          onSortingChange={handleSortingChange}
          // The one table long enough to need them: thousands of pages, and the newest and
          // oldest entries are both places somebody actually wants to get to.
          showFirstLastPage
        />

        {/* Dialogs */}
        <LogViewerDialog
          data={selectedData}
          json={selectedJson}
          open={viewerOpen}
          onOpenChange={setViewerOpen}
          title={title}
        />
        {downloadMounted && (
          <DownloadLogsDialog open={downloadOpen} onOpenChange={setDownloadOpen} />
        )}
      </section>
    </WorkspaceSurface>
  );
}
