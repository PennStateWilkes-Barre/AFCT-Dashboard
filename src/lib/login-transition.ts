/**
 * The one-shot flag that carries the sign-in transition across the page load.
 *
 * Signing in ends with a full navigation (`window.location.href`), not a client-side route
 * change, so the login page cannot hand anything to the dashboard except through storage. It
 * sets this key on its way out; the dashboard reads it once, clears it, and plays the matching
 * entrance. Clearing on read is what stops the animation replaying on every later visit, on a
 * refresh, or on a back-navigation into the dashboard.
 *
 * sessionStorage rather than localStorage: the flag is meaningless in another tab, and it
 * should not outlive the browsing session if the dashboard never loads.
 */
export const LOGIN_TRANSITION_KEY = 'afct-login-transition';

/**
 * Arm the entrance. Safe to call anywhere: storage throws outright in some privacy modes, and
 * a decorative animation is never worth breaking a sign-in over.
 */
export function markLoginTransition(): void {
  try {
    window.sessionStorage.setItem(LOGIN_TRANSITION_KEY, 'true');
  } catch {
    // Storage unavailable. The dashboard simply loads without the transition.
  }
}
