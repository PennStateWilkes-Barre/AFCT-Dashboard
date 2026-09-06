'use client';

import React, { useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from '@/components/ui/dialog';

import { Button } from '@/components/ui/button';
import { DateTimeField } from '@/components/ui/DateTimeField';
import { SearchableMultiSelect } from '@/components/ui/SearchableMultiSelect';

import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { DownloadLogsSchema } from '@/schemas/log';
import type { z } from 'zod';

import { json2csv } from 'json-2-csv';
import { neutralizeCsvFormulasDeep } from '@/lib/csv';
import { showToast } from '@/lib/toast';
import { apiPaths } from '@/lib/api-paths';
import { queryKeys } from '@/lib/query-keys';

// RHF form state = Zod INPUT (strings for datetime-local)
type FormValues = z.infer<typeof DownloadLogsSchema>;

type DownloadLogsDialogProps = {
  open: boolean;
  onOpenChange: (o: boolean) => void;
};

export function DownloadLogsDialog({ open, onOpenChange }: DownloadLogsDialogProps) {
  const defaults: FormValues = useMemo(
    () => ({
      cols: [],
      begTime: '',
      endTime: '',
    }),
    [],
  );

  const {
    control,
    setValue,
    handleSubmit,
    reset,
    watch,
    formState: { errors, isSubmitting, isValid },
  } = useForm<FormValues>({
    resolver: zodResolver(DownloadLogsSchema),
    defaultValues: defaults,
    mode: 'onChange',
    reValidateMode: 'onChange',
  });

  const watchedBegTime = watch('begTime');

  // Available log column names. Fetched lazily via TanStack Query, only when the
  // dialog is open (enabled: open preserves the original lazy-on-open behavior).
  // Field lists rarely change, so a 5-minute staleTime avoids refetching each open.
  const { data: fields, isError: fieldsError } = useQuery({
    queryKey: queryKeys.admin.logsFields(),
    queryFn: async (): Promise<string[]> => {
      const res = await fetch(apiPaths.admin.logsExportFields(), {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.message || res.statusText || 'Failed to duplicate');
      }
      return res.json();
    },
    enabled: open,
    staleTime: 5 * 60_000,
  });

  const colList = useMemo(() => fields ?? [], [fields]);

  // Select All: Set the form value to contain every ID from colList
  const handleSelectAll = () => {
    setValue('cols', colList, { shouldValidate: true, shouldDirty: true });
  };

  // Unselect All: Set the form value to an empty array
  const handleUnselectAll = () => {
    setValue('cols', [], { shouldValidate: true, shouldDirty: true });
  };

  // Reset the form to defaults whenever the dialog opens.
  useEffect(() => {
    if (!open) return;

    reset(defaults, {
      keepDirty: false,
      keepTouched: false,
      keepErrors: false,
      keepValues: false,
    });
  }, [open, defaults, reset]);

  // Surface a fetch failure the same way the original init() did.
  useEffect(() => {
    if (fieldsError) {
      showToast.error(
        'Could not load the list of log fields. Close and reopen this dialog to try again.',
      );
    }
  }, [fieldsError]);

  // Run after colList is available
  useEffect(() => {
    // Get values
    if (colList && colList.length > 0) {
      setValue('cols', colList, { shouldValidate: true, shouldDirty: true });
    }
  }, [colList, setValue]);

  // Reset form
  const resetForm = () => {
    reset(defaults, {
      keepDirty: false,
      keepTouched: false,
      keepErrors: false,
      keepValues: false,
    });
  };

  // Submit
  const onSubmit = async (raw: FormValues) => {
    // Convert form values to the format expected by the API schema
    const payload = {
      ...raw,
      cols: raw.cols,
      begTime: raw.begTime === '' ? '1000-01-01T12:00' : raw.begTime,
      endTime: raw.endTime === '' ? '3000-01-01T12:00' : raw.endTime,
    };

    const res = await fetch(apiPaths.admin.logsExport(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (res.ok) {
      // Convert to CSV format. Log rows carry attacker-influenced strings (names, email
      // addresses, the User-Agent header, metadata), and a cell beginning with = + - @
      // executes as a formula when the export is opened in a spreadsheet. json2csv only
      // quotes, so the values are neutralized first, the same rule every other exporter
      // applies through escapeCsvCell.
      const data = neutralizeCsvFormulasDeep(await res.json());
      const csvString = json2csv(data as object[], { expandNestedObjects: true });

      // Prevent character corruption in Excel with BOM (\uFEFF)
      const blob = new Blob(['\uFEFF' + csvString], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);

      // Instantly trigger download without appending to the DOM
      const link = document.createElement('a');
      link.href = url;
      link.download = 'export_data.csv';
      link.click();

      // Clean up memory immediately to prevent leaks
      URL.revokeObjectURL(url);

      // Reset form and close dialog
      resetForm();
      onOpenChange(false);
      showToast.success('Downloaded log file');
    } else {
      showToast.error('Could not download the logs. Check your connection and try again.');
      console.error('Could not download the logs. Check your connection and try again.');
    }
  };

  const onSubmitWrapper = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    void handleSubmit((data) => onSubmit(data as unknown as FormValues))(e);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          {/* Title */}
          <DialogTitle>Download Logs</DialogTitle>
          <DialogDescription className="sr-only">
            Choose a date range and format, then download the activity logs.
          </DialogDescription>
        </DialogHeader>

        {/* Form */}
        <form onSubmit={onSubmitWrapper} className="min-w-0 space-y-4">
          {/* Fields */}
          <Controller
            control={control}
            name="cols"
            render={({ field }) => (
              <SearchableMultiSelect
                label="Fields"
                items={colList.map((col: string) => ({
                  id: col,
                  label: col,
                }))}
                value={field.value ?? []}
                onChange={(value) => field.onChange(value)}
                placeholder="Select fields"
                searchPlaceholder="Search fields..."
                emptyStateText="No field found."
                error={errors.cols?.message}
                isValid={(field.value?.length ?? 0) > 0 && !errors.cols}
              />
            )}
          />

          {/* Select and remove all */}
          <div className="grid gap-4 md:grid-cols-2">
            <Button type="button" onClick={handleSelectAll}>
              Select All
            </Button>

            <Button type="button" onClick={handleUnselectAll}>
              Clear All
            </Button>
          </div>

          {/* Time range */}
          <div className="grid gap-4 md:grid-cols-2">
            <Controller
              control={control}
              name="begTime"
              render={({ field }) => (
                <DateTimeField
                  label="Start Date & Time"
                  name="begTime"
                  className="min-w-0"
                  value={field.value ?? ''}
                  onChange={field.onChange}
                  onBlur={field.onBlur}
                />
              )}
            />

            <Controller
              control={control}
              name="endTime"
              render={({ field }) => (
                <DateTimeField
                  label="End Date & Time"
                  name="endTime"
                  className="min-w-0"
                  value={field.value ?? ''}
                  onChange={field.onChange}
                  onBlur={field.onBlur}
                  min={watchedBegTime || ''} // prevent picking an end earlier than start
                  // The window is inclusive of its last day, so a bare date runs to 23:59.
                  defaultTime="23:59"
                />
              )}
            />
          </div>

          {/* Form footer */}
          <DialogFooter>
            {/* Close button */}
            <DialogClose asChild>
              <Button
                type="button"
                variant="secondary"
                onClick={resetForm} // clear touched/dirty/errors before closing
                disabled={isSubmitting}
              >
                Cancel
              </Button>
            </DialogClose>

            {/* Submit button */}
            <Button type="submit" disabled={isSubmitting || !isValid}>
              {isSubmitting ? 'Downloading…' : 'Download Logs'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
