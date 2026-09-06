import { BookOpen, Code2, Scale } from 'lucide-react';

import { AuthBrandMark } from './AuthBrandMark';
import { RotatingAuthAutomaton } from './RotatingAuthAutomaton';
import type { AuthAutomaton } from '@/lib/auth-automata';
import { cn } from '@/lib/utils';

/** Quiet at rest, underlined on hover: four links should not read as four buttons. */
const FOOTER_LINK =
  'inline-flex items-center gap-2 hover:text-sidebar-foreground underline-offset-2 hover:underline';

/** Every footer icon, so one change moves the set rather than three of four. */
const FOOTER_ICON = 'size-4 shrink-0 text-blue-400';

/**
 * GitHub's own mark, drawn here because lucide dropped its brand icons.
 *
 * The three icons beside it are outlines and this one is a filled silhouette, which is a
 * mismatch worth accepting: at 16px a generic branch or fork glyph does not say GitHub to
 * anyone, and this is the row where knowing where the source lives is the point. Decorative,
 * because the word next to it already says GitHub.
 */
function GithubMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={className}
      aria-hidden="true"
      focusable="false"
      fill="currentColor"
    >
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.42 7.42 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

/**
 * The dark half of the sign-in screen.
 *
 * It uses the sidebar's token family rather than a palette of its own, which is the whole
 * point: this is the first thing anyone sees of AFCT, and it should be recognisably the same
 * application as the rail they will be looking at a second later. Those tokens are written for
 * light text on a dark surface in every theme, so nothing here needs a dark: variant.
 *
 * Three rows rather than `justify-between`, which is the composition decision here. Pushing an
 * identity block to the top and a footer to the bottom leaves whatever is left as a hole in the
 * middle, and at 1080px that hole was most of the panel. The middle row is the flexible one and
 * it is where the substance goes, so the empty space is distributed around a subject instead
 * of being the subject.
 *
 * Everything decorative is `aria-hidden` and behind the copy. Hidden below the split
 * breakpoint entirely: a phone gets the compact brand header in `LoginForm` instead, because
 * half of this squeezed into a narrow column is neither the picture nor the form.
 */
export function LoginBrandPanel({
  automata,
  className,
}: {
  /** Read from public/auth-automata on the server; see src/lib/auth-automata.ts. */
  automata: AuthAutomaton[];
  className?: string;
}) {
  return (
    <section
      aria-label="About AFCT"
      className={cn(
        'text-sidebar-foreground relative',
        'grid h-dvh grid-cols-[minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)_auto]',
        'p-8 xl:p-12 2xl:p-14',
        className,
      )}
    >
      <div className="relative mt-3 ml-4 max-w-3xl">
        <div className="flex items-center gap-4">
          <AuthBrandMark
            className="size-16 shrink-0 text-blue-400 xl:size-20"
            accentClassName="text-sidebar-foreground"
          />
          <div>
            <p className="text-5xl leading-none font-semibold tracking-tight xl:text-6xl">AFCT</p>
            <p className="mt-2 text-xs font-medium tracking-[0.32em] text-blue-300 uppercase xl:text-sm 2xl:text-base">
              Dashboard
            </p>
          </div>
        </div>

        <p className="text-sidebar-muted-foreground mt-4 text-xs font-medium tracking-[0.2em] uppercase xl:mt-5 xl:text-sm">
          Automated Feedback for Computing Theory
        </p>

        <div className="mt-12 2xl:mt-14">
          <p className="text-[1.75rem] leading-[1.08] font-bold tracking-tight xl:text-[2rem] 2xl:text-[2.625rem]">
            Stronger Learning
            <span className="block w-fit bg-gradient-to-r from-[#7DD3FC] via-[#8EBBF5] to-[#7FA8EA] bg-clip-text text-transparent">
              Through Automated Feedback
            </span>
          </p>

          <p className="text-sidebar-muted-foreground mt-5 max-w-lg text-base leading-normal font-normal 2xl:mt-6 2xl:text-lg">
            Learn, teach, and assess computing theory with intelligent feedback and streamlined
            tools.
          </p>
        </div>
      </div>

      <div className="relative flex min-h-0 items-center justify-center">
        <RotatingAuthAutomaton
          automata={automata}
          className="auth-automaton pointer-events-none aspect-[444/234] max-h-full w-[36rem] max-w-[96%] translate-x-2 -translate-y-3 text-blue-300 opacity-[0.42] xl:w-[44rem] xl:translate-x-6 2xl:w-[50rem]"
        />
      </div>

      <div className="text-sidebar-foreground/85 border-sidebar-foreground/[0.08] bg-sidebar-foreground/[0.035] relative flex w-fit flex-wrap items-center gap-x-3 gap-y-2 rounded-full border px-5 py-2.5 text-xs font-medium backdrop-blur-[1px] xl:gap-x-4 xl:text-sm">
        <span className="inline-flex items-center gap-2">
          <Code2 className={FOOTER_ICON} aria-hidden="true" />
          Open source
        </span>
        <span aria-hidden="true" className="h-3 w-px bg-current opacity-40 xl:h-3.5" />
        <a href="https://www.gnu.org/licenses/agpl-3.0.html" className={FOOTER_LINK}>
          <Scale className={FOOTER_ICON} aria-hidden="true" />
          AGPLv3
        </a>
        <span aria-hidden="true" className="h-3 w-px bg-current opacity-40 xl:h-3.5" />
        <a href="https://pennstatecs.github.io/AFCT/" className={FOOTER_LINK}>
          <BookOpen className={FOOTER_ICON} aria-hidden="true" />
          Documentation
        </a>
        <span aria-hidden="true" className="h-3 w-px bg-current opacity-40 xl:h-3.5" />
        <a href="https://github.com/PennStateCS/AFCT" className={FOOTER_LINK}>
          <GithubMark className={FOOTER_ICON} />
          GitHub
        </a>
      </div>
    </section>
  );
}

export default LoginBrandPanel;
