/** The strip's own coordinate space. Stretched to whatever the page is wide; see below. */
const W = 600;
const H = 150;

/**
 * One sine curve across the strip, as polyline points.
 *
 * Points rather than a hand-authored cubic path. The curves are decorative and get tuned by
 * eye, and four numbers you can nudge beat four control points you have to re-derive every
 * time the shape changes. At six-unit steps each line is 101 points.
 *
 * `base` is the height it oscillates about, `amp` how far it swings, `freq` how many full
 * cycles fit across the strip, and `phase` shifts it sideways.
 */
function curve(base: number, amp: number, freq: number, phase: number) {
  const points: string[] = [];
  for (let x = 0; x <= W; x += 6) {
    points.push(`${x},${(base + amp * Math.sin((x / W) * Math.PI * 2 * freq + phase)).toFixed(1)}`);
  }
  return points.join(' ');
}

/**
 * Nine lines evenly spaced down the strip, each shifted a little further along than the one
 * above it.
 *
 * The even spacing is what makes this read as a contour map rather than as water: parallel
 * lines at a constant interval are how height is drawn on a map, and the small phase step
 * between them is the drift that keeps them from looking printed. The lowest lines are kept
 * quieter because they pass closest to the footer links; the wave should still be visible at
 * the foot of the page without becoming a texture the text has to fight through.
 */
const LINES = Array.from({ length: 9 }, (_, i) => ({
  key: i,
  points: curve(38 + i * 13, 13, 1.5, i * 0.28),
  // One line still carries the set, but the lower third falls away more quickly where the
  // footer sits. This keeps depth in the drawing without putting high-frequency lines directly
  // behind small text.
  opacity: i === 4 ? 0.2 : i >= 6 ? 0.045 : 0.09,
}));

/**
 * The contour lines along the foot of the signed-out pages.
 *
 * One colour throughout, taken from the caller as `currentColor`, so the whole set moves
 * together and there is nothing here to keep in sync with the palette.
 *
 * The mask deliberately creates a quiet zone across the left third of the strip, where the
 * Open source / AGPLv3 / Documentation / GitHub footer sits. The waves then rise through the
 * open middle of the page before falling away again under the sign-in card. That preserves the
 * contour motif without asking the footer's translucent pill to hide it.
 *
 * Stretched with `preserveAspectRatio="none"` on purpose. The curves mean nothing, so
 * distorting them to whatever width the page has costs nothing and avoids either tiling or
 * cropping. Static, which is also what a reduced-motion preference would have asked for.
 */
export function AuthDecorativeWave({ className }: { className?: string }) {
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
    >
      <defs>
        {/* Keep the footer side intentionally faint, let the contours become most visible in
            the open centre-left, then fade them again beneath the form. */}
        <linearGradient id="afct-contour-falloff" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#fff" stopOpacity="0.08" />
          <stop offset="0.28" stopColor="#fff" stopOpacity="0.16" />
          <stop offset="0.44" stopColor="#fff" stopOpacity="0.72" />
          <stop offset="0.72" stopColor="#fff" stopOpacity="0.42" />
          <stop offset="1" stopColor="#fff" stopOpacity="0.12" />
        </linearGradient>
        <mask id="afct-contour-fade">
          <rect width={W} height={H} fill="url(#afct-contour-falloff)" />
        </mask>
      </defs>

      <g mask="url(#afct-contour-fade)">
        {LINES.map(({ key, points, opacity }) => (
          <polyline key={key} points={points} strokeOpacity={opacity} />
        ))}
      </g>
    </svg>
  );
}

export default AuthDecorativeWave;
