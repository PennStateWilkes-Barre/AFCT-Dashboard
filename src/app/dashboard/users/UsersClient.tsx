'use client';

import React from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import type { OnChangeFn, PaginationState, SortingState } from '@tanstack/react-table';
import { getUserColumns } from './user-columns';
import { DataTable } from '@/components/ui/data-table';
import { DataTableFilterMenu } from '@/components/ui/data-table-faceted-filter';
import { Button } from '@/components/ui/button';
import { WorkspaceSurface } from '@/components/WorkspaceSurface';
import dynamic from 'next/dynamic';
// On demand: both carry the form stack and neither is open on arrival.
const CreateUserDialog = dynamic(
  () => import('@/components/dialogs/CreateUserDialog').then((m) => m.CreateUserDialog),
  { ssr: false },
);
const ImportUsersDialog = dynamic(
  () => import('@/components/dialogs/ImportUsersDialog').then((m) => m.ImportUsersDialog),
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
import { UserRoundPlus, Users } from 'lucide-react';
import { useEffectiveTimezone } from '@/hooks/use-effective-timezone';
import { apiPaths } from '@/lib/api-paths';
import type { UserListItem } from '@/lib/users-list';
import { PAGE_HEADER_ICON_CLASS } from '@/lib/page-header';
import { queryKeys } from '@/lib/query-keys';

const DEFAULT_PAGE_SIZE = 10;

// Search scope (server-side): restrict the text search to one field.
const SEARCH_FIELDS = [
  { value: 'all', label: 'All fields' },
  { value: 'firstName', label: 'First Name' },
  { value: 'lastName', label: 'Last Name' },
  { value: 'email', label: 'Email' },
];

export default function UsersClient() {
  const searchParams = useSearchParams();
  const router = useRouter();

  const [open, setOpen] = useState(searchParams.get('create') === 'open');
  const [importOpen, setImportOpen] = useState(false);
  const createMounted = useMountedOnce(open);
  const importMounted = useMountedOnce(importOpen);
  const { timezone, hour12 } = useEffectiveTimezone();

  const [pageIndex, setPageIndex] = useState(0);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);

  // searchInput is what the user is typing; search is the committed (debounced) query.
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [searchField, setSearchField] = useState('all');

  // Multi-select filters (server-side). Values match the API's query tokens.
  const [admin, setAdmin] = useState<string[]>([]);
  // Default to active-only; inactive accounts are hidden until an admin clears or
  // changes the Status filter.
  const [status, setStatus] = useState<string[]>(['active']);
  const [lock, setLock] = useState<string[]>([]);
  const [temp, setTemp] = useState<string[]>([]);

  const [sorting, setSorting] = useState<SortingState>([{ id: 'lastName', desc: false }]);

  // Debounce typing, and jump back to the first page when the query changes.
  useEffect(() => {
    const t = setTimeout(() => {
      setSearch(searchInput.trim());
      setPageIndex(0);
    }, 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  const sort = sorting[0];
  const queryParams = {
    page: pageIndex + 1,
    pageSize,
    q: search || undefined,
    field: searchField !== 'all' ? searchField : undefined,
    admin,
    status,
    lock,
    temp,
    sortBy: sort?.id,
    sortDir: sort ? (sort.desc ? 'desc' : 'asc') : undefined,
  };

  const {
    data,
    isLoading,
    isError,
    refetch,
  } = useQuery({
    queryKey: queryKeys.admin.usersPage(queryParams),
    queryFn: async () => {
      const params = new URLSearchParams({
        page: String(queryParams.page),
        pageSize: String(queryParams.pageSize),
      });
      if (queryParams.q) params.set('q', queryParams.q);
      if (queryParams.field) params.set('field', queryParams.field);
      queryParams.admin.forEach((v) => params.append('admin', v));
      queryParams.status.forEach((v) => params.append('status', v));
      queryParams.lock.forEach((v) => params.append('lock', v));
      queryParams.temp.forEach((v) => params.append('temp', v));
      if (queryParams.sortBy) params.set('sortBy', queryParams.sortBy);
      if (queryParams.sortDir) params.set('sortDir', queryParams.sortDir);

      const res = await fetch(`${apiPaths.admin.usersList()}?${params.toString()}`, {
        cache: 'no-store',
      });
      if (!res.ok) throw new Error('Failed to fetch users');
      return (await res.json()) as { rows: UserListItem[]; total: number };
    },
    placeholderData: keepPreviousData,
  });

  const users = data?.rows ?? [];
  const total = data?.total ?? 0;

  // Stable refresh passed to the table + dialogs (a mutation reloads the current page).
  const refresh = useCallback(() => {
    void refetch();
  }, [refetch]);

  const columns = useMemo(
    () => getUserColumns(refresh, timezone, hour12),
    [refresh, timezone, hour12],
  );

  const handlePaginationChange: OnChangeFn<PaginationState> = (updater) => {
    const next = typeof updater === 'function' ? updater({ pageIndex, pageSize }) : updater;
    setPageIndex(next.pageIndex);
    setPageSize(next.pageSize);
  };

  // Sorting is server-side; changing it resets to the first page.
  const handleSortingChange: OnChangeFn<SortingState> = (updater) => {
    const next = typeof updater === 'function' ? updater(sorting) : updater;
    setSorting(next);
    setPageIndex(0);
  };

  // A filter change resets to the first page (the result set shifts under you).
  const onFilter = (setter: (v: string[]) => void) => (v: string[]) => {
    setter(v);
    setPageIndex(0);
  };

  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  const handleDialogClose = (value: boolean) => {
    setOpen(value);
    if (!value) {
      const params = new URLSearchParams(searchParams.toString());
      params.delete('create');
      router.replace(`?${params.toString()}`, { scroll: false });
    }
  };

  return (
    // Same shape as the Courses page: a work page on the white surface, no outer card
    // around a table that already has a border, and a real <h1> in place of the CardTitle
    // that was carrying role="heading" aria-level={1}.
    <WorkspaceSurface>
      <section className="space-y-6" aria-labelledby="users-title">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <h1
            id="users-title"
            className="flex items-center gap-3 text-2xl font-semibold tracking-tight"
          >
            {/* Decorative: the heading beside it already says what this is. The icon the
                sidebar already uses for this page, in the title’s own ink, no tile
                (see PAGE_HEADER_ICON_CLASS). */}
            <Users className={PAGE_HEADER_ICON_CLASS} aria-hidden="true" />
            <span>User Accounts</span>
          </h1>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" onClick={() => setImportOpen(true)}>
              <Users />
              Import Users
            </Button>
            <Button onClick={() => setOpen(true)}>
              <UserRoundPlus />
              Create User
            </Button>
          </div>
        </div>

        {isError ? (
          <div className="border-status-danger-border bg-status-danger-bg flex items-center justify-between gap-3 rounded-md border px-3 py-2">
            <p role="alert" className="text-status-danger text-sm">
              Failed to load users. Please try again.
            </p>
            <Button variant="outline" size="sm" onClick={refresh}>
              Retry
            </Button>
          </div>
        ) : null}

          <DataTable
            columns={columns}
            data={users}
            loading={isLoading}
            tableLabel="Users table"
            showExportButton={false}
            emptyTitle="No user accounts"
            emptyDescription="Create or import users to get started."
            emptyIcon={Users}
            loadingMessage="Loading user accounts, please wait..."
            defaultColumnVisibility={{ isAdmin: false, lockStatus: false }}
            actionButtons={
              <DataTableFilterMenu
                groups={[
                  {
                    key: 'admin',
                    label: 'Admin',
                    options: [
                      { label: 'Admin', value: 'true' },
                      { label: 'Standard', value: 'false' },
                    ],
                    selected: admin,
                    onChange: onFilter(setAdmin),
                  },
                  {
                    key: 'status',
                    label: 'Status',
                    options: [
                      { label: 'Active', value: 'active' },
                      { label: 'Inactive', value: 'inactive' },
                    ],
                    selected: status,
                    onChange: onFilter(setStatus),
                  },
                  {
                    key: 'lock',
                    label: 'Lock',
                    options: [
                      { label: 'Locked', value: 'locked' },
                      { label: 'Not locked', value: 'unlocked' },
                    ],
                    selected: lock,
                    onChange: onFilter(setLock),
                  },
                  {
                    key: 'temp',
                    label: 'Password Status',
                    options: [
                      { label: 'Temporary', value: 'true' },
                      { label: 'Normal', value: 'false' },
                    ],
                    selected: temp,
                    onChange: onFilter(setTemp),
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
          />

        {createMounted && (
          <CreateUserDialog open={open} setOpen={handleDialogClose} onSuccess={refresh} />
        )}
        {importMounted && (
          <ImportUsersDialog open={importOpen} setOpen={setImportOpen} onSuccess={refresh} />
        )}
      </section>
    </WorkspaceSurface>
  );
}
