import {
  BookOpen,
  ChartNoAxesColumnIncreasing,
  Code2,
  GraduationCap,
  Scale,
  Zap,
} from 'lucide-react';

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
 * What AFCT does, in three lines, for the two audiences that sign in here.
 *
 * Data rather than markup so the three items cannot drift apart: one row shape, one set of
 * classes, and adding a fourth is a line here rather than a copied block. Kept short on
 * purpose. This is the panel beside a login form, not a product page, so each description is
 * one sentence and none of them sell.
 */
const FEATURES = [
  {
    icon: Zap,
    title: 'Immediate, Actionable Feedback',
    body: 'Get clear feedback that supports learning and guides improvement.',
  },
  {
    icon: GraduationCap,
    title: 'Built for Learning and Teaching',
    body: 'Tools that help students practice and instructors support progress.',
  },
  {
    icon: ChartNoAxesColumnIncreasing,
    title: 'Streamlined Assessment',
    body: 'Simplify submissions, evaluation, grading, and progress tracking.',
  },
] as const;

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
 * That middle row carries the feature list and the automaton side by side from xl, in a nested
 * two-column grid. They shared a column once, stacked, and it did not work: the list pushed the
 * drawing down into a strip above the footer, because the row gave the drawing only the height
 * the copy had not already spent. Side by side, the drawing is sized by its own column's width
 * instead, and the row is as tall as the taller of the two rather than the sum.
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
      {/* Widened from max-w-xl for the headline below, which at its largest runs past what
          576px would hold on one line. It has since come down a size and would now fit either
          way, but the wider cap stays: it only ever releases, never forces, and it means the
          headline can grow again without the line silently breaking in two. Nothing else in
          here is close to this width, so the lockup and the tagline sit where they always did,
          and the column's own padding is the real limit at every size. */}
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
            three coloured lines in a row would leave nothing looking primary.

            A tracked caps label now, at 0.2em, which is the same trick DASHBOARD uses harder
            still at 0.32em. Small, spaced and quiet is what makes it read as branding rather
            than as page copy, and it has to stay quiet: the headline below is the loud thing.

            Set in caps by CSS rather than typed in caps, as DASHBOARD is. The source stays
            readable and searchable, and a screen reader gets the sentence rather than a string
            some of them spell out letter by letter.

            Colour is the existing muted token (#CBD5E1, a light gray with a blue cast) rather
            than a new value: it is already the "not quite white" this wants, it carries a
            measured 12.0:1 against this ground, and it moves with the theme. */}
        <p className="text-sidebar-muted-foreground mt-4 text-xs font-medium tracking-[0.2em] uppercase xl:mt-5 xl:text-sm">
          Automated Feedback for Computing Theory
        </p>

        {/* A separate block, and the gap is what says so. The tight case is not the narrow
            pane but the short one: a 720px-high window at xl leaves 25px between this block
            and the automaton below, which is what caps this gap rather than the width. */}
        <div className="mt-12 2xl:mt-14">
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
              caller). So lg is the small case, not mobile: 28px at lg, 32px at xl, 42px at
              2xl, which keeps each phrase on one line at every width the panel is drawn at.

              In rem, not px, so the whole headline still scales with a reader's own font
              setting. They are off Tailwind's scale because the scale jumps 36px straight to
              48px, and the size wanted here sits in that gap. */}
          <p className="text-[1.75rem] leading-[1.08] font-bold tracking-tight xl:text-[2rem] 2xl:text-[2.625rem]">
            Stronger Learning
            {/* A gradient across the second line only, clipped to the glyphs.

                The stops descend in lightness left to right, and that is the whole point:
                #7DD3FC (L .58) to #8EBBF5 (L .48) to #7FA8EA (L .39). An earlier version ended
                on blue-100, whose lightness climbs back to .81, so the ramp got paler than it
                started and "Feedback" bleached toward white on the dark ground. Even weight
                across the phrase is what keeps it reading as one line of text rather than as a
                word that faded. All three sit between 7.3:1 and 10.6:1 on #111827.

                Written as hex rather than palette names because two of the three are not
                Tailwind colours; only the first is (sky-300). Naming one and hexing two would
                imply the first is special, when they are one authored ramp. Not worth three
                theme tokens for a single headline.

                `w-fit` is load-bearing, not tidiness. `block` alone stretches the box to the
                paragraph's full width, so the gradient would finish past the end of the text
                and the last word would land mid-ramp rather than on the final stop. Sizing the
                box to the glyphs makes the ramp start and end where the words do. */}
            <span className="block w-fit bg-gradient-to-r from-[#7DD3FC] via-[#8EBBF5] to-[#7FA8EA] bg-clip-text text-transparent">
              Through Automated Feedback
            </span>
          </p>

          {/* The supporting line. Both audiences sign in here, so it names what each of them
              came to do: students learn, staff teach and assess.

              Held to max-w-lg (512px) so it breaks to two lines rather than running the width
              of the panel; a measure that long is hard to read and would compete with the
              headline for the eye. Muted and 400 against the headline's near-white bold, which
              is what keeps it secondary.

              16px, stepping to 18px only at 2xl. The panel's tight case is height, not width
              (see the note above about a 720px window at xl), and everything this block spends
              comes out of the row below it. Less pressing since the automaton stopped being
              sized by leftover height, but the footer is still pinned to the bottom and the
              copy still has to fit above it. */}
          <p className="text-sidebar-muted-foreground mt-5 max-w-lg text-base leading-normal font-normal 2xl:mt-6 2xl:text-lg">
            Learn, teach, and assess computing theory with intelligent feedback and streamlined
            tools.
          </p>
        </div>
      </div>

      {/* Row two: the flexible row, and now a shared one. The feature list and the automaton
          sit side by side from xl, which is the point of this layout. The drawing takes its
          size from the width of its own column, so it can no longer be squeezed flat by
          however much vertical space the copy above happens to leave.

          Below xl there is not enough width for two columns and the drawing is dropped rather
          than stacked under the list. Stacking it would make the panel taller, which is the
          thing this arrangement exists to avoid. */}
      <div className="mt-8 grid min-h-0 items-start gap-8 xl:grid-cols-[minmax(0,1.15fr)_minmax(14rem,0.85fr)]">
        {/* A real list, marked up as one, with the markers turned off. "No bullet points" is
            about how it looks; a screen reader still deserves to be told this is three of
            something before it starts reading them.

            Narrower than the sentence above it (30rem against 32rem), which is what stops the
            column creeping toward the login card as it gets taller. The icons align to the
            first line of each row rather than centring on the block, so the three glyphs sit
            on one vertical rhythm whether a description wraps to one line or two. */}
        {/* Spacing that grows with the room there actually is. Keyed to viewport height, not
            to a width breakpoint, because height is what is scarce in this panel: the copy
            above and the footer below are fixed, and this list is what has to fit between
            them. A wide but short window (a 1920x720 one, say) is precisely where more air
            would push the list into the footer, and a width breakpoint would have given it
            more there. 28px on a short screen, 36px once there is real height, 40px on a tall
            display. The only height query in this file; everything else here is width. */}
        <ul className="max-w-[30rem] space-y-7 [@media(min-height:1000px)]:space-y-10 [@media(min-height:850px)]:space-y-9">
          {FEATURES.map(({ icon: Icon, title, body }) => (
            <li key={title} className="flex items-start gap-3.5">
              {/* A tinted disc rather than a bare glyph: an unframed icon reads as debris
                  beside text, and the ring gives it an edge without a border that would
                  compete with the login card's. Both values are alpha on the same cobalt the
                  footer icons use, so the set stays one family. The glyph is half the disc,
                  which is the proportion that keeps it centred rather than crowded. */}
              <span
                aria-hidden="true"
                className="mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-full bg-blue-400/10 ring-1 ring-blue-400/20"
              >
                <Icon className="size-5 text-blue-300" />
              </span>
              <div className="min-w-0">
                <p className="text-sidebar-foreground text-[0.9375rem] leading-snug font-semibold">
                  {title}
                </p>
                <p className="text-sidebar-muted-foreground mt-1 text-sm leading-snug">{body}</p>
              </div>
            </li>
          ))}
        </ul>

        {/* Centred in its own cell and pushed to the outer edge, away from the copy it must
            not crowd. `aspect-[444/234]` turns the width into a height, so nothing here reads
            the row's height and there is no `max-h-full` left to shrink it. The diagram itself
            changes every few minutes; see RotatingAuthAutomaton. */}
        <RotatingAuthAutomaton
          automata={automata}
          className="pointer-events-none hidden aspect-[444/234] w-full max-w-[20rem] self-center justify-self-end text-blue-300 opacity-[0.22] xl:block 2xl:max-w-[24rem]"
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
