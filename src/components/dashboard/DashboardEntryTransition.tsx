import { headers } from 'next/headers';
import { LOGIN_TRANSITION_KEY } from '@/lib/login-transition';

/**
 * The dashboard half of the sign-in transition.
 *
 * The login page covers the screen with a cobalt-to-navy wipe and then navigates. This puts
 * the same navy back down on the other side of that load, fades it out, and brings the sidebar,
 * the header and the page in behind it. Everything it animates is plain CSS, in globals.css
 * plus the later timing refinements in login-transition-tuning.css.
 *
 * **Why an inline script and not a client component.** The flag lives in sessionStorage, which
 * a server render cannot see, so a React component could only discover it once the dashboard
 * had hydrated: the browser would paint the finished dashboard first and the navy would drop on
 * top of it afterwards, which reads as a fault rather than a transition. A script parsed above
 * the dashboard's own markup runs before any of it paints. This is the same reason theme
 * scripts are written inline.
 *
 * It needs the per-request CSP nonce, which `src/proxy.ts` puts on the `x-nonce` request
 * header. Without it the policy blocks the script and the dashboard simply loads unanimated,
 * which is also what happens when storage is unavailable or the reader prefers reduced motion.
 *
 * On every ordinary dashboard load this costs one hidden div, one script that reads a missing
 * key and returns, and no client JavaScript at all.
 */

/**
 * Cleanup happens after the slowest tuned entrance finishes. This is deliberately a little
 * longer than the visible motion so removing the attribute can never snap an element out of
 * its final animation frame on a busy browser.
 */
const ENTRY_TOTAL_MS = 920;

export const DASHBOARD_ENTRY_SCRIPT = `(function(){try{
if(sessionStorage.getItem(${JSON.stringify(LOGIN_TRANSITION_KEY)})!=='true')return;
sessionStorage.removeItem(${JSON.stringify(LOGIN_TRANSITION_KEY)});
if(window.matchMedia('(prefers-reduced-motion: reduce)').matches)return;
var r=document.documentElement;
r.setAttribute('data-afct-entering','');
window.setTimeout(function(){r.removeAttribute('data-afct-entering');},${ENTRY_TOTAL_MS});
}catch(e){}})();`;

export default async function DashboardEntryTransition() {
  const nonce = (await headers()).get('x-nonce') ?? undefined;

  return (
    <>
      {/* Always rendered and always identical to what the server sent, so there is nothing
          for hydration to disagree about. `display: none` until the attribute above says
          otherwise. Decorative: it says nothing and takes no focus. */}
      <div id="afct-entry-overlay" aria-hidden="true" />
      <script nonce={nonce} dangerouslySetInnerHTML={{ __html: DASHBOARD_ENTRY_SCRIPT }} />
    </>
  );
}
