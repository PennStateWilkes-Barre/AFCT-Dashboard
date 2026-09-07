'use client';

import React from 'react';

import type {
  ColumnDef,
  ColumnFiltersState,
  VisibilityState,
  SortingState,
  PaginationState,
  OnChangeFn,
  FilterFn,
} from '@tanstack/react-table';
import {
  flexRender,
  getCoreRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  getFacetedRowModel,
  getFacetedUniqueValues,
  useReactTable,
} from '@tanstack/react-table';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useState, useMemo, useRef, useCallback, useEffect } from 'react';
import { ArrowUp, ArrowDown, ArrowUpDown, Inbox } from 'lucide-react';
import { usePersistentColumnVisibility } from '@/components/ui/use-persistent-column-visibility';
import { usePersistentPageSize } from '@/components/ui/use-persistent-page-size';
import { buildTableCsv, downloadCsv } from '@/components/ui/data-table-export';
import { DataTableLoading, DataTableEmptyState } from '@/components/ui/data-table-status';
import {
  multiSelectFilter,
  alignTextClass,
  alignFlexClass,
  ariaSort,
  responsiveClass,
  columnLabel,
} from '@/components/ui/data-table-shared';
import { DataTableToolbar } from '@/components/ui/data-table-toolbar';
import { PaginationControls, DataTablePagination } from '@/components/ui/data-table-pagination';
import { DataTableCards, useStackedView } from '@/components/ui/data-table-cards';

interface DataTableProps<TData, TValue> {
  columns: ColumnDef<TData, TValue>[];
  data: TData[];
  loading?: boolean;
  storageKey?: string;
  tableLabel?: string;
  showExportButton?: boolean;
  /** Hide the entire toolbar (search, filters, Columns, Export). For small embedded
   *  tables (e.g. a dialog) that don't need any of it. Pagination still renders. */
  showToolbar?: boolean;
  actionButtons?: React.ReactNode;
  defaultColumnVisibility?: VisibilityState;
  /** Heading shown when the table has no rows. Defaults to "No data found". */
  emptyTitle?: string;
  /** Sub-text under the empty heading. Defaults to a generic filters/entries hint. */
  emptyDescription?: string;
  /**
   * Icon for the empty state. Pass a component (e.g. a lucide icon like `Archive`);
   * it's rendered with the table's standard size/color. Defaults to `Inbox`.
   */
  emptyIcon?: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
  /**
   * Status text shown beside the spinner while `loading`. Defaults to a generic
   * "Loading data, please wait...". This is the table's live-region announcement,
   * so keep it a sentence a screen reader can read out, not a bare noun.
   */
  loadingMessage?: string;
  /**
   * Optional call-to-action rendered under the empty-state text -- typically the same
   * button the page header offers (e.g. "Create Course"), so a first-run user can act
   * without hunting for it. Omitted when the table has rows.
   */
  emptyAction?: React.ReactNode;
  /**
   * Keep the header row visible while the body scrolls. Off by default: it only helps
   * when the table is inside its own scroll container with a bounded height, and it
   * would otherwise change every existing table's behavior.
   */
  stickyHeader?: boolean;
  /**
   * Rows per page before the user has chosen one. Ten by default, which suits most tables
   * here; raise it for a short list that is nicer read whole. Only the starting value: a
   * deliberate change from the page-size select still wins and is remembered per table.
   */
  defaultPageSize?: number;
  /**
   * Draw gridlines between rows and columns (a spreadsheet look). Off by default so
   * existing tables keep their borderless style; opt in for dense grids like the
   * gradebook where cell boundaries aid scanning. Only affects the desktop table, not
   * the mobile card view.
   */
  bordered?: boolean;

  // ---- Server-side ("manual") mode: all optional; omit for client-side. ----
  // When a controlled value + handler is provided, the table hands that concern
  // (pagination / sorting / filtering) to the parent instead of computing it
  // over `data`. Existing callers pass none of these and keep client behavior.
  /**
   * Add First and Last page buttons either side of the arrows.
   *
   * Off everywhere by default: most tables here are a page or two long, where jumping to the
   * end is a control nobody needs. It earns its place on a log, where the table is thousands
   * of pages and both ends are real destinations. A server table has to state its `pageCount`
   * for the pair to appear at all; see the note in PaginationControls.
   */
  showFirstLastPage?: boolean;
  manualPagination?: boolean;
  /** Total page count, required when manualPagination is on. */
  pageCount?: number;
  /** Total row count across all pages (for the footer summary). */
  rowCount?: number;
  pagination?: PaginationState;
  onPaginationChange?: OnChangeFn<PaginationState>;

  manualSorting?: boolean;
  sorting?: SortingState;
  onSortingChange?: OnChangeFn<SortingState>;
  /** Initial client-side sort (uncontrolled). Ignored when `sorting` is controlled. */
  defaultSorting?: SortingState;
  manualFiltering?: boolean;
  globalFilter?: string;
  onGlobalFilterChange?: (value: string) => void;
  /**
   * Server-side search scope. Provide explicit options (e.g. `[{value:'all',label:'All
   * columns'}, {value:'action',label:'Action'}]`) plus a controlled value/handler to get
   * the same segmented scope dropdown the client tables derive from their columns. The
   * first option is the default; the parent decides what scoping means server-side.
   */
  searchScopeOptions?: { value: string; label: string }[];
  searchScope?: string;
  onSearchScopeChange?: (value: string) => void;
}

export function DataTable<TData, TValue>({
  columns,
  data,
  loading = false,
  storageKey = 'datatable-columns',
  tableLabel = 'Data table',
  showExportButton = true,
  showToolbar = true,
  actionButtons,
  defaultColumnVisibility = {},
  emptyTitle = 'No data found',
  emptyDescription = 'Try adjusting filters or adding new entries.',
  emptyIcon: EmptyIcon = Inbox,
  loadingMessage = 'Loading data, please wait...',
  emptyAction,
  stickyHeader = false,
  defaultPageSize = 10,
  bordered = false,
  showFirstLastPage = false,
  manualPagination = false,
  pageCount,
  rowCount,
  pagination: paginationProp,
  onPaginationChange,
  manualSorting = false,
  sorting: sortingProp,
  onSortingChange,
  defaultSorting = [],
  manualFiltering = false,
  globalFilter: globalFilterProp,
  onGlobalFilterChange,
  searchScopeOptions,
  searchScope: searchScopeProp,
  onSearchScopeChange,
}: DataTableProps<TData, TValue>) {
  const { columnVisibility, setColumnVisibility, resetColumns } = usePersistentColumnVisibility(
    storageKey,
    defaultColumnVisibility,
  );

  // Each of filtering / sorting / pagination is controlled by the parent when a
  // value is supplied, otherwise held internally (the original client behavior).
  const [internalGlobalFilter, setInternalGlobalFilter] = useState('');
  const globalFilter = globalFilterProp ?? internalGlobalFilter;
  const setGlobalFilter = onGlobalFilterChange ?? setInternalGlobalFilter;

  // Client-side value filters (faceted). Server mode owns its own filtering.
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);

  // Search scope: 'all' searches every column, otherwise only the named column
  // (client mode). In server mode the parent controls the scope value + meaning.
  // Read through a ref inside the (stable) global filter fn so changing scope
  // doesn't need a new function identity / table rebuild.
  const [internalSearchScope, setInternalSearchScope] = useState('all');
  const searchScope = searchScopeProp ?? internalSearchScope;
  const setSearchScope = onSearchScopeChange ?? setInternalSearchScope;
  const searchScopeRef = useRef(searchScope);
  searchScopeRef.current = searchScope;
  const scopedGlobalFilter = useCallback<FilterFn<TData>>((row, columnId, value) => {
    const scope = searchScopeRef.current;
    if (scope !== 'all' && columnId !== scope) return false;
    return String(row.getValue(columnId) ?? '')
      .toLowerCase()
      .includes(String(value).toLowerCase());
  }, []);

  // Attach the multiselect filter fn to any column that opts into value filtering,
  // so callers only need to set `meta.filterVariant` (declarative, no filterFn wiring).
  const tableColumns = useMemo(
    () =>
      columns.map((col) =>
        col.meta?.filterVariant
          ? { ...col, enableColumnFilter: true, filterFn: multiSelectFilter as FilterFn<TData> }
          : col,
      ),
    [columns],
  );

  const [internalSorting, setInternalSorting] = useState<SortingState>(defaultSorting);
  const sorting = sortingProp ?? internalSorting;

  // Rows-per-page is remembered per table (client mode only -- in server mode the
  // parent owns the whole pagination object, including page size).
  const [savedPageSize, savePageSize] = usePersistentPageSize(storageKey, defaultPageSize);
  const [internalPagination, setInternalPagination] = useState<PaginationState>({
    pageIndex: 0,
    pageSize: defaultPageSize,
  });
  const pagination = paginationProp ?? internalPagination;

  // Adopt the stored page size once it has been read from localStorage (post-mount).
  useEffect(() => {
    if (paginationProp) return;
    setInternalPagination((prev) =>
      prev.pageSize === savedPageSize ? prev : { ...prev, pageIndex: 0, pageSize: savedPageSize },
    );
  }, [savedPageSize, paginationProp]);

  // Normalize react-table's value-or-updater callbacks down to a plain value so
  // both internal setState and the parent's (value) => void handlers work.
  const handleSortingChange: OnChangeFn<SortingState> = (updater) => {
    const next = typeof updater === 'function' ? updater(sorting) : updater;
    (onSortingChange ?? setInternalSorting)(next);
  };
  const handlePaginationChange: OnChangeFn<PaginationState> = (updater) => {
    const next = typeof updater === 'function' ? updater(pagination) : updater;
    // Persist a deliberate rows-per-page change so it survives the next visit.
    if (!onPaginationChange && next.pageSize !== pagination.pageSize) savePageSize(next.pageSize);
    (onPaginationChange ?? setInternalPagination)(next);
  };
  // autoResetPageIndex is disabled below so a background data refetch (e.g. after saving
  // a row edit) doesn't kick the user back to page 1. The trade-off is that we must reset
  // to the first page ourselves when a *filter* narrows the rows. Only for client-owned
  // pagination; when the parent controls pagination (server mode) it owns that coupling.
  const resetToFirstPage = () => {
    if (onPaginationChange) return;
    setInternalPagination((prev) => (prev.pageIndex === 0 ? prev : { ...prev, pageIndex: 0 }));
  };
  const handleGlobalFilterChange: OnChangeFn<string> = (updater) => {
    const next = typeof updater === 'function' ? updater(globalFilter) : updater;
    setGlobalFilter(next);
    resetToFirstPage();
  };
  const handleColumnFiltersChange: OnChangeFn<ColumnFiltersState> = (updater) => {
    const next = typeof updater === 'function' ? updater(columnFilters) : updater;
    setColumnFilters(next);
    resetToFirstPage();
  };

  const table = useReactTable<TData>({
    data,
    columns: tableColumns,
    // Use a stable row id (if provided on the data object) so pagination
    // and internal row caching won't mix rows between pages. Defaults to
    // index-based ids which can cause cells to show stale values when
    // navigating pages.
    // provide a stable id for each row; fall back to the index if no
    // identifier property is available. Previously we returned an empty
    // string when `id`/`_id` was missing which caused duplicate-key
    // warnings (see GradeBreakdownDialog). Using the index guarantees
    // uniqueness across the current page and avoids rendering errors.
    getRowId: (row: TData, index: number) => {
      const r = row as unknown as Record<string, unknown>;
      // prefer known id properties, otherwise use the row index
      return String(r.id ?? r._id ?? index);
    },
    state: {
      globalFilter,
      columnVisibility,
      sorting,
      pagination,
      columnFilters,
    },
    manualPagination,
    manualSorting,
    manualFiltering,
    // Keep the current page across data refetches (e.g. after saving a row edit); the
    // filter handlers above reset to page 1 when the visible rows change instead.
    autoResetPageIndex: false,
    pageCount: manualPagination ? (pageCount ?? -1) : undefined,
    rowCount: manualPagination ? rowCount : undefined,
    globalFilterFn: scopedGlobalFilter,
    onGlobalFilterChange: handleGlobalFilterChange,
    onColumnVisibilityChange: setColumnVisibility,
    onColumnFiltersChange: handleColumnFiltersChange,
    onSortingChange: handleSortingChange,
    onPaginationChange: handlePaginationChange,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: manualSorting ? undefined : getSortedRowModel(),
    getFilteredRowModel: manualFiltering ? undefined : getFilteredRowModel(),
    getPaginationRowModel: manualPagination ? undefined : getPaginationRowModel(),
    // Faceted models power the value-filter option lists + counts (client mode only).
    getFacetedRowModel: manualFiltering ? undefined : getFacetedRowModel(),
    getFacetedUniqueValues: manualFiltering ? undefined : getFacetedUniqueValues(),
  });

  /**
   * Nobody is left on a page that no longer exists.
   *
   * With `autoResetPageIndex` off, a shrinking row set (a delete, a filter, a log prune) can
   * strand somebody past the end, where the table looks empty and the data looks lost. The
   * pull-back belongs here rather than in each screen: server-paginated tables are the ones
   * most likely to shrink under somebody, and there are six of them, so leaving it to the
   * parents means six chances to forget and two implementations to keep in step.
   *
   * The page count comes from whoever owns it: react-table for a client table, the `pageCount`
   * prop for a server one. A server table that has not said yet (`undefined`, or the `-1`
   * react-table uses for "unknown") is left alone, since a page cannot be judged too high
   * against a total nobody has stated.
   */
  const knownPageCount = manualPagination
    ? typeof pageCount === 'number' && pageCount >= 0
      ? pageCount
      : null
    : table.getPageCount();

  useEffect(() => {
    if (knownPageCount === null) return;
    const lastPage = Math.max(0, knownPageCount - 1);
    if (pagination.pageIndex <= lastPage || pagination.pageIndex === 0) return;

    const next = { ...pagination, pageIndex: lastPage };
    // Controlled tables are told; uncontrolled ones move themselves.
    if (onPaginationChange) onPaginationChange(next);
    else setInternalPagination(next);
    // `pagination` is read whole here, so the effect must not re-run on its identity alone.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [knownPageCount, pagination.pageIndex, pagination.pageSize, onPaginationChange]);

  const exportToCSV = () => {
    // Pre-pagination on purpose: getRowModel() is the *current page*, so this used to
    // write a 10-row CSV out of a 200-row filtered result with nothing telling the user.
    // Search/filters/sort still apply -- you get exactly what the table is showing you,
    // just all of it rather than the slice on screen. (In server mode the client only
    // holds one page, which is why those tables pass showExportButton={false}.)
    const rows = table.getPrePaginationRowModel().rows;
    if (!rows.length) return;

    const visibleColumns = table.getAllLeafColumns().filter((col) => col.id !== 'actions');
    downloadCsv(buildTableCsv(rows, visibleColumns), 'table_export.csv');
  };

  // Value-filter and search-scope only make sense client-side (server mode owns
  // filtering and doesn't have every value on hand).
  const leafColumns = table.getAllLeafColumns();
  const filterableColumns = manualFiltering
    ? []
    : leafColumns.filter((col) => col.columnDef.meta?.filterVariant);
  const searchableColumns = manualFiltering
    ? []
    : leafColumns.filter(
        (col) =>
          col.getCanGlobalFilter() &&
          col.id !== 'actions' &&
          typeof col.columnDef.header === 'string',
      );
  // Scope dropdown options: explicit (server mode) or derived from the columns (client),
  // with an "All columns" default prepended in the derived case.
  const scopeOptions =
    searchScopeOptions ??
    (searchableColumns.length > 0
      ? [
          { value: 'all', label: 'All columns' },
          ...searchableColumns.map((col) => ({ value: col.id, label: columnLabel(col) })),
        ]
      : []);
  const activeFilterCount = columnFilters.length;

  const stacked = useStackedView();

  /*
   * The controls that drive the table, drawn ON the table rather than above it.
   *
   * They used to float on the page background: outside the shell, outside its border, with
   * nothing tying Search and Filters to the rows they filter. That was invisible while every
   * table sat inside a white card, and became obvious once the shell started painting its own
   * surface, because the toolbar was then the one part of the table showing the page through
   * itself. Every table that sits inside a settings or status panel already passes
   * `showToolbar={false}`, so nothing gains a second header band from this.
   *
   * The band is the table's own surface with a rule under it, NOT `bg-muted`: --table-header
   * and --muted are the same value in all three themes, so a muted toolbar directly above the
   * muted header row read as one grey block split by a hairline.
   */
  const toolbar = showToolbar ? (
    <div className="border-b p-3">
      <DataTableToolbar
        table={table}
        globalFilter={globalFilter}
        setGlobalFilter={setGlobalFilter}
        searchScope={searchScope}
        setSearchScope={setSearchScope}
        scopeOptions={scopeOptions}
        filterableColumns={filterableColumns}
        activeFilterCount={activeFilterCount}
        actionButtons={actionButtons}
        showExportButton={showExportButton}
        onExport={exportToCSV}
        onResetColumns={resetColumns}
        getColumnLabel={columnLabel}
      />
    </div>
  ) : null;

  return (
    <div className="space-y-4">
      {stacked ? (
        <div className="space-y-3">
          {/* Stacked, there is no single shell to sit on: the cards are separate objects. The
              toolbar takes the same box the pagination strip below them takes, so the two
              controls that bracket the list match each other. */}
          {showToolbar ? (
            <div className="overflow-hidden rounded-md border bg-[var(--table-background)] p-3">
              <DataTableToolbar
                table={table}
                globalFilter={globalFilter}
                setGlobalFilter={setGlobalFilter}
                searchScope={searchScope}
                setSearchScope={setSearchScope}
                scopeOptions={scopeOptions}
                filterableColumns={filterableColumns}
                activeFilterCount={activeFilterCount}
                actionButtons={actionButtons}
                showExportButton={showExportButton}
                onExport={exportToCSV}
                onResetColumns={resetColumns}
                getColumnLabel={columnLabel}
              />
            </div>
          ) : null}
          <DataTableCards
            table={table}
            loading={loading}
            tableLabel={tableLabel}
            getColumnLabel={columnLabel}
            emptyTitle={emptyTitle}
            emptyDescription={emptyDescription}
            emptyIcon={EmptyIcon}
            loadingMessage={loadingMessage}
            emptyAction={emptyAction}
          />
          {/* Same reason as the table shell below: the card view's pagination strip was
              transparent, so it took the page's colour instead of the table's. */}
          <div className="rounded-md border bg-[var(--table-background)] p-3">
            <PaginationControls
              table={table}
              rowCount={rowCount}
              manualPagination={manualPagination}
              showFirstLastPage={showFirstLastPage}
            />
          </div>
        </div>
      ) : (
        /* Single scroll container: the Table primitive already wraps the table in an
           overflow-x-auto div, so this wrapper only frames it (a second overflow-x-auto
           here produced a doubled/flaky horizontal scrollbar). overflow-hidden keeps the
           rounded corners clipping the scrolling content.

           The surface belongs to the shell, not only to the rows. It used to be painted
           per row, which looks right until a table has no rows: an empty state, the
           loading state and the pagination strip were all transparent, so on any page whose
           background is not the card colour the table showed the page through itself. That
           went unnoticed while every table sat inside a white card. `--table-background`
           is the card colour in all three themes, so this is invisible where that is still
           true and is the fix everywhere else. */
        <div className="overflow-hidden rounded-md border bg-[var(--table-background)]">
          {toolbar}
          <Table
            // `bordered` adds gridlines: a right border on every cell except the last
            // column (vertical lines) plus a bottom border on body rows (horizontal
            // lines). Scoped to this table so other DataTables keep their borderless look.
            className={`w-full ${
              bordered
                ? '[&_td]:border-border [&_th]:border-border [&_tbody_tr]:border-b [&_td:not(:last-child)]:border-r [&_th:not(:last-child)]:border-r'
                : ''
            }`}
            role="table"
            aria-label={tableLabel}
            aria-busy={loading}
          >
            {/* stickyHeader needs the row itself to carry the background (the header cells
                are transparent), which it already does via the inline style below. */}
            <TableHeader role="rowgroup" className={stickyHeader ? 'sticky top-0 z-10' : undefined}>
              {table.getHeaderGroups().map((headerGroup) => (
                <TableRow
                  key={headerGroup.id}
                  className={loading ? 'hover:bg-transparent' : undefined}
                  style={{
                    backgroundColor: 'var(--table-header)',
                    color: 'var(--table-header-foreground)',
                  }}
                >
                  {headerGroup.headers.map((header) => {
                    const sorted = header.column.getIsSorted();
                    const canSort = header.column.getCanSort();
                    const priority = header.column.columnDef.meta?.priority;

                    const handleSortClick = () => {
                      if (!canSort) return;

                      const currentSort = sorting.find((s) => s.id === header.column.id);

                      if (!currentSort) {
                        handleSortingChange([{ id: header.column.id, desc: false }]);
                      } else if (!currentSort.desc) {
                        handleSortingChange([{ id: header.column.id, desc: true }]);
                      } else {
                        handleSortingChange([{ id: header.column.id, desc: false }]);
                      }
                    };

                    const align = header.column.columnDef.meta?.align;
                    const flexClass = alignFlexClass(align);

                    return (
                      <TableHead
                        key={header.id}
                        aria-sort={ariaSort(canSort, sorted)}
                        className={`${responsiveClass(priority)} h-12 font-semibold whitespace-nowrap ${alignTextClass(align)}`}
                      >
                        {header.isPlaceholder ? null : canSort ? (
                          <button
                            type="button"
                            onClick={handleSortClick}
                            className={`group/sort flex w-full cursor-pointer items-center select-none ${flexClass || 'text-left'}`}
                            /*
                             * When the header renders plain text, that text IS the button's
                             * accessible name -- an aria-label here would override it, and
                             * columnLabel() prefers meta.filterLabel, so a column showing
                             * "Instructor" with filterLabel "Owner" would be announced (and
                             * addressed by voice control) as something the user can't see.
                             * WCAG 2.5.3. Only fall back to a synthesized label when the
                             * header is custom JSX that may carry no text at all. The
                             * current sort direction comes from aria-sort on the cell.
                             */
                            aria-label={
                              typeof header.column.columnDef.header === 'string'
                                ? undefined
                                : `Sort by ${columnLabel(header.column).toLowerCase()}`
                            }
                          >
                            {flexRender(header.column.columnDef.header, header.getContext())}
                            {sorted === 'asc' && <ArrowUp className="ml-1 h-3 w-3" aria-hidden />}
                            {sorted === 'desc' && (
                              <ArrowDown className="ml-1 h-3 w-3" aria-hidden />
                            )}
                            {/* Only while pointing at or focused on the header. Twelve
                                permanent double-arrows made every column look sorted and
                                none of them look sorted. aria-sort on the cell is what
                                actually reports the state. */}
                            {!sorted && (
                              <ArrowUpDown
                                className="ml-1 h-3 w-3 opacity-0 transition-opacity group-hover/sort:opacity-40 group-focus-visible/sort:opacity-40"
                                aria-hidden
                              />
                            )}
                          </button>
                        ) : (
                          <div className={`flex items-center ${flexClass}`}>
                            {flexRender(header.column.columnDef.header, header.getContext())}
                          </div>
                        )}
                      </TableHead>
                    );
                  })}
                </TableRow>
              ))}
            </TableHeader>

            <TableBody>
              {loading ? (
                <TableRow className="pointer-events-none hover:bg-transparent">
                  <TableCell colSpan={columns.length} className="py-10 text-center">
                    <DataTableLoading message={loadingMessage} />
                  </TableCell>
                </TableRow>
              ) : table.getRowModel().rows.length ? (
                table.getRowModel().rows.map((row) => (
                  <TableRow
                    key={row.id}
                    className="bg-[var(--table-background)] hover:bg-[var(--table-highlight)]"
                  >
                    {/* No forced nowrap on cells: on narrow screens long values
                        (emails, titles) wrap inside their cell instead of
                        stretching the whole table into a sideways scroll. */}
                    {row.getVisibleCells().map((cell) => {
                      const isRowHeader = cell.column.columnDef.meta?.rowHeader;
                      return (
                        <TableCell
                          key={cell.id}
                          as={isRowHeader ? 'th' : undefined}
                          scope={isRowHeader ? 'row' : undefined}
                          nowrap={cell.column.columnDef.meta?.nowrap}
                          className={`${responsiveClass(cell.column.columnDef.meta?.priority)} ${alignTextClass(cell.column.columnDef.meta?.align)}`}
                        >
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </TableCell>
                      );
                    })}
                  </TableRow>
                ))
              ) : (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={columns.length} className="py-8 text-center">
                    <DataTableEmptyState
                      icon={EmptyIcon}
                      title={emptyTitle}
                      description={emptyDescription}
                      action={emptyAction}
                    />
                  </TableCell>
                </TableRow>
              )}
            </TableBody>

            <DataTablePagination
              table={table}
              rowCount={rowCount}
              manualPagination={manualPagination}
              loading={loading}
              colSpan={columns.length}
              showFirstLastPage={showFirstLastPage}
            />
          </Table>
        </div>
      )}
    </div>
  );
}
