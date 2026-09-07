'use client';

import { useEffect, useState } from 'react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import {
  VIEWER_SHORTCUTS,
  VIEWER_SHORTCUT_GROUPS,
  shortcutKeys,
  type ViewerShortcutId,
} from '@/lib/viewer-shortcuts';

/**
 * Whether this is a Mac, answered after the first paint.
 *
 * False on the server and on the first client render, so the two agree and hydration has
 * nothing to complain about; the Mac spellings appear a moment later. The alternative, reading
 * the platform while rendering, is a mismatch on every Mac.
 */
export function useMacKeys(): boolean {
  const [mac, setMac] = useState(false);
  useEffect(() => {
    setMac(/mac/i.test(navigator.platform || navigator.userAgent));
  }, []);
  return mac;
}

/** One key or combination, as a keyboard key rather than as words about one. */
export function ShortcutKeys({ id, className }: { id: ViewerShortcutId; className?: string }) {
  const mac = useMacKeys();
  return (
    <kbd
      className={cn(
        'bg-muted text-muted-foreground rounded border px-1.5 py-0.5 font-mono text-[11px] leading-none',
        className,
      )}
    >
      {shortcutKeys(id, mac)}
    </kbd>
  );
}

/**
 * Every shortcut the viewer answers to, in one list.
 *
 * Built from the same definitions the handler matches against and the menus hint at, so a
 * shortcut cannot be listed here and not work, or work and not be listed. Grouped under
 * headings, because eleven keys in one column is a list nobody reads twice.
 */
export function ViewerShortcutsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>Keyboard commands available in the automata viewer.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {VIEWER_SHORTCUT_GROUPS.map((group) => {
            const rows = VIEWER_SHORTCUTS.filter((shortcut) => shortcut.group === group);
            if (rows.length === 0) return null;
            return (
              <section key={group} aria-labelledby={`shortcuts-${group}`}>
                <h3
                  id={`shortcuts-${group}`}
                  className="text-muted-foreground mb-2 text-xs font-medium tracking-wide uppercase"
                >
                  {group}
                </h3>
                <dl className="space-y-1.5">
                  {rows.map((shortcut) => (
                    <div key={shortcut.id} className="flex items-center justify-between gap-4">
                      <dt className="text-sm">{shortcut.label}</dt>
                      <dd>
                        <ShortcutKeys id={shortcut.id} />
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>
            );
          })}
          {/* Escape has no single answer, so it is described rather than listed with the rest:
              what it gives up depends on what is in hand. */}
          <section aria-labelledby="shortcuts-escape">
            <h3
              id="shortcuts-escape"
              className="text-muted-foreground mb-2 text-xs font-medium tracking-wide uppercase"
            >
              Escape
            </h3>
            <dl className="space-y-1.5">
              <div className="flex items-center justify-between gap-4">
                <dt className="text-sm">
                  Give up a half-drawn transition, then the tool, then the selection
                </dt>
                <dd>
                  <kbd className="bg-muted text-muted-foreground rounded border px-1.5 py-0.5 font-mono text-[11px] leading-none">
                    Esc
                  </kbd>
                </dd>
              </div>
            </dl>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
