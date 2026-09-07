'use client';

import React, { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchJson } from '@/lib/query-fetch';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent } from '@/components/ui/tabs';
import { TabBar, TabRail } from '@/components/course/course-tabs';
import { LocalNavLayout } from '@/components/local-nav';
import { useIsDesktopNav } from '@/hooks/use-desktop-nav';
import {
  Activity,
  Server,
  Database,
  Container,
  Network,
  Users,
  HardDrive,
  ShieldAlert,
  Cpu,
} from 'lucide-react';
import { apiPaths } from '@/lib/api-paths';
import { queryKeys } from '@/lib/query-keys';
import { useEffectiveTimezone } from '@/hooks/use-effective-timezone';
import { formatTimeInTimeZone } from '@/lib/date-format';
import type { SummaryStatus } from '@/lib/status/types';
import { hostNotices } from './host-notices';
import { Skel, TrendBadge, type Polarity } from './status-ui';
import { formatUptime, formatDbSize, latencyTone } from './status-format';
import { useTrends, type HistoryPoint } from './use-trends';
import ServerTab from './tabs/ServerTab';
import DatabaseTab from './tabs/DatabaseTab';
import DockerTab from './tabs/DockerTab';
import NetworkTab from './tabs/NetworkTab';
import SessionsTab from './tabs/SessionsTab';
import FilesTab from './tabs/FilesTab';
import RateLimitsTab from './tabs/RateLimitsTab';
import WorkersTab from './tabs/WorkersTab';
import { PAGE_HEADER_ICON_CLASS } from '@/lib/page-header';

const TABS = [
  { value: 'server', label: 'Server', icon: Server },
  { value: 'database', label: 'Database', icon: Database },
  { value: 'docker', label: 'Docker', icon: Container },
  { value: 'network', label: 'Network', icon: Network },
  { value: 'sessions', label: 'Session', icon: Users },
  { value: 'files', label: 'Files', icon: HardDrive },
  { value: 'rate-limits', label: 'Rate Limits', icon: ShieldAlert },
  { value: 'workers', label: 'Workers', icon: Cpu },
] as const;

export default function SystemStatusClient() {
  const { timezone, hour12 } = useEffectiveTimezone();
  const queryClient = useQueryClient();
  const [autoRefresh, setAutoRefresh] = useState(false);
  // Persist the open tab so a refresh keeps you where you were (SSR-safe init).
  const [tab, setTabState] = useState<string>(() => {
    if (typeof window === 'undefined') return 'server';
    const saved = window.localStorage.getItem('afct.systemStatusTab');
    return saved && TABS.some((t) => t.value === saved) ? saved : 'server';
  });
  const setTab = (v: string) => {
    setTabState(v);
    try {
      window.localStorage.setItem('afct.systemStatusTab', v);
    } catch {
      /* ignore disabled storage */
    }
  };

  // Fast top-card summary, always loaded; the per-tab detail is fetched lazily.
  const {
    data: summary,
    isFetching,
    dataUpdatedAt,
  } = useQuery({
    queryKey: queryKeys.admin.statusSummary(),
    queryFn: () => fetchJson<SummaryStatus>(apiPaths.admin.statusSummary()),
    refetchInterval: autoRefresh ? 15_000 : false,
    staleTime: 15_000,
  });

  const sample: HistoryPoint | null = useMemo(
    () =>
      summary
        ? {
            ts: Date.now(),
            cpuPct: summary.procCpuPct,
            memPct: summary.procMemPct,
            dbSizeMB: summary.dbSizeBytes
              ? Math.round(summary.dbSizeBytes / 1024 / 1024)
              : undefined,
            dbTables: summary.dbTables,
            sessions24h: summary.sessions24h,
            latencyMs: summary.latencyMs,
          }
        : null,
    [summary],
  );
  const { windowHours, setHours, trends } = useTrends(sample);

  const dbOk = summary?.db.ok ?? false;
  // Only the things worth acting on: a pending restart, waiting security updates, a clock
  // that has drifted. Nothing appears when AFCT has no report, since it cannot say either way.
  const hostWarnings = summary?.host
    ? hostNotices(summary.host).filter((n) => n.tone === 'warn').length
    : 0;
  const provider = summary?.db.provider ?? 'unknown';
  const lastUpdated = dataUpdatedAt ? new Date(dataUpdatedAt) : null;

  // `polarity` is what makes the trend arrows mean anything: only three of these readings
  // have a direction that is actually better, and painting the rest green or red was reading
  // a busier day as an improvement and a growing database as a fault.
  const tiles: { label: string; value: string; delta: number; polarity?: Polarity }[] = useMemo(
    () => [
      { label: 'Uptime', value: formatUptime(summary?.uptime), delta: 0 },
      {
        label: 'Proc CPU',
        value: `${Math.round(summary?.procCpuPct ?? 0)}%`,
        delta: trends.cpu,
        polarity: 'up-bad',
      },
      {
        label: 'Proc Mem',
        value: `${(summary?.procMemPct ?? 0).toFixed(1)}%`,
        delta: trends.mem,
        polarity: 'up-bad',
      },
      {
        label: 'DB Tables',
        value: summary?.dbTables == null ? '—' : String(summary.dbTables),
        delta: trends.dbTables,
      },
      { label: 'DB Size', value: formatDbSize(summary?.dbSizeBytes), delta: trends.dbSize },
      { label: 'Sessions (24h)', value: String(summary?.sessions24h ?? 0), delta: trends.sessions },
      { label: 'Unique Users', value: String(summary?.uniqueUsers24h ?? 0), delta: 0 },
      {
        label: 'Latency (ms)',
        value: String(summary?.latencyMs ?? '—'),
        delta: trends.latency,
        polarity: 'up-bad',
      },
    ],
    [summary, trends],
  );

  const statusTabs = TABS.map((t) => ({ value: t.value, label: t.label, Icon: t.icon }));

  // xl rather than lg: metric grids and charts beside a rail need the room.
  const railNav = useIsDesktopNav(1280);

  // Refresh both the summary and whichever tab is currently open.
  const refreshAll = () => queryClient.invalidateQueries({ queryKey: queryKeys.admin.status() });

  return (
    <Tabs
      value={tab}
      onValueChange={setTab}
      orientation={railNav ? 'vertical' : 'horizontal'}
      className="space-y-4"
    >
      {/* Heading, health badges, refresh controls and the metric tiles all sit on the
          workspace itself: the page-sized card put a dashboard inside a card. */}
      {/* Stacked until lg. The left side can carry the heading plus four badges and the right
          side four controls, so at sm they met in the middle and both wrapped; there is only
          room for one row once the workspace is a laptop wide. */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="flex items-center gap-3 text-2xl font-semibold tracking-tight">
            {/* Decorative: the heading beside it already says what this is. Activity, the
                icon the sidebar uses for this route, in the title’s own ink and
                no tile behind it (see PAGE_HEADER_ICON_CLASS). */}
            <Activity className={PAGE_HEADER_ICON_CLASS} aria-hidden="true" />
            <span>System Status</span>
          </h1>
          <Badge variant={dbOk ? 'success' : 'danger'} title={summary?.db.message || ''}>
            DB {dbOk ? 'OK' : 'DOWN'}
            {summary?.db.message ? <span className="sr-only"> ({summary.db.message})</span> : null}
          </Badge>
          <Badge variant="info" title="Database provider">
            <span className="sr-only">Database provider: </span>
            {provider.toUpperCase()}
          </Badge>
          {hostWarnings > 0 && (
            <Badge variant="warning" title="The server itself needs attention. See the Server tab.">
              Server needs attention
            </Badge>
          )}
          {typeof summary?.latencyMs === 'number' && (
            <Badge variant={latencyTone(summary.latencyMs)} title="Summary latency">
              <span className="sr-only">Summary latency: </span>
              {summary.latencyMs} ms
            </Badge>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            {/* The visible words are the label, so the accessible name starts with them.
                It was an aria-label of "Enable automatic refresh every 15 seconds" beside
                a visible "Auto-refresh", which WCAG 2.5.3 (Label in Name) fails: speech
                input users say what they can see, and that name did not contain it. The
                interval is still announced, from a hidden span inside the same label. */}
            <label htmlFor="auto-refresh" className="cursor-pointer text-sm">
              Auto-refresh
              <span className="sr-only"> every 15 seconds</span>
            </label>
            <Switch id="auto-refresh" checked={autoRefresh} onCheckedChange={setAutoRefresh} />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-sm">Trend window</span>
            <select
              aria-label="Select trend window"
              // Same tokens as every other control: rounded-md, the field border, the
              // subtle elevation and the shared focus ring. This one had drifted to a bare
              // bordered box with no focus treatment at all.
              className="bg-card border-input focus-visible:border-ring focus-visible:ring-ring/70 h-9 rounded-md border px-2 text-sm shadow-xs transition-[color,box-shadow] outline-none focus-visible:ring-[3px]"
              value={windowHours}
              onChange={(e) => setHours(Number(e.target.value))}
            >
              <option value={1}>1h</option>
              <option value={6}>6h</option>
              <option value={24}>24h</option>
            </select>
          </div>
          <div className="text-muted-foreground text-xs" aria-live="polite">
            {lastUpdated ? `Updated ${formatTimeInTimeZone(lastUpdated, timezone, hour12)}` : ''}
          </div>
          <Button size="sm" onClick={refreshAll} disabled={isFetching}>
            {isFetching ? 'Refreshing…' : 'Refresh'}
          </Button>
        </div>
      </div>

      {/* Eight across only from 2xl. A tile has to hold a value and its trend badge side by
          side, and what it gets is the viewport minus the sidebar, the status rail and the
          workspace gutters: at 1280 with the sidebar open that is about 90px per tile across
          eight, which is where the values wrapped. Four across is the desktop layout. */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 2xl:grid-cols-8">
        {tiles.map((t) => (
          <div key={t.label} className="bg-card rounded-lg border p-3">
            <div className="text-muted-foreground text-xs">{t.label}</div>
            <div className="mt-1 flex h-7 items-center text-lg font-semibold">
              {!summary ? (
                <Skel w="w-16" />
              ) : (
                <>
                  {t.value}
                  <TrendBadge delta={t.delta} polarity={t.polarity} />
                </>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Eight sections is too many for a strip, so above xl they become a rail beside the
          panels. Below that the strip and its select stay as they were. One control at a
          time: two tablists under one Tabs root would duplicate its ARIA wiring. */}
      {/* No contentClassName, unlike System Settings: this page is metric grids, charts
          and tables, all of which want the room. */}
      <LocalNavLayout
        className="space-y-4"
        nav={
          railNav ? (
            <TabRail tabs={statusTabs} ariaLabel="System status sections" menuLabel="Status Menu" />
          ) : (
            <TabBar
              ariaLabel="System status sections"
              selectId="system-status-tab-select"
              value={tab}
              onValueChange={setTab}
              tabs={statusTabs}
            />
          )
        }
      >
        <TabsContent value="server">
          <ServerTab
            active={tab === 'server'}
            autoRefresh={autoRefresh}
            windowHours={windowHours}
          />
        </TabsContent>
        <TabsContent value="database">
          <DatabaseTab active={tab === 'database'} autoRefresh={autoRefresh} />
        </TabsContent>
        <TabsContent value="docker">
          <DockerTab active={tab === 'docker'} autoRefresh={autoRefresh} />
        </TabsContent>
        <TabsContent value="network">
          <NetworkTab active={tab === 'network'} autoRefresh={autoRefresh} />
        </TabsContent>
        <TabsContent value="sessions">
          <SessionsTab active={tab === 'sessions'} autoRefresh={autoRefresh} />
        </TabsContent>
        <TabsContent value="files">
          <FilesTab active={tab === 'files'} autoRefresh={autoRefresh} />
        </TabsContent>
        <TabsContent value="rate-limits">
          <RateLimitsTab active={tab === 'rate-limits'} autoRefresh={autoRefresh} />
        </TabsContent>
        <TabsContent value="workers">
          <WorkersTab active={tab === 'workers'} autoRefresh={autoRefresh} />
        </TabsContent>
      </LocalNavLayout>
    </Tabs>
  );
}
