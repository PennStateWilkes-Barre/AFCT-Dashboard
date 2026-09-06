'use client';

import { useEffect, useId, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import SelectField from '@/components/ui/SelectField';
import { SettingsSection } from '@/components/settings/settings-layout';
import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog';
import { showToast } from '@/lib/toast';
import { apiClient, ApiError } from '@/lib/api/fetch-client';
import { apiPaths } from '@/lib/api-paths';
import type { GroupSetSummaryDTO } from '@/lib/group-set-service';
import { queryKeys } from '@/lib/query-keys';

const TYPE_OPTIONS = [
  {
    group: false,
    label: 'Individual',
    desc: 'Each student submits and is graded on their own.',
  },
  {
    group: true,
    label: 'Group',
    desc: 'Students submit and are graded together as a group. A faculty member or TA can override an individual member’s grade.',
  },
] as const;

/**
 * The assignment's Type tab: individual vs group, mirroring the create wizard's Type step.
 * The type can be changed here, but switching resets the audience to everyone and clears
 * every assignee + date override (they reference the old type's targets), so a change is
 * gated behind a confirmation and applied server-side in one transaction.
 *
 * The tab's own heading belongs to the view, the way Details' does; this renders the panel
 * under it. The button still says "Change type" rather than Save: it opens a confirmation
 * and throws away work, which is not what Save means anywhere else on this page.
 */
export function AssignmentTypeCard({
  courseId,
  assignmentId,
  groupSetId,
  courseIsArchived,
  onChanged,
}: {
  courseId: string;
  assignmentId: string;
  groupSetId: string | null;
  courseIsArchived: boolean;
  onChanged?: () => void;
}) {
  const fieldPrefix = useId();
  const currentIsGroup = groupSetId != null;
  const [isGroup, setIsGroup] = useState(currentIsGroup);
  const [selectedSetId, setSelectedSetId] = useState<string | null>(groupSetId);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  // Re-sync the staged selection to the saved type (e.g. after a successful change refetch).
  useEffect(() => {
    setIsGroup(groupSetId != null);
    setSelectedSetId(groupSetId);
  }, [groupSetId]);

  const groupSetsQuery = useQuery({
    queryKey: queryKeys.course.groupSets(courseId),
    queryFn: () => apiClient.get<GroupSetSummaryDTO[]>(apiPaths.courseGroupSets(courseId)),
    staleTime: 30_000,
  });
  const groupSets = groupSetsQuery.data ?? [];

  const dirty = isGroup !== currentIsGroup || (isGroup && (selectedSetId ?? null) !== groupSetId);
  const canSave = dirty && (!isGroup || !!selectedSetId) && !courseIsArchived && !saving;

  const applyChange = async () => {
    setSaving(true);
    try {
      await apiClient.put(apiPaths.assignmentType(courseId, assignmentId), {
        groupSetId: isGroup ? selectedSetId : null,
      });
      showToast.updated('Assignment type');
      onChanged?.();
    } catch (err) {
      showToast.error(
        err instanceof ApiError
          ? err.message
          : 'Could not change the assignment type. Check your connection and try again.',
      );
    } finally {
      setSaving(false);
      setConfirmOpen(false);
    }
  };

  return (
    <div className="space-y-5">
      <SettingsSection
        title="How students work"
        description="Whether students work individually or together as a group. Changing the type resets who the assignment is assigned to and clears any date exceptions."
        headingLevel={3}
      >
        <fieldset className="grid gap-3 sm:grid-cols-2" aria-label="Assignment type">
          {TYPE_OPTIONS.map((opt) => {
            const checked = isGroup === opt.group;
            return (
              <label
                key={opt.label}
                className={`flex cursor-pointer gap-3 rounded-lg border p-4 transition ${
                  checked ? 'border-primary bg-primary/5 ring-primary/30 ring-1' : 'hover:bg-muted'
                } ${courseIsArchived ? 'cursor-not-allowed opacity-50' : ''}`}
              >
                <input
                  type="radio"
                  name={`${fieldPrefix}-type`}
                  className="accent-primary mt-1"
                  checked={checked}
                  disabled={courseIsArchived}
                  onChange={() => {
                    setIsGroup(opt.group);
                    // Default the set picker to the current set when switching back to group.
                    if (opt.group && !selectedSetId) setSelectedSetId(groupSetId);
                  }}
                />
                <span>
                  <span className="block text-sm font-medium">{opt.label}</span>
                  <span className="text-muted-foreground block text-xs">{opt.desc}</span>
                </span>
              </label>
            );
          })}
        </fieldset>

        {isGroup ? (
          <div className="max-w-md">
            {groupSetsQuery.isPending ? (
              <p className="text-muted-foreground text-sm">Loading group sets…</p>
            ) : groupSets.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                This course has no group sets yet. Create one on the course&apos;s Groups tab first.
              </p>
            ) : (
              <SelectField
                label="Group set"
                name="groupSetId"
                placeholder="Choose a group set"
                description="Students submit and are graded as their group in the chosen set."
                value={selectedSetId ?? undefined}
                onValueChange={(v) => setSelectedSetId(v)}
                disabled={courseIsArchived}
                options={groupSets.map((gs) => ({
                  value: gs.id,
                  label: `${gs.name} (${gs.groupCount} ${gs.groupCount === 1 ? 'group' : 'groups'})`,
                }))}
              />
            )}
          </div>
        ) : null}
      </SettingsSection>

      {/* The same footer the other assignment forms use: a rule, then the action at the
          form's right edge. */}
      <div className="flex flex-wrap items-center justify-end gap-3 border-t pt-4">
        <Button type="button" onClick={() => setConfirmOpen(true)} disabled={!canSave}>
          {saving ? 'Changing…' : 'Change type'}
        </Button>
      </div>

      <ConfirmDialog
        open={confirmOpen}
        busy={saving}
        title="Change assignment type?"
        description="Switching between individual and group resets who this assignment is assigned to back to everyone and removes any date exceptions. You can set the new audience and exceptions on the Assign To tab afterward."
        confirmText="Change type"
        onConfirm={applyChange}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  );
}
