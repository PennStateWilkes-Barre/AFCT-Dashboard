import { headers } from 'next/headers';
import { LOGIN_TRANSITION_KEY } from '@/lib/login-transition';

/**
 * The dashboard half of the sign-in transition.
 *
 * The login page covers the screen with a cobalt-to-navy wipe and then navigates. This puts
 * the same navy back down on the other side of that load, fades it out, and brings the sidebar,
 * the header and the page in behind it. Everything it animates is plain CSS, in globals.css
 * under "Sign-in transition".
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

/** Kept in one place so the timings here and in globals.css cannot drift apart. */
const ENTRY_TOTAL_MS = 500;

export const DASHBOARD_ENTRY_SCRIPT = `(function(){try{
if(sessionStorage.getItem(${JSON.stringify(LOGIN_TRANSITION_KEY)})!=='true')return;
sessionStorage.removeItem(${JSON.stringify(LOGIN_TRANSITION_KEY)});
if(window.matchMedia('(prefers-reduced-motion: reduce)').matches)return;
var r=document.documentElement,o=document.getElementById('afct-entry-overlay');
r.setAttribute('data-afct-entering','');
if(o)o.hidden=false;
window.setTimeout(function(){r.removeAttribute('data-afct-entering');if(o)o.hidden=true;},${ENTRY_TOTAL_MS});
}catch(e){}})();`;

export default async function DashboardEntryTransition() {
  const nonce = (await headers()).get('x-nonce') ?? undefined;

  return (
    <>
      {/* Hidden until the script says otherwise, so a dashboard reached any other way (or with
          scripts blocked) never shows it. Decorative: it says nothing and takes no focus. */}
      <div id="afct-entry-overlay" aria-hidden="true" hidden />
      <script nonce={nonce} dangerouslySetInnerHTML={{ __html: DASHBOARD_ENTRY_SCRIPT }} />
    </>
  );
}
