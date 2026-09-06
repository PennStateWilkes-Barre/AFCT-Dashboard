'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { signIn } from 'next-auth/react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { showToast } from '@/lib/toast';
import { LazyMotion, m, AnimatePresence, useReducedMotion } from 'framer-motion';
import { Building2, Check, LockKeyhole, Mail } from 'lucide-react';
import { AuthBrandMark } from '@/components/auth/AuthBrandMark';
import { AuthPageBackground } from '@/components/auth/AuthPageBackground';
import { LoginBrandPanel } from '@/components/auth/LoginBrandPanel';
import { DevLoginToolbar } from '@/components/auth/DevLoginToolbar';
import InputGroup from '@/components/ui/InputGroup';
import HCaptcha from '@hcaptcha/react-hcaptcha';
import { PasswordRulesHelper } from '@/components/auth/PasswordRulesHelper';
import { passwordRules } from '@/lib/password-policy';
import { safeCallbackUrl } from '@/lib/safe-callback';
import { markLoginTransition } from '@/lib/login-transition';
import { oidcRefusalMessage } from '@/lib/oidc-refusal-message';
import { isValidEmail } from '@/lib/email';
import { SignupFormSchema } from '@/schemas/auth';
import type { AuthAutomaton } from '@/lib/auth-automata';

type LoginField = 'email' | 'password';
type SignupField = 'first' | 'last' | 'email' | 'password' | 'confirm';

type LoginErrors = Partial<Record<LoginField, string>>;
type SignupErrors = Partial<Record<SignupField, string>>;

/**
 * Framer Motion's animation features load on demand.
 *
 * This is the first page anyone loads, before they even have a session, so it is the worst
 * place to pay for a large animation library up front. `LazyMotion` keeps only the tiny `m`
 * component in the initial bundle and fetches the DOM animation features separately; the
 * animation itself is unchanged.
 */
const loadMotionFeatures = () => import('framer-motion').then((mod) => mod.domAnimation);

/**
 * How long the page stays up after a successful sign-in before handing over to the dashboard.
 *
 * Long enough for the wipe in globals.css to cover the screen (60ms delay plus a 260ms
 * expansion), short enough that it never feels like a wait. A timer rather than the
 * animation's own end event: the navigation is the real behaviour and the animation is
 * decoration, so it must not be possible for a missed callback to strand somebody on a blue
 * screen. The dashboard's entrance takes it from here, and the two together land around 700ms.
 */
const LOGIN_EXIT_MS = 340;

type LoginFormProps = {
  /** Read on the server, so the signup link and captcha are correct on the first paint. */
  allowSignup: boolean;
  hcaptchaSiteKey?: string;
  /** Whether the site can send email, so the reset link is only offered when it works. */
  mailConfigured?: boolean;
  /** Wording for the institutional sign-in button, or null when none is configured. */
  oidcButtonLabel?: string | null;
  /**
   * The brand panel's decorative drawings, read from public/auth-automata on the server.
   * Passed down rather than read where they are drawn: this file is a Client Component, so
   * everything below it is too, and the read touches the filesystem.
   */
  automata?: AuthAutomaton[];
};

/* ================================================= */

export default function LoginForm({
  allowSignup,
  hcaptchaSiteKey,
  mailConfigured = false,
  oidcButtonLabel = null,
  automata = [],
}: LoginFormProps) {
  const [mode, setMode] = useState<'login' | 'signup'>('login');

  // Honor the OS "reduce motion" preference for the panel transitions (the global
  // CSS reset can't reach framer-motion's JS-driven animation).
  const reduceMotion = useReducedMotion();
  const panelMotion = reduceMotion
    ? { initial: false as const, animate: {}, exit: {}, transition: { duration: 0 } }
    : {
        initial: { opacity: 0, y: 6 },
        animate: { opacity: 1, y: 0 },
        exit: { opacity: 0, y: 6 },
        transition: { duration: 0.2 },
      };

  const [loginEmail, setLoginEmail] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [showLoginPassword, setShowLoginPassword] = useState(false);

  const [signupFirst, setSignupFirst] = useState('');
  const [signupLast, setSignupLast] = useState('');
  const [signupEmail, setSignupEmail] = useState('');
  const [signupPassword, setSignupPassword] = useState('');
  const [signupConfirm, setSignupConfirm] = useState('');
  const [showSignupPassword, setShowSignupPassword] = useState(false);
  const [showSignupConfirm, setShowSignupConfirm] = useState(false);

  const [loading, setLoading] = useState(false);
  const [loginErrors, setLoginErrors] = useState<LoginErrors>({});
  const [signupErrors, setSignupErrors] = useState<SignupErrors>({});
  const [captchaVisible, setCaptchaVisible] = useState(false);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  // Set once the credentials are accepted and the page is on its way out. Everything it drives
  // is one-way: the form never comes back from it, so it also serves as the resubmit guard.
  const [loginComplete, setLoginComplete] = useState(false);
  // Where the wipe starts from, in viewport pixels, plus how wide the circle has to be to
  // cover the screen from there. Null until the sign-in succeeds.
  const [exitOrigin, setExitOrigin] = useState<{ x: number; y: number; size: number } | null>(null);
  // One ref per form rather than one shared between them: while AnimatePresence crosses the
  // two forms over, React attaches the incoming ref before detaching the outgoing one, and a
  // single ref would be left null by the detach.
  const loginSubmitRef = useRef<HTMLButtonElement | null>(null);
  const signupSubmitRef = useRef<HTMLButtonElement | null>(null);
  const interactionStartRef = useRef(
    typeof performance !== 'undefined' ? performance.now() : Date.now(),
  );

  const searchParams = useSearchParams();
  // Where to send the user after login — honors ?callbackUrl= (e.g. a course join
  // link that bounced through login), but only same-origin paths (no open redirect).
  const callbackUrl = safeCallbackUrl(searchParams.get('callbackUrl'));
  const isDev = process.env.NODE_ENV !== 'production';
  // Both of these used to be fetched from /api/system-settings/public in an effect on mount,
  // which meant the page painted without them and the signup link appeared a beat late. The
  // server reads them now and passes them in, so the first paint is already correct. The
  // build-time env var stays as the fallback for when the setting is unset.
  const captchaSiteKey = hcaptchaSiteKey || process.env.NEXT_PUBLIC_HCAPTCHA_SITE_KEY;

  const getMonotonicNow = () =>
    typeof performance !== 'undefined' ? performance.now() : Date.now();
  const computeInteractionMs = () =>
    Math.max(0, Math.round(getMonotonicNow() - interactionStartRef.current));
  const shouldRenderCaptcha = Boolean(captchaVisible && captchaSiteKey);

  // Reveal the captcha widget when one is configured. Returns whether it was shown
  // so callers can tailor their message: solve-the-challenge vs. just wait out the
  // cooldown (when no captcha is set up, the limiter still enforces a timed cooldown).
  const requestCaptchaIfAvailable = useCallback(() => {
    if (!captchaSiteKey) return false;
    setCaptchaVisible(true);
    setCaptchaToken(null);
    return true;
  }, [captchaSiteKey]);

  const handleCaptchaVerify = (token: string) => setCaptchaToken(token);
  const handleCaptchaReset = () => setCaptchaToken(null);

  // Keep focus on first field whenever the user toggles between login/signup modes.
  useEffect(() => {
    document.getElementById(mode === 'login' ? 'login-email' : 'signup-first')?.focus();
    interactionStartRef.current = getMonotonicNow();
  }, [mode]);

  useEffect(() => {
    if (allowSignup === false && mode === 'signup') {
      setMode('login');
    }
  }, [allowSignup, mode]);

  /** Strip the one-shot error parameters, keeping everything else about the URL. */
  const clearAuthErrorParams = useCallback(() => {
    try {
      // From the same parameters the message was read out of, so the two cannot disagree.
      const params = new URLSearchParams(searchParams.toString());
      if (!params.has('error') && !params.has('reason')) return;
      params.delete('error');
      params.delete('reason');
      const query = params.toString();
      window.history.replaceState({}, '', `/login${query ? `?${query}` : ''}`);
    } catch {
      // Only the tidying is lost if the address cannot be rewritten; the message was shown,
      // and the sign-in below states its own destination rather than reading this.
    }
  }, [searchParams]);

  // Surface NextAuth error query params as toast feedback.
  useEffect(() => {
    const error = searchParams.get('error');
    if (!error) return;

    if (error === 'RateLimitExceeded') {
      showToast.error('Too many attempts. Please wait before trying again.');
      return;
    }

    if (error === 'BotChallengeRequired') {
      const shown = requestCaptchaIfAvailable();
      showToast.error(
        shown
          ? 'Unusual activity detected. Complete the security check below to continue.'
          : 'Too many attempts. Please wait a moment before trying again.',
      );
      return;
    }

    /**
     * Institutional sign-in refusals, which are not password failures and must not be reported
     * as one: somebody whose provider shared no address would otherwise retype a password that
     * was never wrong. The reason is a fixed word from the callback, and the wording avoids
     * saying whether an AFCT account exists.
     */
    if (error === 'oidc') {
      showToast.error(oidcRefusalMessage(searchParams.get('reason')));
      // Taken out of the address bar once it has been read. It has done its job, a reload
      // should not repeat it, and leaving it there means every later sign-in from this page
      // carries an `error` parameter that the Auth.js client reads as its own failure.
      clearAuthErrorParams();
      return;
    }

    showToast.error('Invalid email or password.');
    clearAuthErrorParams();
  }, [searchParams, requestCaptchaIfAvailable, clearAuthErrorParams]);

  // Classify a failed sign-in by asking the read-only login-check endpoint (NextAuth
  // hides the real reason). Returns 'challenge' (show captcha), 'blocked' (rate
  // limited), or 'ok' (treat as bad credentials). Never throws.
  const fetchLoginState = async (email: string): Promise<'ok' | 'challenge' | 'blocked'> => {
    try {
      const res = await fetch('/api/auth/login-check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      if (!res.ok) return 'ok';
      const data = (await res.json()) as { status?: string };
      return data.status === 'challenge' || data.status === 'blocked' ? data.status : 'ok';
    } catch {
      return 'ok';
    }
  };

  /**
   * The one way out of this page, shared by sign-in and by signup's auto sign-in.
   *
   * Both end identically: hand the browser to `callbackUrl`. The only difference is what the
   * reader sees on the way. With motion allowed, the button confirms, the card settles back a
   * fraction, a cobalt circle grows out of the button until it fills the screen, and a flag is
   * left for the dashboard to pick the movement up on the other side of the load. With reduced
   * motion the page simply navigates, and the flag is never set, so the dashboard has nothing
   * to play either. That is a skip, not a shortened version of the same thing.
   *
   * Only ever called after a successful sign-in. A refused credential, a captcha challenge, a
   * rate-limit block or a failed field validation all return before reaching it.
   */
  const finishSignIn = useCallback(() => {
    if (reduceMotion) {
      window.location.href = callbackUrl;
      return;
    }

    const button = (mode === 'login' ? loginSubmitRef : signupSubmitRef).current;
    const rect = button?.getBoundingClientRect();
    const x = rect ? rect.left + rect.width / 2 : window.innerWidth / 2;
    const y = rect ? rect.top + rect.height / 2 : window.innerHeight / 2;
    // Diameter, so the circle reaches the corner furthest from the button.
    const size =
      2 * Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));

    setExitOrigin({ x, y, size });
    setLoginComplete(true);
    markLoginTransition();
    window.setTimeout(() => {
      window.location.href = callbackUrl;
    }, LOGIN_EXIT_MS);
  }, [callbackUrl, mode, reduceMotion]);

  // Basic credential flow with minimal client-side validation before delegating to NextAuth.
  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    // Already signed in and on the way out. A second Enter between success and the navigation
    // would otherwise fire another signIn().
    if (loginComplete) return;
    const trimmedEmail = loginEmail.trim();
    const trimmedPassword = loginPassword.trim();

    const errors: LoginErrors = {};
    if (!trimmedEmail) errors.email = 'Email is required.';
    else if (!isValidEmail(trimmedEmail)) errors.email = 'Enter a valid email address.';
    if (!trimmedPassword) errors.password = 'Password is required.';

    setLoginErrors(errors);
    if (Object.keys(errors).length) {
      showToast.error('Please correct the highlighted fields.');
      return;
    }

    setLoading(true);

    const result = await signIn('credentials', {
      email: trimmedEmail,
      password: trimmedPassword,
      interactionMs: computeInteractionMs(),
      captchaToken: captchaToken ?? undefined,
      redirect: false,
      // The destination, stated rather than left to default.
      //
      // Auth.js answers a `redirect: false` sign-in with a URL, and the client library treats
      // an `error` parameter *in that URL* as a failed sign-in. Left to itself it echoes the
      // page the request came from, so after an institutional refusal this page carries
      // `?error=oidc` and every password sign-in from it was reported as wrong credentials
      // while the server had in fact signed the person in.
      callbackUrl,
    });

    if (result?.error) {
      // NextAuth (Auth.js v5) reports every authorize failure as a generic error, so
      // ask the server what actually happened: a rate-limit block, a bot challenge
      // (show the captcha), or plain bad credentials.
      const state = await fetchLoginState(trimmedEmail);
      if (state === 'blocked') {
        showToast.error('Too many login attempts. Please wait a few minutes and try again.');
        setLoginErrors({ password: 'Temporarily locked due to too many attempts.' });
      } else if (state === 'challenge') {
        const shown = requestCaptchaIfAvailable();
        showToast.error(
          shown
            ? 'Unusual activity detected. Complete the security check below to continue.'
            : 'Too many attempts. Please wait a moment before trying again.',
        );
      } else {
        showToast.error('Invalid email or password.');
        setLoginErrors({ password: 'Email or password is incorrect.' });
      }
      setLoading(false);
    } else {
      setLoginErrors({});
      setCaptchaVisible(false);
      setCaptchaToken(null);
      finishSignIn();
    }
  };

  // Calls the signup route, then signs the new user in with the same credentials.
  const handleSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (loginComplete) return;

    if (allowSignup !== true) {
      showToast.error('Signups are currently disabled.');
      setMode('login');
      return;
    }

    const trimmed = {
      first: signupFirst.trim(),
      last: signupLast.trim(),
      email: signupEmail.trim(),
      password: signupPassword,
      confirm: signupConfirm,
    };

    // Validate against the shared signup schema (the same field rules the route
    // enforces), mapping its issues back onto the form's per-field error slots.
    const parsed = SignupFormSchema.safeParse({
      firstName: trimmed.first,
      lastName: trimmed.last,
      email: trimmed.email,
      password: trimmed.password,
      confirmPassword: trimmed.confirm,
    });

    if (!parsed.success) {
      const fieldByPath: Record<string, SignupField> = {
        firstName: 'first',
        lastName: 'last',
        email: 'email',
        password: 'password',
        confirmPassword: 'confirm',
      };
      const errors: SignupErrors = {};
      for (const issue of parsed.error.issues) {
        const field = fieldByPath[String(issue.path[0])];
        if (field && !errors[field]) errors[field] = issue.message;
      }
      setSignupErrors(errors);
      showToast.error('Please correct the highlighted fields.');
      return;
    }

    setSignupErrors({});

    setLoading(true);

    const res = await fetch('/api/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        firstName: trimmed.first,
        lastName: trimmed.last,
        email: trimmed.email,
        password: trimmed.password,
        role: 'STUDENT',
        interactionMs: computeInteractionMs(),
        captchaToken: captchaToken ?? undefined,
      }),
    });

    setLoading(false);

    if (res.status === 428) {
      const shown = requestCaptchaIfAvailable();
      showToast.error(
        shown
          ? 'Unusual activity detected. Complete the security check below to continue.'
          : 'Please slow down. Wait a moment before creating another account.',
      );
      return;
    }

    if (res.status === 429) {
      showToast.error('Too many signup attempts. Please try again later.');
      return;
    }

    if (!res.ok) {
      // Surface the server's specific reason. 403 is overloaded — signup disabled
      // vs. an email domain that isn't allowed — and 409 is a duplicate email.
      const message =
        (await res.json().catch(() => null))?.error ?? 'Signup failed. Please try again.';

      if (res.status === 403 && /disabled/i.test(message)) {
        showToast.error(message);
        setMode('login');
        return;
      }
      // Duplicate email or disallowed domain: pin it to the email field so the
      // user sees which input to fix, not just a toast.
      if (res.status === 409 || res.status === 403) {
        setSignupErrors({ email: message });
      }
      showToast.error(message);
      return;
    }

    const signInResult = await signIn('credentials', {
      email: trimmed.email,
      password: trimmed.password,
      interactionMs: computeInteractionMs(),
      captchaToken: captchaToken ?? undefined,
      redirect: false,
      // Same reason as the sign-in above: never let the current URL decide this.
      callbackUrl,
    });

    // The account was created; if the immediate auto-login didn't take, don't
    // strand the user on a bounce — send them to sign in with a clear message.
    if (signInResult?.error) {
      showToast.success('Account created. Please sign in.');
      setSignupErrors({});
      setLoginEmail(trimmed.email);
      setMode('login');
      return;
    }

    setSignupErrors({});
    finishSignIn();
  };

  const passwordHelperId = 'signup-password-helper';
  const passwordRuleStatuses = passwordRules.map((rule) => ({
    label: rule.short,
    passed: rule.test(signupPassword),
  }));

  const renderCaptchaGate = () => {
    if (!shouldRenderCaptcha) return null;
    return (
      <div className="bg-muted text-foreground rounded-xl border p-3 text-sm">
        <p className="mb-2 font-semibold">Complete the security check to continue.</p>
        {/* The widget has a fixed pixel width of its own, so the container scrolls rather
            than the page: a 302px iframe in a 288px column is how the whole layout ends up
            wider than a phone. */}
        <div className="flex justify-center overflow-x-auto">
          <HCaptcha
            sitekey={captchaSiteKey as string}
            onVerify={handleCaptchaVerify}
            onExpire={handleCaptchaReset}
            onError={handleCaptchaReset}
            reCaptchaCompat={false}
            theme="light"
          />
        </div>
      </div>
    );
  };
  // Prefills login credentials for the given role and forces the login form visible.
  const applyTestLogin = (role: string) => {
    setLoginEmail(`${role}@example.com`);
    setLoginPassword('password123');
    setMode('login');
  };

  return (
    /**
     * A fixed light composition, whatever theme the visitor's dashboard is set to.
     *
     * `auth-light` re-declares the light palette for this subtree (see globals.css). Nobody
     * has a session yet on this page, so following a stored dark preference means a stranger's
     * choice deciding whether the sign-in form is legible; before this, the card was a
     * hardcoded white with grey labels bolted on to survive `.dark` on <html>. High contrast
     * still wins over it, which is deliberate.
     */
    /**
     * The split leans further towards the brand as the screen grows: even at a laptop width
     * where the form still wants the room, 55/45 at a desktop, 58/42 on a wide display. The
     * left half carries the mark, the copy, the automaton, the wave and the footer; the right
     * half needs only enough width for a 520px card, so the extra space is worth more on the
     * left. Stopping at 58 rather than 60 is deliberate: past that the form starts to read as
     * a side panel rather than as the point of the page.
     *
     * minmax(0,Nfr) rather than a bare Nfr throughout. A bare fr track will not shrink below
     * its content's min-content width, and the brand panel holds a fixed-width drawing, so the
     * column would quietly grow past its share and push the page wider.
     */
    <div className="auth-light relative min-h-dvh w-full lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] xl:grid-cols-[minmax(0,55fr)_minmax(0,45fr)] 2xl:grid-cols-[minmax(0,58fr)_minmax(0,42fr)]">
      {/* The page ground, and the only one. The columns below carry no background of their
          own, so the card and the development strip read as light objects floating on one
          dark surface rather than as two panes meeting at a seam. */}
      <AuthPageBackground />

      {/* Below lg the picture goes entirely rather than shrinking: half a brand panel beside a
          narrow form is neither one thing nor the other. The compact header below stands in. */}
      <LoginBrandPanel
        automata={automata}
        className="relative z-10 hidden lg:sticky lg:top-0 lg:grid"
      />

      {/* The extra right padding is the only thing pulling the card off the centre of its
          column. On a wide display a dead-centred card leaves the middle of the screen emptier
          than either edge. Note that padding moves the card by half of what you add, since the
          card is centred in what is left.

          Two steps, and the 2xl one used to be a mistake. 2xl is also where the split leans to
          58/42, so the card and the brand column move toward each other at the same breakpoint;
          when the panel was a dark column with a visible seam, nudging at 2xl closed that gap
          from 101px at 1440 to 63px at 1536. The seam is gone now, so what matters is the
          distance from the drawing to the card, and that never drops below 200px anywhere
          across 1440 to 2560. The 2xl step also makes the 1536 dip shallower rather than
          deeper: 79px instead of 63. */}
      <div className="auth-form-surface 3xl:pr-40 relative z-10 flex min-h-dvh w-full flex-col items-center px-4 py-6 sm:px-6 lg:pt-10 lg:pb-6 2xl:pr-16">
        {/* The wipe out of the page. Decorative and inert: it announces nothing, takes no
            focus and cannot be clicked. It lives here rather than around the card because it
            is `position: fixed` and the card's wrapper is translated at xl and above, which
            would make "fixed" mean "fixed to that block". Sized and centred inline because
            only this component knows where the button ended up; the rest is in globals.css
            under "Sign-in transition". */}
        {exitOrigin ? (
          <div className="auth-exit-overlay" aria-hidden="true">
            <span
              style={{
                left: exitOrigin.x,
                top: exitOrigin.y,
                width: exitOrigin.size,
                height: exitOrigin.size,
              }}
            />
          </div>
        ) : null}
        {/* Out of flow on purpose. In flow this block sat above the card, so `flex-1` on the
            card's wrapper measured only the height left underneath it and the card centred in
            that remainder, which put it visibly low on a phone. Absolute inside the container
            that is already `relative`, so the wrapper below can centre the card against the
            whole viewport instead. Anchored near the top rather than at a fixed coordinate the
            card has to dodge: the form has vertical priority here, the branding does not.

            A ladder, because being out of flow means nothing pushes the card away any more:
            above 700px tall the block is whole; between 600 and 700 the descriptor goes and
            the offset tightens; below 600 the block goes entirely. That last rung is not
            fussiness. A card taller than the viewport starts at the top rather than centring,
            so there is no space left for anything above it, and a logo drawn across the email
            field is worse than no logo. */}
        <div className="absolute inset-x-0 top-6 flex flex-col items-center px-4 text-center sm:top-8 lg:hidden [@media(max-height:600px)]:hidden [@media(max-height:700px)]:top-4">
          <AuthBrandMark
            className="size-12 text-blue-400"
            // Light on dark, the same pairing the desktop panel uses. This block sits on the
            // page ground now, not on a light surface, so the card's navy accent would be
            // invisible here.
            accentClassName="text-sidebar-foreground"
          />
          {/* Not a heading: the form's own title is the page's one h1, and a second one here
              would put the product name above the thing the page is for. */}
          <p className="text-sidebar-foreground mt-3 text-xl font-semibold tracking-tight sm:text-2xl">
            AFCT Dashboard
          </p>
          {/* First casualty on a short screen (a phone held sideways, mostly). The card is
              centred against the full viewport now, so on a squat window it rises toward this
              block; dropping the descriptor and tightening the offset above is what keeps them
              apart, rather than pushing the card back down to make room. */}
          <p className="text-sidebar-muted-foreground mt-1 text-sm [@media(max-height:700px)]:hidden">
            Automated Feedback for Computing Theory
          </p>
        </div>

        {/* Wider than the card inside it, so the development strip has room for four buttons
            on one line without the form growing to match. */}
        {/* Equal padding top and bottom, and only in a development build. It changes nothing
            while the content fits, because this block is already taller than the card. When
            the signup form overflows the screen the page grows by both, and the bottom half is
            what leaves room for the drawer hanging off the card's foot. Symmetric so the card
            stays where it was: padding on one side only would move it. */}
        {/* Centred in the leftover height, then lifted a little from xl up. The reference is
            the "Stronger Learning" headline across the page, not the AFCT lockup above it: two
            things starting on roughly the same line is what ties the halves of the screen
            together, and the lockup is too high to be that line.

            A translate rather than a margin or a padding, so it stays a purely visual nudge:
            nothing reflows, the block still occupies the space it centred into, and the card
            cannot start pushing the development strip around on a short window. Left alone at
            lg, where both height and width are tighter and centred is simply the safer place
            to be. */}
        <div
          className={cn(
            'flex w-full max-w-[680px] flex-1 flex-col justify-center',
            'xl:-translate-y-3 2xl:-translate-y-4',
            isDev && 'py-20',
          )}
        >
          {/* Narrower than the column it sits in. A form is read down a single measure, so it
              stops at a comfortable one however wide the screen gets; the development strip
              below is a grid of controls and takes the full width of the column.

              440 rather than the 520 it started at. Sign-in forms sit in a tight band in
              practice, roughly 340 to 400 of actual field width (GitHub 340, Tailwind UI 384,
              Auth0 400); 520 less 64 of padding was 456, wider than any of them. This lands
              at 376, and it is now the same measure at every desktop size rather than being
              squeezed to 457 at the narrow end. */}
          {/* The settle. On a successful sign-in the whole card eases back a fraction as the
              wipe comes over it, so it reads as stepping away rather than being covered. */}
          <div
            className={cn(
              'relative mx-auto w-full max-w-[440px] transition-transform duration-200 ease-out',
              loginComplete && 'scale-[0.975]',
            )}
          >
            {/* Two shadows rather than one. The first is an ordinary dark drop, which is what
                lifts the card off the page. The second is a wide, very faint cobalt ambient at
                0.08, which is not a glow to be seen in its own right: it stops the white
                rectangle reading as if it were cut out and pasted onto a blue photograph, by
                letting a little of the ground's colour gather at its edge.

                Held under 0.1 deliberately. Push the blue much past that and it stops being
                depth and becomes an outline, which is a different and much louder object. The
                card itself stays opaque white; nothing here makes the background show through
                it. */}
            <section
              aria-labelledby="auth-heading"
              className="bg-card relative z-10 w-full rounded-2xl border p-5 shadow-[0_18px_50px_rgba(2,6,23,0.28),0_0_40px_rgba(59,130,246,0.08)] sm:p-6 lg:p-8"
            >
              {/* Outside the animated panels, so switching mode retitles the page rather than
                replacing its h1: one h1 that changes its words, not two that take turns. */}
              {/* The heading starts the card. There was a shield tile above it, and it was
                doing two unhelpful things: taking 76px before anyone reached the words, and
                promising security this page cannot vouch for. A verified-shield over "Create
                your account" made even less sense. If something belongs here later it should
                be the product's own mark, which states an identity rather than a guarantee. */}
              <div className="mb-6 flex flex-col items-center text-center">
                <h1 id="auth-heading" className="text-2xl font-semibold tracking-tight">
                  {mode === 'login' ? 'Welcome to AFCT' : 'Create your account'}
                </h1>
                <p className="text-muted-foreground mt-1 text-sm">
                  {mode === 'login'
                    ? 'Sign in to access the dashboard.'
                    : 'Set up your AFCT Dashboard account'}
                </p>
              </div>

              {/* Neither form sets autoComplete="off". The individual fields carry the
                right tokens (username / current-password / new-password), and a
                form-level "off" can stop a password manager filling or saving them in
                some browsers. Letting the manager do that work is what keeps signing in
                from being a memory test (WCAG 2.2 SC 3.3.8, Accessible Authentication).
                The admin reset-password dialog is the deliberate exception: there an
                administrator is setting someone else's password. */}
              <LazyMotion features={loadMotionFeatures}>
                <AnimatePresence mode="wait" initial={false}>
                  {mode === 'login' ? (
                    <m.form
                      key="login"
                      id="login-panel"
                      {...panelMotion}
                      onSubmit={handleLogin}
                      className="space-y-5"
                    >
                      {/* Not a live region: each field's error <p> now carries role="alert",
                      so announcing here too would double-speak. Kept as static context. */}
                      <p className="sr-only">
                        {Object.values(loginErrors)[0]
                          ? `Form error: ${Object.values(loginErrors)[0]}`
                          : ''}
                      </p>
                      <InputGroup
                        id="login-email"
                        label="Email"
                        name="login-email"
                        leadingIcon={Mail}
                        required
                        requiredMark
                        autoComplete="username"
                        placeholder="name@university.edu"
                        value={loginEmail}
                        setValue={setLoginEmail}
                        type="email"
                        error={loginErrors.email}
                      />

                      <div className="space-y-2">
                        <InputGroup
                          label="Password"
                          name="login-password"
                          leadingIcon={LockKeyhole}
                          required
                          requiredMark
                          autoComplete="current-password"
                          placeholder="Enter your password"
                          value={loginPassword}
                          setValue={setLoginPassword}
                          type="password"
                          showEye
                          isPasswordVisible={showLoginPassword}
                          togglePasswordVisibility={() => setShowLoginPassword((v) => !v)}
                          error={loginErrors.password}
                        />

                        {/* Only offered where the site can actually send it. Without mail
                        configured this link leads to a page that can only apologise, and the
                        row is not rendered at all rather than left empty. */}
                        {mailConfigured ? (
                          <div className="flex justify-end">
                            <Link
                              href="/forgot-password"
                              className="text-link hover:text-link-hover text-sm hover:underline"
                            >
                              Forgot password?
                            </Link>
                          </div>
                        ) : null}
                      </div>

                      {renderCaptchaGate()}

                      <Button
                        ref={loginSubmitRef}
                        type="submit"
                        disabled={loading || loginComplete}
                        aria-disabled={loading || loginComplete}
                        className="h-11 w-full font-semibold"
                      >
                        {loginComplete ? (
                          <>
                            <Check className="size-4" aria-hidden="true" />
                            Signed in
                          </>
                        ) : loading ? (
                          'Logging in...'
                        ) : (
                          'Sign In'
                        )}
                      </Button>

                      {/* Shown only when a provider is configured, so the button never leads
                      somewhere that cannot work, and the divider does not appear on its own.
                      Local sign-in stays above it and keeps working whatever is set here. */}
                      {oidcButtonLabel ? (
                        <div className="space-y-3">
                          <div className="text-muted-foreground flex items-center gap-3 text-xs">
                            <span className="bg-border h-px flex-1" />
                            or
                            <span className="bg-border h-px flex-1" />
                          </div>
                          <Button
                            type="button"
                            variant="outline"
                            className="h-11 w-full"
                            // The same sanitised destination the password form uses. Somebody sent to
                            // the login page from a course link should land on that link, whichever way
                            // they sign in.
                            onClick={() => void signIn('oidc', { callbackUrl })}
                          >
                            <Building2 className="size-4" aria-hidden="true" />
                            {oidcButtonLabel}
                          </Button>
                        </div>
                      ) : null}

                      {allowSignup ? (
                        <p className="text-muted-foreground text-center text-sm">
                          Don&apos;t have an account?{' '}
                          <button
                            type="button"
                            className="text-link hover:text-link-hover font-semibold hover:underline"
                            onClick={() => setMode('signup')}
                          >
                            Create account
                          </button>
                        </p>
                      ) : null}
                    </m.form>
                  ) : (
                    <m.form
                      key="signup"
                      id="signup-panel"
                      {...panelMotion}
                      onSubmit={handleSignup}
                      className="space-y-5"
                    >
                      {/* Not a live region: each field's error <p> now carries role="alert",
                      so announcing here too would double-speak. Kept as static context. */}
                      <p className="sr-only">
                        {Object.values(signupErrors)[0]
                          ? `Form error: ${Object.values(signupErrors)[0]}`
                          : ''}
                      </p>
                      <div className="grid gap-5 sm:grid-cols-2">
                        <InputGroup
                          id="signup-first"
                          label="First Name"
                          name="signup-first"
                          required
                          requiredMark
                          autoComplete="given-name"
                          value={signupFirst}
                          setValue={setSignupFirst}
                          error={signupErrors.first}
                        />

                        <InputGroup
                          label="Last Name"
                          name="signup-last"
                          required
                          requiredMark
                          autoComplete="family-name"
                          value={signupLast}
                          setValue={setSignupLast}
                          error={signupErrors.last}
                        />
                      </div>

                      <InputGroup
                        label="Email"
                        name="signup-email"
                        required
                        requiredMark
                        autoComplete="username"
                        placeholder="name@university.edu"
                        value={signupEmail}
                        setValue={setSignupEmail}
                        type="email"
                        error={signupErrors.email}
                      />

                      <InputGroup
                        label="Password"
                        name="signup-password"
                        required
                        requiredMark
                        autoComplete="new-password"
                        value={signupPassword}
                        setValue={setSignupPassword}
                        type="password"
                        showEye
                        isPasswordVisible={showSignupPassword}
                        togglePasswordVisibility={() => setShowSignupPassword((v) => !v)}
                        additionalDescribedBy={passwordHelperId}
                        error={signupErrors.password}
                      />

                      <InputGroup
                        label="Confirm Password"
                        name="signup-confirm"
                        required
                        requiredMark
                        autoComplete="new-password"
                        value={signupConfirm}
                        setValue={setSignupConfirm}
                        type="password"
                        showEye
                        isPasswordVisible={showSignupConfirm}
                        togglePasswordVisibility={() => setShowSignupConfirm((v) => !v)}
                        error={signupErrors.confirm}
                      />

                      <PasswordRulesHelper id={passwordHelperId} rules={passwordRuleStatuses} />

                      {renderCaptchaGate()}

                      <Button
                        ref={signupSubmitRef}
                        type="submit"
                        disabled={loading || loginComplete}
                        aria-disabled={loading || loginComplete}
                        className="h-11 w-full font-semibold"
                      >
                        {loginComplete ? (
                          <>
                            <Check className="size-4" aria-hidden="true" />
                            Account created
                          </>
                        ) : loading ? (
                          'Signing up...'
                        ) : (
                          'Create Account'
                        )}
                      </Button>

                      <p className="text-muted-foreground text-center text-sm">
                        Already have an account?{' '}
                        <button
                          type="button"
                          className="text-link hover:text-link-hover font-semibold hover:underline"
                          onClick={() => setMode('login')}
                        >
                          Sign in
                        </button>
                      </p>
                    </m.form>
                  )}
                </AnimatePresence>
              </LazyMotion>
            </section>

            {/* A drawer pulled out of the foot of the card, which is what it is: a set of
                shortcuts into this form. Three things do the work. `top-full -mt-2` starts it
                eight pixels above the card's bottom edge, and the card is `relative z-10`, so
                that strip and the drawer's top corners disappear behind it. `px-4` insets it
                from the card's sides, so it looks like it came out of the card rather than
                being stuck to it: 32px each side, which is enough that the inset reads as
                deliberate rather than as a rounding error. And its shadow falls on the page,
                not on the card.

                Absolute, and that is the whole point. In flow it took its height out of the
                space the card centres in, so a development build put the card about 50px above
                where a production build puts it, and the card should not move because a
                debugging aid is present. */}
            {isDev ? (
              <div className="absolute inset-x-0 top-full -mt-2 px-8">
                <DevLoginToolbar onSelectRole={applyTestLogin} />
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
