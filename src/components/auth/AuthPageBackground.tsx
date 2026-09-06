import { AuthDecorativeWave } from './AuthDecorativeWave';

/**
 * The branded backdrop every signed-out page shares: sign in, forgot password, choose a new
 * password, change a temporary one.
 *
 * It owns the whole page ground, and it is the only thing that does. The signed-out screens are
 * meant to read as one dark surface with light cards floating on it, so the background stays in
 * this component rather than being split across individual panels.
 *
 * The layers are deliberately atmospheric rather than decorative objects: a dark rail-colour
 * ground, a controlled cobalt lift toward the lower right, a soft highlight behind the brand,
 * a quieter bloom through the middle-left where the login illustration tends to sit, and a very
 * light edge vignette. The contour wave remains the one explicit graphic element.
 *
 * `w-screen` rather than `inset-0` is intentional. `html` carries `scrollbar-gutter: stable`,
 * and a fixed element's containing block excludes that reserved gutter; 100vw keeps the auth
 * background from stopping short of the right edge when the gutter is present.
 */
export function AuthPageBackground() {
  return (
    <>
      {/* Base surface. */}
      <div
        aria-hidden="true"
        className="bg-sidebar pointer-events-none fixed inset-y-0 left-0 z-0 w-screen"
      />

      {/* A restrained diagonal cobalt lift. Keeping most of the middle transparent preserves
          the quiet field behind the form while giving the lower-right corner some depth. */}
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-y-0 left-0 z-0 w-screen bg-[linear-gradient(135deg,rgba(15,23,42,0)_0%,rgba(15,23,42,0)_42%,rgba(37,99,235,0.08)_72%,rgba(37,99,235,0.20)_100%)]"
      />

      {/* Brand-side light. This is broad enough to lift the AFCT lockup and headline without
          reading as a spotlight. */}
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-y-0 left-0 z-0 w-screen bg-[radial-gradient(ellipse_at_14%_10%,rgba(96,165,250,0.18),transparent_43%)]"
      />

      {/* A second, quieter bloom gives the open middle-left of the page some depth and helps the
          automaton feel embedded in the surface instead of placed on top of a flat navy field. */}
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-y-0 left-0 z-0 w-screen bg-[radial-gradient(ellipse_at_34%_61%,rgba(59,130,246,0.10),transparent_34%)]"
      />

      {/* Very light edge falloff. It is intentionally weaker than the blue layers; its job is
          just to keep the eye in the composition, not to make the corners visibly black. */}
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-y-0 left-0 z-0 w-screen bg-[radial-gradient(ellipse_at_center,transparent_42%,rgba(2,6,23,0.16)_100%)]"
      />

      {/* A little taller than the original contour strip so the new wireframe has room to show
          perspective. Its own masks keep the footer and sign-in card areas quiet. */}
      <AuthDecorativeWave className="pointer-events-none fixed -bottom-2 left-0 z-0 h-52 w-screen text-blue-400 xl:h-60 2xl:h-64" />
    </>
  );
}

export default AuthPageBackground;
