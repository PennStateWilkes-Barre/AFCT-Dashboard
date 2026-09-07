import React from 'react';
import type { LucideIcon } from 'lucide-react';
import { CircleCheck, CircleSlash, Gauge, ListOrdered, Share2, Workflow } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import type { BadgeVariant } from '@/lib/badge-presets';
import { RichDescription } from '@/components/rich-description/RichDescription';

type ProblemHeaderProps = {
  title: string;
  description?: string;
  /** The stored rich description, when the problem has one. */
  descriptionJson?: unknown;
  type?: string;
  maxStates?: number;
  isDeterministic?: boolean;
  maxSubmissions?: number;
  autograderEnabled?: boolean;
  className?: string;
};

/**
 * Icon-led badges for a problem's facts.
 *
 * One mapping rather than conditional classes at each call site, so a new problem type or a
 * new fact is a row here instead of another branch in the markup.
 *
 * Colour comes from the shared badge variants, so these sit in the same language as every
 * other badge in the app rather than composing token classes of their own. Nothing depends
 * on the hue: every badge names itself in text and carries an icon, so the colour is
 * reinforcement rather than the message. That is also why "Autograder" is not styled only
 * for the On case.
 *
 * Which family each fact belongs to is the only real decision here. The problem's type and
 * its determinism are identities, so they take categorical hues; the type used to be amber,
 * which read as a caution about a problem that was simply an FA. The limits are plain
 * metadata. Only the autograder reports a state, and only the On case is a state worth
 * colouring.
 */

const typeLabels: Record<string, string> = {
  PDA: 'Pushdown Automaton',
  RE: 'Regular Expression',
  CFG: 'Context-Free Grammar',
  FA: 'Finite Automaton',
};

export default function ProblemHeader({
  title,
  description,
  descriptionJson,
  type,
  maxStates,
  isDeterministic,
  maxSubmissions,
  autograderEnabled,
  className,
}: ProblemHeaderProps) {
  const submissionsLabel =
    typeof maxSubmissions === 'number' ? (maxSubmissions < 0 ? 'Unlimited' : maxSubmissions) : null;
  const hasDescription = !!description || !!descriptionJson;

  const facts: { key: string; icon: LucideIcon; label: string; variant: BadgeVariant }[] = [];
  if (type) {
    facts.push({
      key: 'type',
      icon: Workflow,
      label: typeLabels[type] ?? type,
      variant: 'category-indigo',
    });
  }
  if (typeof maxStates === 'number') {
    facts.push({
      key: 'states',
      icon: Gauge,
      label: `Max States: ${maxStates === -1 ? 'Unlimited' : maxStates}`,
      variant: 'neutral',
    });
  }
  if (typeof isDeterministic === 'boolean') {
    facts.push({
      key: 'det',
      icon: Share2,
      label: isDeterministic ? 'Deterministic' : 'Nondeterministic',
      variant: 'category-blue',
    });
  }
  if (submissionsLabel !== null) {
    facts.push({
      key: 'subs',
      icon: ListOrdered,
      label: `Max Submissions: ${submissionsLabel}`,
      variant: 'neutral',
    });
  }
  if (typeof autograderEnabled === 'boolean') {
    facts.push({
      key: 'ag',
      icon: autograderEnabled ? CircleCheck : CircleSlash,
      label: `Autograder: ${autograderEnabled ? 'On' : 'Off'}`,
      // Off is not a fault, just not switched on, so it reads neutral rather than alarming.
      variant: autograderEnabled ? 'success' : 'neutral',
    });
  }

  return (
    <div className={className}>
      {/* The problem's name, for assistive tech only.
          It is not drawn any more: the card it sits in is headed "Problem Attempts" and the
          list beside it marks the selected problem, so the visible title repeated a word that
          was already on screen twice. Removing it outright would have left nothing naming the
          problem to somebody who cannot see which row of that list is highlighted, which is
          why it stays in the accessibility tree. */}
      <h3 className="sr-only">{title}</h3>
      {facts.length > 0 ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {facts.map(({ key, icon: Icon, label, variant }) => (
            <Badge key={key} variant={variant} className="gap-1.5 px-2.5 py-1 leading-none">
              {/* Decorative: the label beside it already says the same thing, so announcing
                  the icon would read every badge twice. */}
              <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              {label}
            </Badge>
          ))}
        </div>
      ) : null}
      {hasDescription ? (
        <>
          {/* Labelled, because the assignment's own description sits on the same page. Without
              a heading the two ran together as one block of prose and nothing said which was
              which. */}
          <h4 className="mt-3 text-sm font-semibold">Problem Description</h4>
          <RichDescription
            // Heading base: sits under the h4 label above, so the description starts below it.
            headingBaseLevel={5}
            compact
            description={description}
            descriptionJson={descriptionJson}
            className="text-muted-foreground mt-1 text-sm"
          />
        </>
      ) : null}
    </div>
  );
}
