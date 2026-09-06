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
 * the automaton lives in it, so the empty space is distributed around a subject instead of
 * being the subject.
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
        // No background of its own: `AuthPageBackground` owns the page ground, and a second
        // one here is exactly the vertical seam this layout is meant not to have.
        'text-sidebar-foreground relative',
        // Sticky rather than its own scroller. Signup is taller than the viewport, and two
        // independently scrolling panes is the layout that always ends up trapping a scroll.
        // minmax(0,1fr) on the column, not just the rows. Without it the single implicit
        // column is sized by its widest content, and the automaton's fixed width pushed the
        // column past the panel's own padding: the drawing sat right of centre at lg and was
        // saved from showing outside the panel only by `overflow-hidden`.
        'grid h-dvh grid-cols-[minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)_auto]',
        // The lg step is set by a 1366x768 laptop, where the panel is under 500px wide and
        // there is no spare height; xl and up get the more generous treatment.
        'p-8 xl:p-12 2xl:p-14',
        className,
      )}
    >
      {/* Widened from max-w-xl for the headline below: at 2xl its second line is about 600px,
          which 576px would have wrapped. Nothing else in here is near that width, so the
          lockup and the tagline sit exactly where they did. The column's own padding is the
          real limit at every size, so this cap only ever releases the headline. */}
      <div className="relative mt-3 ml-4 max-w-3xl">
        {/* Identity: the lockup and the words it stands for. The tagline sits under the whole
            row, not inside the text column beside the mark, so the block squares off on the
            mark's left edge instead of stepping in by the width of the mark. */}
        <div className="flex items-center gap-4">
          {/* Cobalt, set here rather than in the mark: the same component is the compact
              header on a phone, where it sits on a light card and takes the primary colour. */}
          <AuthBrandMark
            className="size-16 shrink-0 text-blue-400 xl:size-20"
            // Near-white against the cobalt frame, which is the reference's navy-on-
            // white two-tone inverted for a dark surface.
            accentClassName="text-sidebar-foreground"
          />
          <div>
            {/* The wordmark carries the weight the accent rule used to, so it is a step up
                at each size; the mark grows with it to keep the lockup's proportion. */}
            <p className="text-5xl leading-none font-semibold tracking-tight xl:text-6xl">AFCT</p>
            <p className="mt-2 text-xs font-medium tracking-[0.32em] text-blue-300 uppercase xl:text-sm 2xl:text-base">
              Dashboard
            </p>
          </div>
        </div>

        {/* What the letters stand for, and therefore part of the identity rather than part of
            the greeting: close enough to the lockup to read as one block, and muted, because
            three coloured lines in a row would leave nothing looking primary. Tracked open a
            little, which is the same trick DASHBOARD uses far harder; at 0.05em it reads as
            a descriptor rather than as a second label competing with it. */}
        <p className="text-sidebar-muted-foreground mt-3 text-sm tracking-wider xl:text-base">
          Automated Feedback for Computing Theory
        </p>

        {/* A separate block, and the gap is what says so. The tight case is not the narrow
            pane but the short one: a 720px-high window at xl leaves 25px between this block
            and the automaton below, which is what caps this gap rather than the width. */}
        <div className="mt-10 2xl:mt-12">
          {/* One headline in two lines, not a heading with body copy under it. The second line
              finishes the sentence the first starts, so the two share a size, a weight and a
              leading, and differ only in colour: near-white for the claim, the panel's blue
              accent for what makes it true.

              Deliberately a <p> and not an <h1>. The form already owns the page's only h1
              (`auth-heading`), which is what names the login card to a screen reader; a second
              one here would compete with it and change the document outline for what is a
              typographic decision, not a structural one.

              Sizes step with the panel's own breakpoints rather than the viewport's usual
              ones, because this panel does not exist below lg (`hidden lg:grid` on the
              caller). So lg is the small case, not mobile: 30px at lg, 36px at xl, 48px at
              2xl, which keeps each phrase on one line at every width the panel is drawn at. */}
          <p className="text-3xl leading-[1.08] font-bold tracking-tight xl:text-4xl 2xl:text-5xl">
            Stronger Learning
            <span className="block text-blue-300">Through Automated Feedback</span>
          </p>
        </div>
      </div>

      {/* The middle row, and the reason the panel is a grid. The automaton takes whatever
          height is left between the copy and the footer and centres in it, so the same markup
          is a comfortable composition on a 768px laptop and on a 1440px display.
          Nudged up a notch off dead centre: there is more usable air above it than below,
          where the wave is already occupying the bottom of the frame. The diagram itself
          changes every few minutes; see RotatingAuthAutomaton. */}
      <div className="relative flex min-h-0 items-center justify-center">
        <RotatingAuthAutomaton
          automata={automata}
          className="pointer-events-none aspect-[444/234] max-h-full w-[30rem] max-w-[96%] -translate-y-5 text-blue-300 opacity-[0.22] xl:w-[35rem] 2xl:w-[40rem]"
        />
      </div>

      {/* A glass pill rather than bare text on the wave. The wave's lines run straight through
          this row, and the two ways out are to move the text above them or to give it a
          surface of its own; lifting it cost the automaton 120px of height and left a dead
          band under the footer. So: a translucent film with a blur behind it, which softens
          the lines it covers instead of hiding them.

          The film is deliberately barely there, under 4%, and the blur is 1px rather than the
          4px `backdrop-blur-sm` would give. The wave is six 1.5px curves at 10% to 30%, and a
          4px blur wipes them out: sampling a row through the pill, the wave went from a
          21-level spread to 6, so the pill looked opaque even though almost nothing was
          filling it. At 1px the spread is 12 and the lines still run through. What separates
          the pill from the panel is the edge and that slight refraction, not the fill.

          `w-fit` because a pill has to end where the content does. It wraps to two lines on a
          narrow panel and stays a stadium, which is why the radius is `rounded-full` rather
          than a fixed one that would look wrong at double height.

          Medium weight, and a step brighter than the muted token this used to take. It was
          already at 11:1, so this is not a contrast fix: light text on a dark ground blooms,
          and a 400-weight 14px line sitting directly over the contour lines reads softer than
          its ratio suggests. Weight does more for that than colour does.

          Separators are drawn rules rather than a middle dot or a pipe character: a glyph sits
          on the text baseline, so beside a row of 16px icons it rides low and picks up the
          font's own weight. A 1px box centres with the row and stays 1px at any size. */}
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
