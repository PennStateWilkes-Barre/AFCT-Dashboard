/** The strip's own coordinate space. Stretched to whatever the page is wide; see below. */
const W = 600;
const H = 180;
const ROWS = 11;

/**
 * A projected surface rather than eleven copies of one sine wave.
 *
 * Rows farther toward the foreground are spaced farther apart and swing a little more. That
 * change in spacing is the small perspective cue that makes the bottom decoration read as a
 * surface receding into the page rather than as parallel stripes.
 */
function surfacePoint(row: number, x: number) {
  const t = row / (ROWS - 1);
  const base = 26 + Math.pow(t, 1.45) * 132;
  const amp = 7 + t * 9;
  const phase = row * 0.24;
  const y = base + amp * Math.sin((x / W) * Math.PI * 2 * 1.35 + phase);
  return { x, y };
}

/** One longitudinal contour across the surface. */
function ridge(row: number) {
  const points: string[] = [];
  for (let x = 0; x <= W; x += 5) {
    const p = surfacePoint(row, x);
    points.push(`${p.x},${p.y.toFixed(1)}`);
  }
  return points.join(' ');
}

/**
 * A cross-rib through every contour row.
 *
 * The small horizontal skew toward the foreground keeps these from looking like a flat graph
 * grid. They are deliberately much quieter than the longitudinal contours; the eye should see
 * the shape first and discover the mesh second.
 */
function rib(x: number) {
  const points: string[] = [];
  for (let row = 0; row < ROWS; row += 1) {
    const t = row / (ROWS - 1);
    const p = surfacePoint(row, x);
    const projectedX = p.x + (t - 0.5) * 16;
    points.push(`${projectedX.toFixed(1)},${p.y.toFixed(1)}`);
  }
  return points.join(' ');
}

const RIDGES = Array.from({ length: ROWS }, (_, row) => ({
  key: row,
  points: ridge(row),
  // One middle contour carries the silhouette. Foreground rows remain quieter because they
  // run nearest the footer, while the perspective comes from spacing rather than brightness.
  opacity: row === 5 ? 0.2 : row >= 8 ? 0.055 : 0.095,
}));

const RIBS = Array.from({ length: 15 }, (_, i) => ({
  key: i,
  points: rib(24 + i * 40),
  opacity: i % 4 === 0 ? 0.075 : 0.045,
}));

/**
 * The wireframe contour surface along the foot of the signed-out pages.
 *
 * Longitudinal waves plus faint cross-ribs give the decoration enough perspective to feel
 * three-dimensional without turning the login page into an animated or high-contrast hero.
 * The surface remains static and purely decorative.
 *
 * Two masks keep it out of the way of content. Horizontally, the footer's left third is very
 * quiet and the mesh peaks in the open middle of the page before fading under the sign-in card.
 * Vertically, both the distant top edge and the foreground bottom edge fade away, so the mesh
 * appears to rise out of and sink back into the page rather than ending as a hard rectangle.
 *
 * Stretched with `preserveAspectRatio="none"` on purpose. The mesh carries no data, so adapting
 * to the viewport is preferable to tiling or cropping it.
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
      strokeLinecap="round"
    >
      <defs>
        {/* Quiet behind the footer, strongest through the open middle, quiet again under the
            form. */}
        <linearGradient id="afct-contour-horizontal" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#fff" stopOpacity="0.06" />
          <stop offset="0.25" stopColor="#fff" stopOpacity="0.13" />
          <stop offset="0.42" stopColor="#fff" stopOpacity="0.82" />
          <stop offset="0.67" stopColor="#fff" stopOpacity="0.55" />
          <stop offset="1" stopColor="#fff" stopOpacity="0.1" />
        </linearGradient>
        <mask id="afct-contour-horizontal-mask">
          <rect width={W} height={H} fill="url(#afct-contour-horizontal)" />
        </mask>

        {/* A soft horizon and foreground falloff are what keep the mesh from reading as a box. */}
        <linearGradient id="afct-contour-vertical" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity="0.04" />
          <stop offset="0.2" stopColor="#fff" stopOpacity="0.5" />
          <stop offset="0.58" stopColor="#fff" stopOpacity="1" />
          <stop offset="0.82" stopColor="#fff" stopOpacity="0.55" />
          <stop offset="1" stopColor="#fff" stopOpacity="0.08" />
        </linearGradient>
        <mask id="afct-contour-vertical-mask">
          <rect width={W} height={H} fill="url(#afct-contour-vertical)" />
        </mask>
      </defs>

      <g mask="url(#afct-contour-horizontal-mask)">
        <g mask="url(#afct-contour-vertical-mask)">
          {/* Cross-ribs first, so the brighter longitudinal contours sit naturally on top. */}
          <g strokeWidth="0.75">
            {RIBS.map(({ key, points, opacity }) => (
              <polyline key={key} points={points} strokeOpacity={opacity} />
            ))}
          </g>

          <g strokeWidth="1.2">
            {RIDGES.map(({ key, points, opacity }) => (
              <polyline key={key} points={points} strokeOpacity={opacity} />
            ))}
          </g>
        </g>
      </g>
    </svg>
  );
}

export default AuthDecorativeWave;
