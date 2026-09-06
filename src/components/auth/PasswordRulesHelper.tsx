import { Check, CheckCircle, Circle } from 'lucide-react';

type PasswordRuleStatus = {
  label: string;
  passed: boolean;
};

/**
 * The password rules, and how far along the typed password is.
 *
 * This is the signup card's tallest block, so it is laid out to stay short: two columns once
 * there is room for them, one on a narrow phone, and the whole checklist replaced by a single
 * line once every rule is met. Collapsing it is the point. By then the list has nothing left
 * to teach and it was holding open a third of the card for a set of ticks.
 *
 * It is the password field's `aria-describedby` target, which is why the wrapper keeps the id
 * it is given, and why each rule states its own result in text. Colour and glyph are both
 * visual, so neither can be the only place the answer is written down.
 */
export function PasswordRulesHelper({ id, rules }: { id: string; rules: PasswordRuleStatus[] }) {
  const allPassed = rules.length > 0 && rules.every((rule) => rule.passed);

  return (
    <div
      id={id}
      className="bg-muted/60 border-border/60 rounded-xl border px-3 py-2.5 text-xs leading-tight"
    >
      {allPassed ? (
        <p className="text-status-success flex items-center gap-2 font-medium">
          <CheckCircle className="size-4 shrink-0" aria-hidden="true" />
          Password meets all requirements
        </p>
      ) : (
        <>
          <p className="mb-1 font-semibold">Password must include:</p>
          {/* Two columns where they fit, one where they do not. The rules are short phrases
              rather than sentences, so a single column left most of the row empty and made the
              block twice as tall as it needed to be. */}
          <ul className="grid grid-cols-1 gap-x-5 gap-y-1.5 sm:grid-cols-2">
            {rules.map((rule) => (
              <li key={rule.label} className="flex items-center gap-1.5">
                {rule.passed ? (
                  <Check className="text-status-success size-3.5 shrink-0" aria-hidden="true" />
                ) : (
                  <Circle className="text-muted-foreground size-3.5 shrink-0" aria-hidden="true" />
                )}
                {/* Met rules read as done and settled, unmet ones as still pending: green
                    against muted. The heading above carries the instruction, so a pending
                    line does not have to shout to be found. */}
                <span className={rule.passed ? 'text-status-success' : 'text-muted-foreground'}>
                  {rule.label}
                </span>
                <span className="sr-only">{rule.passed ? 'met' : 'not met'}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
