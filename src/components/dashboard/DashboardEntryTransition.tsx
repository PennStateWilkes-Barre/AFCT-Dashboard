import { headers } from 'next/headers';
import { LOGIN_TRANSITION_KEY } from '@/lib/login-transition';

/**
 * The dashboard half of the sign-in transition.
 *
 * The login page now fades to the AFCT navy before the full navigation. This puts the same
 * navy back down on the other side of that load and fades it away, so the dashboard is revealed
 * as one stable composition instead of arriving as several animated regions. The matching
 * colours are what hide the full page navigation between the two halves.
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
 * The visible fade is 520ms. Keep the attribute around a little longer than that so a busy
 * browser cannot remove the transition state before the overlay reaches its final frame.
 */
const ENTRY_TOTAL_MS = 620;

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
