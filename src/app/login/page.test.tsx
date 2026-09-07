/** @vitest-environment jsdom */

import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import LoginForm from './LoginForm';

// The page is now a server component that reads the public settings and passes them in, so the
// tests drive the client form directly and supply those settings as props.
const LoginPage = (
  props: {
    allowSignup?: boolean;
    hcaptchaSiteKey?: string;
    mailConfigured?: boolean;
    oidcButtonLabel?: string | null;
  } = {},
) => (
  <LoginForm
    allowSignup={props.allowSignup ?? true}
    hcaptchaSiteKey={props.hcaptchaSiteKey}
    mailConfigured={props.mailConfigured}
    oidcButtonLabel={props.oidcButtonLabel}
  />
);

const { signInMock, searchState } = vi.hoisted(() => ({
  signInMock: vi.fn(),
  searchState: { current: new URLSearchParams() },
}));

const nowRef = { value: 0 };
const getMockTime = () => nowRef.value;
let performanceNowSpy: ReturnType<typeof vi.spyOn> | null = null;
let originalCaptchaKey: string | undefined;

vi.mock('next-auth/react', () => ({
  signIn: signInMock,
}));

import { toastMock } from '@/test/mocks/toast';

vi.mock('@/lib/toast', () => import('@/test/mocks/toast').then((m) => m.toastModuleMock));
const showToastErrorMock = toastMock.error;

vi.mock('@/components/ui/InputGroup', () => ({
  __esModule: true,
  default: ({
    label,
    id,
    name,
    value = '',
    setValue,
    type = 'text',
    onBlur,
    error,
    additionalDescribedBy,
  }: {
    label: string;
    id?: string;
    name: string;
    value?: string;
    setValue?: (val: string) => void;
    type?: string;
    onBlur?: (event: React.FocusEvent<HTMLInputElement>) => void;
    error?: string;
    additionalDescribedBy?: string;
  }) => {
    const inputId = id ?? name;
    const errorId = `${inputId}-error`;
    const describedByTokens = [] as string[];
    if (additionalDescribedBy) describedByTokens.push(additionalDescribedBy);
    if (error) describedByTokens.push(errorId);
    const describedBy = describedByTokens.length ? describedByTokens.join(' ') : undefined;
    return (
      <label htmlFor={inputId}>
        {label}
        <input
          id={inputId}
          name={name}
          type={type}
          value={value}
          aria-invalid={error ? 'true' : undefined}
          aria-describedby={describedBy}
          onChange={(event) => setValue?.(event.target.value)}
          onBlur={onBlur}
        />
        {error && (
          <span id={errorId} role="alert">
            {error}
          </span>
        )}
      </label>
    );
  },
}));

const setSearchParams = (entries: Record<string, string> = {}) => {
  const next = new URLSearchParams();
  Object.entries(entries).forEach(([key, value]) => next.set(key, value));
  searchState.current = next;
};

vi.mock('next/navigation', () => ({
  useSearchParams: () => searchState.current,
}));

// Flipped per test. Reduced motion is a real branch in this form now (it skips the sign-in
// transition rather than shortening it), so the suite has to be able to ask for it.
const reduceMotionRef = vi.hoisted(() => ({ value: false }));

vi.mock('framer-motion', () => {
  const motionProxy = new Proxy(
    {},
    {
      get: (_, element: string) => {
        const Tag = element as keyof React.JSX.IntrinsicElements;
        return ({ children, ...props }: { children?: React.ReactNode }) =>
          React.createElement(Tag, props, children);
      },
    },
  );

  return {
    motion: motionProxy,
    // The form uses LazyMotion + `m` now, so the animation features load on demand.
    m: motionProxy,
    LazyMotion: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    domAnimation: {},
    AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    useReducedMotion: () => reduceMotionRef.value,
  };
});

vi.mock('@radix-ui/react-popover', () => ({
  Root: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Trigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Content: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Portal: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Arrow: () => null,
}));

vi.mock('@hcaptcha/react-hcaptcha', () => ({
  __esModule: true,
  default: ({ onVerify }: { onVerify?: (token: string) => void }) => (
    <button data-testid="mock-hcaptcha" onClick={() => onVerify?.('mock-token')}>
      MockCaptcha
    </button>
  ),
}));

const fetchMock = vi.fn();
let originalFetch: typeof fetch;
let originalLocation: Location;

const configureLocation = () => {
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: {
      href: '',
      assign: vi.fn(),
      replace: vi.fn(),
    },
  });
};

const createJsonResponse = <T,>(data: T, status = 200) =>
  Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  } as Response);

const mockPublicSettings = (allowSignup = true) => {
  fetchMock.mockImplementation((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/system-settings/public')) {
      return createJsonResponse({ timezone: 'UTC', allowSignup }, 200);
    }
    // The login form classifies a failed sign-in via this endpoint; default to "ok"
    // (treat as bad credentials) unless a test overrides it below.
    if (url.includes('/api/auth/login-check')) {
      return createJsonResponse({ status: 'ok', retryAfterMs: 0 }, 200);
    }
    return createJsonResponse({}, 500);
  });
};

// Override the login-check classification for a test (challenge / blocked / ok).
const setLoginCheckStatus = (status: 'ok' | 'challenge' | 'blocked', allowSignup = true) => {
  fetchMock.mockImplementation((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/system-settings/public')) {
      return createJsonResponse({ timezone: 'UTC', allowSignup }, 200);
    }
    if (url.includes('/api/auth/login-check')) {
      return createJsonResponse({ status, retryAfterMs: 0 }, 200);
    }
    return createJsonResponse({}, 500);
  });
};

const LOGIN_SUBMIT_LABEL = 'Sign In';
const SIGNUP_SUBMIT_LABEL = 'Create Account';

const getButtonByType = (label: string | RegExp, type: 'submit' | 'button') => {
  const buttons = screen.getAllByRole('button', { name: label });
  const target = buttons.find((btn) => btn.getAttribute('type') === type);
  if (!target) {
    throw new Error(`Button with label ${label.toString()} and type ${type} not found`);
  }
  return target;
};

const switchMode = async (user: ReturnType<typeof userEvent.setup>, label: string | RegExp) => {
  await waitFor(() => {
    expect(screen.queryByRole('button', { name: label })).toBeInTheDocument();
  });
  const toggle = getButtonByType(label, 'button');
  await user.click(toggle);
};

const getSubmitButton = (label: string | RegExp) => getButtonByType(label, 'submit');

beforeAll(() => {
  (globalThis as typeof globalThis & { React?: typeof React }).React = React;
  originalFetch = globalThis.fetch;
  originalLocation = window.location;
  originalCaptchaKey = process.env.NEXT_PUBLIC_HCAPTCHA_SITE_KEY;
  process.env.NEXT_PUBLIC_HCAPTCHA_SITE_KEY = 'test-hcaptcha-key';
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    performanceNowSpy = vi.spyOn(performance, 'now').mockImplementation(getMockTime);
  }
});

afterAll(() => {
  globalThis.fetch = originalFetch;
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: originalLocation,
  });
  performanceNowSpy?.mockRestore();
  process.env.NEXT_PUBLIC_HCAPTCHA_SITE_KEY = originalCaptchaKey;
});

beforeEach(() => {
  vi.clearAllMocks();
  setSearchParams();
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  mockPublicSettings(true);
  configureLocation();
  nowRef.value = 0;
  reduceMotionRef.value = false;
  window.sessionStorage.clear();
});

describe('LoginPage', () => {
  it('hides signup affordances when public settings disable signup', () => {
    // The server reads this setting and passes it in, so it is correct on the first paint
    // rather than arriving after a fetch. No waiting required, which is the point.
    render(<LoginPage allowSignup={false} />);

    expect(screen.queryByRole('button', { name: /Create account/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/Don't have an account\?/i)).not.toBeInTheDocument();
  });

  it('submits login form and redirects on success', async () => {
    signInMock.mockResolvedValueOnce({ error: null });
    const user = userEvent.setup();

    render(<LoginPage />);

    fireEvent.change(screen.getByLabelText(/email/i), {
      target: { value: 'admin@example.com' },
    });
    fireEvent.change(screen.getByLabelText(/^password$/i), {
      target: { value: 'StrongPass1!' },
    });
    await waitFor(() => expect(getSubmitButton(LOGIN_SUBMIT_LABEL)).not.toBeDisabled());
    await user.click(getSubmitButton(LOGIN_SUBMIT_LABEL));

    await waitFor(() =>
      expect(signInMock).toHaveBeenCalledWith(
        'credentials',
        expect.objectContaining({
          email: 'admin@example.com',
          password: 'StrongPass1!',
          redirect: false,
          interactionMs: expect.any(Number),
        }),
      ),
    );

    await waitFor(() => expect(window.location.href).toBe('/dashboard'));
  });

  it('honors a same-origin callbackUrl after login (e.g. a join link)', async () => {
    setSearchParams({ callbackUrl: '/dashboard?joinCode=ABCD2345' });
    signInMock.mockResolvedValueOnce({ error: null });
    const user = userEvent.setup();

    render(<LoginPage />);

    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'admin@example.com' } });
    fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: 'StrongPass1!' } });
    await waitFor(() => expect(getSubmitButton(LOGIN_SUBMIT_LABEL)).not.toBeDisabled());
    await user.click(getSubmitButton(LOGIN_SUBMIT_LABEL));

    await waitFor(() => expect(window.location.href).toBe('/dashboard?joinCode=ABCD2345'));
  });

  it('ignores an off-site callbackUrl and falls back to the dashboard', async () => {
    setSearchParams({ callbackUrl: 'https://evil.example.com' });
    signInMock.mockResolvedValueOnce({ error: null });
    const user = userEvent.setup();

    render(<LoginPage />);

    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'admin@example.com' } });
    fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: 'StrongPass1!' } });
    await waitFor(() => expect(getSubmitButton(LOGIN_SUBMIT_LABEL)).not.toBeDisabled());
    await user.click(getSubmitButton(LOGIN_SUBMIT_LABEL));

    await waitFor(() => expect(window.location.href).toBe('/dashboard'));
  });

  it('keeps the submit button enabled and surfaces field errors on submit', async () => {
    const user = userEvent.setup();
    render(<LoginPage />);

    // The button is no longer hard-disabled before valid input — even a malformed
    // email leaves it clickable so the user can submit and see the error.
    expect(getSubmitButton(LOGIN_SUBMIT_LABEL)).not.toBeDisabled();
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'not-an-email' } });
    await waitFor(() => expect(getSubmitButton(LOGIN_SUBMIT_LABEL)).not.toBeDisabled());

    // Valid email but missing password: submit runs, surfaces the error, and does
    // not attempt to authenticate.
    fireEvent.change(screen.getByLabelText(/email/i), {
      target: { value: 'incomplete@example.com' },
    });
    await waitFor(() => expect(getSubmitButton(LOGIN_SUBMIT_LABEL)).not.toBeDisabled());
    await user.click(getSubmitButton(LOGIN_SUBMIT_LABEL));

    await waitFor(() =>
      expect(showToastErrorMock).toHaveBeenCalledWith('Please correct the highlighted fields.'),
    );
    expect(screen.getByText('Password is required.')).toBeInTheDocument();
    expect(signInMock).not.toHaveBeenCalled();
  });

  it('shows toast for invalid credentials via search params', async () => {
    setSearchParams({ error: 'CredentialsSignin' });
    render(<LoginPage />);

    await waitFor(() =>
      expect(showToastErrorMock).toHaveBeenCalledWith('Invalid email or password.'),
    );
  });

  it('shows toast for rate limited search param', async () => {
    setSearchParams({ error: 'RateLimitExceeded' });
    render(<LoginPage />);

    await waitFor(() =>
      expect(showToastErrorMock).toHaveBeenCalledWith(
        'Too many attempts. Please wait before trying again.',
      ),
    );
  });

  it('shows toast for bot challenge search param', async () => {
    setSearchParams({ error: 'BotChallengeRequired' });
    render(<LoginPage />);

    await waitFor(() =>
      expect(showToastErrorMock).toHaveBeenCalledWith(
        'Unusual activity detected. Complete the security check below to continue.',
      ),
    );
  });

  it('prefills login form using quick role buttons', async () => {
    const user = userEvent.setup();
    render(<LoginPage />);

    await user.click(screen.getByRole('button', { name: 'Admin' }));

    expect(screen.getByLabelText(/email/i)).toHaveValue('admin@example.com');
    expect(screen.getByLabelText(/^password$/i)).toHaveValue('password123');
    expect(getSubmitButton(LOGIN_SUBMIT_LABEL)).not.toBeDisabled();
  });

  it('shows field error when NextAuth rejects credentials', async () => {
    const user = userEvent.setup();
    signInMock.mockResolvedValueOnce({ error: 'CredentialsSignin' });

    render(<LoginPage />);

    fireEvent.change(screen.getByLabelText(/email/i), {
      target: { value: 'admin@example.com' },
    });
    fireEvent.change(screen.getByLabelText(/^password$/i), {
      target: { value: 'WrongPass1!' },
    });

    await waitFor(() => expect(getSubmitButton(LOGIN_SUBMIT_LABEL)).not.toBeDisabled());

    await user.click(getSubmitButton(LOGIN_SUBMIT_LABEL));

    await waitFor(() =>
      expect(showToastErrorMock).toHaveBeenCalledWith('Invalid email or password.'),
    );
    expect(screen.getByText('Email or password is incorrect.')).toBeInTheDocument();
    await waitFor(() => expect(signInMock).toHaveBeenCalled());
  });

  it('surfaces rate limit errors classified via login-check', async () => {
    const user = userEvent.setup();
    signInMock.mockResolvedValueOnce({ error: 'CredentialsSignin' });
    setLoginCheckStatus('blocked');

    render(<LoginPage />);

    fireEvent.change(screen.getByLabelText(/email/i), {
      target: { value: 'admin@example.com' },
    });
    fireEvent.change(screen.getByLabelText(/^password$/i), {
      target: { value: 'StrongPass1!' },
    });

    await waitFor(() => expect(getSubmitButton(LOGIN_SUBMIT_LABEL)).not.toBeDisabled());

    await user.click(getSubmitButton(LOGIN_SUBMIT_LABEL));

    await waitFor(() =>
      expect(showToastErrorMock).toHaveBeenCalledWith(
        'Too many login attempts. Please wait a few minutes and try again.',
      ),
    );
    expect(signInMock).toHaveBeenCalled();
  });

  it('surfaces bot challenge classified via login-check (shows captcha)', async () => {
    const user = userEvent.setup();
    signInMock.mockResolvedValueOnce({ error: 'CredentialsSignin' });
    setLoginCheckStatus('challenge');

    render(<LoginPage />);

    fireEvent.change(screen.getByLabelText(/email/i), {
      target: { value: 'admin@example.com' },
    });
    fireEvent.change(screen.getByLabelText(/^password$/i), {
      target: { value: 'StrongPass1!' },
    });

    await waitFor(() => expect(getSubmitButton(LOGIN_SUBMIT_LABEL)).not.toBeDisabled());

    await user.click(getSubmitButton(LOGIN_SUBMIT_LABEL));

    await waitFor(() =>
      expect(showToastErrorMock).toHaveBeenCalledWith(
        'Unusual activity detected. Complete the security check below to continue.',
      ),
    );
    expect(signInMock).toHaveBeenCalled();
    expect(screen.getAllByTestId('mock-hcaptcha').length).toBeGreaterThanOrEqual(1);
  });

  it('tells the user to wait when a bot challenge fires but no captcha is configured', async () => {
    const user = userEvent.setup();
    const savedKey = process.env.NEXT_PUBLIC_HCAPTCHA_SITE_KEY;
    delete process.env.NEXT_PUBLIC_HCAPTCHA_SITE_KEY;
    try {
      signInMock.mockResolvedValueOnce({ error: 'CredentialsSignin' });
      setLoginCheckStatus('challenge');

      render(<LoginPage />);

      fireEvent.change(screen.getByLabelText(/email/i), {
        target: { value: 'admin@example.com' },
      });
      fireEvent.change(screen.getByLabelText(/^password$/i), {
        target: { value: 'StrongPass1!' },
      });

      await waitFor(() => expect(getSubmitButton(LOGIN_SUBMIT_LABEL)).not.toBeDisabled());

      await user.click(getSubmitButton(LOGIN_SUBMIT_LABEL));

      await waitFor(() =>
        expect(showToastErrorMock).toHaveBeenCalledWith(
          'Too many attempts. Please wait a moment before trying again.',
        ),
      );
      // No captcha configured, so no widget is shown; the cooldown alone throttles.
      expect(screen.queryByTestId('mock-hcaptcha')).toBeNull();
    } finally {
      if (savedKey === undefined) delete process.env.NEXT_PUBLIC_HCAPTCHA_SITE_KEY;
      else process.env.NEXT_PUBLIC_HCAPTCHA_SITE_KEY = savedKey;
    }
  });

  it("prevents signup when passwords don't match", async () => {
    const user = userEvent.setup();
    render(<LoginPage />);

    await switchMode(user, /Create account/i);

    fireEvent.change(screen.getByLabelText('First Name'), { target: { value: 'Ada' } });
    fireEvent.change(screen.getByLabelText('Last Name'), { target: { value: 'Lovelace' } });
    const signupEmail = screen.getByLabelText('Email');
    fireEvent.change(signupEmail, { target: { value: 'ada@example.com' } });
    fireEvent.change(screen.getByLabelText(/^Password$/), { target: { value: 'StrongPass1!' } });
    fireEvent.change(screen.getByLabelText('Confirm Password'), {
      target: { value: 'Mismatch1!' },
    });

    await user.click(getSubmitButton(SIGNUP_SUBMIT_LABEL));

    await waitFor(() =>
      expect(showToastErrorMock).toHaveBeenCalledWith('Please correct the highlighted fields.'),
    );
    expect(screen.getByText("Passwords don't match.")).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/api/auth/signup'))).toBe(
      false,
    );
    expect(signInMock).not.toHaveBeenCalled();
  });

  it('completes signup flow and logs the user in', async () => {
    const user = userEvent.setup();
    render(<LoginPage />);

    await switchMode(user, /Create account/i);

    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/system-settings/public')) {
        return createJsonResponse({ timezone: 'UTC', allowSignup: true }, 200);
      }
      if (url.includes('/api/auth/signup')) {
        return createJsonResponse({}, 200);
      }
      return createJsonResponse({}, 500);
    });

    fireEvent.change(screen.getByLabelText('First Name'), { target: { value: 'Grace' } });
    fireEvent.change(screen.getByLabelText('Last Name'), { target: { value: 'Hopper' } });
    const emailField = screen.getByLabelText('Email');
    fireEvent.change(emailField, { target: { value: 'grace@example.com' } });
    fireEvent.change(screen.getByLabelText(/^Password$/), { target: { value: 'StrongPass1!' } });
    fireEvent.change(screen.getByLabelText('Confirm Password'), {
      target: { value: 'StrongPass1!' },
    });

    signInMock.mockResolvedValue({ error: null });

    await user.click(getSubmitButton(SIGNUP_SUBMIT_LABEL));

    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/api/auth/signup'))).toBe(
        true,
      ),
    );
    const signupCall = fetchMock.mock.calls.find(([url]) =>
      String(url).includes('/api/auth/signup'),
    );
    expect(signupCall).toBeDefined();
    const [signupUrl, signupInit] = signupCall as [RequestInfo | URL, RequestInit | undefined];
    expect(signupUrl).toBe('/api/auth/signup');
    expect(signupInit).toMatchObject({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(JSON.parse((signupInit as RequestInit).body as string)).toEqual(
      expect.objectContaining({
        firstName: 'Grace',
        lastName: 'Hopper',
        email: 'grace@example.com',
        password: 'StrongPass1!',
        role: 'STUDENT',
        interactionMs: expect.any(Number),
      }),
    );

    await waitFor(() =>
      expect(signInMock).toHaveBeenCalledWith(
        'credentials',
        expect.objectContaining({
          email: 'grace@example.com',
          password: 'StrongPass1!',
          redirect: false,
          interactionMs: expect.any(Number),
        }),
      ),
    );
    await waitFor(() => expect(window.location.href).toBe('/dashboard'));
    expect(showToastErrorMock).not.toHaveBeenCalled();
  });

  it('handles signup API failure gracefully', async () => {
    const user = userEvent.setup();
    render(<LoginPage />);

    await switchMode(user, /Create account/i);

    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/system-settings/public')) {
        return createJsonResponse({ timezone: 'UTC', allowSignup: true }, 200);
      }
      if (url.includes('/api/auth/signup')) {
        return createJsonResponse({}, 500);
      }
      return createJsonResponse({}, 500);
    });

    fireEvent.change(screen.getByLabelText('First Name'), { target: { value: 'Linus' } });
    fireEvent.change(screen.getByLabelText('Last Name'), { target: { value: 'Torvalds' } });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'linus@example.com' } });
    fireEvent.change(screen.getByLabelText(/^Password$/), { target: { value: 'StrongPass1!' } });
    fireEvent.change(screen.getByLabelText('Confirm Password'), {
      target: { value: 'StrongPass1!' },
    });

    await user.click(getSubmitButton(SIGNUP_SUBMIT_LABEL));

    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/api/auth/signup'))).toBe(
        true,
      ),
    );
    await waitFor(() =>
      expect(showToastErrorMock).toHaveBeenCalledWith('Signup failed. Please try again.'),
    );
    expect(signInMock).not.toHaveBeenCalled();
  });

  it('shows the server reason and pins it to the email field when the email is already registered (409)', async () => {
    const user = userEvent.setup();
    render(<LoginPage />);

    await switchMode(user, /Create account/i);
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/system-settings/public')) {
        return createJsonResponse({ timezone: 'UTC', allowSignup: true }, 200);
      }
      if (url.includes('/api/auth/signup')) {
        return createJsonResponse({ error: 'Email already registered.' }, 409);
      }
      return createJsonResponse({}, 500);
    });

    fireEvent.change(screen.getByLabelText('First Name'), { target: { value: 'Linus' } });
    fireEvent.change(screen.getByLabelText('Last Name'), { target: { value: 'Torvalds' } });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'linus@example.com' } });
    fireEvent.change(screen.getByLabelText(/^Password$/), { target: { value: 'StrongPass1!' } });
    fireEvent.change(screen.getByLabelText('Confirm Password'), {
      target: { value: 'StrongPass1!' },
    });

    await user.click(getSubmitButton(SIGNUP_SUBMIT_LABEL));

    await waitFor(() =>
      expect(showToastErrorMock).toHaveBeenCalledWith('Email already registered.'),
    );
    // stays on the signup form, does not bounce to login
    expect(screen.getByLabelText('Confirm Password')).toBeInTheDocument();
    expect(signInMock).not.toHaveBeenCalled();
  });

  it('shows the domain-not-allowed reason without treating a 403 as "signups disabled"', async () => {
    const user = userEvent.setup();
    render(<LoginPage />);

    await switchMode(user, /Create account/i);
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/system-settings/public')) {
        return createJsonResponse({ timezone: 'UTC', allowSignup: true }, 200);
      }
      if (url.includes('/api/auth/signup')) {
        return createJsonResponse(
          { error: 'Email domain not allowed. Allowed domains: psu.edu' },
          403,
        );
      }
      return createJsonResponse({}, 500);
    });

    fireEvent.change(screen.getByLabelText('First Name'), { target: { value: 'Linus' } });
    fireEvent.change(screen.getByLabelText('Last Name'), { target: { value: 'Torvalds' } });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'linus@gmail.com' } });
    fireEvent.change(screen.getByLabelText(/^Password$/), { target: { value: 'StrongPass1!' } });
    fireEvent.change(screen.getByLabelText('Confirm Password'), {
      target: { value: 'StrongPass1!' },
    });

    await user.click(getSubmitButton(SIGNUP_SUBMIT_LABEL));

    await waitFor(() =>
      expect(showToastErrorMock).toHaveBeenCalledWith(
        'Email domain not allowed. Allowed domains: psu.edu',
      ),
    );
    // must NOT have been kicked to the login form
    expect(screen.getByLabelText('Confirm Password')).toBeInTheDocument();
  });

  it('shows slowdown toast when signup route responds with 428', async () => {
    const user = userEvent.setup();
    render(<LoginPage />);

    await switchMode(user, /Create account/i);
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/system-settings/public')) {
        return createJsonResponse({ timezone: 'UTC', allowSignup: true }, 200);
      }
      if (url.includes('/api/auth/signup')) {
        return createJsonResponse({}, 428);
      }
      return createJsonResponse({}, 500);
    });

    fireEvent.change(screen.getByLabelText('First Name'), { target: { value: 'Linus' } });
    fireEvent.change(screen.getByLabelText('Last Name'), { target: { value: 'Torvalds' } });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'linus@example.com' } });
    fireEvent.change(screen.getByLabelText(/^Password$/), { target: { value: 'StrongPass1!' } });
    fireEvent.change(screen.getByLabelText('Confirm Password'), {
      target: { value: 'StrongPass1!' },
    });

    await user.click(getSubmitButton(SIGNUP_SUBMIT_LABEL));

    await waitFor(() =>
      expect(showToastErrorMock).toHaveBeenCalledWith(
        'Unusual activity detected. Complete the security check below to continue.',
      ),
    );
    expect(signInMock).not.toHaveBeenCalled();
  });

  it('shows rate limit toast when signup route responds with 429', async () => {
    const user = userEvent.setup();
    render(<LoginPage />);

    await switchMode(user, /Create account/i);
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/system-settings/public')) {
        return createJsonResponse({ timezone: 'UTC', allowSignup: true }, 200);
      }
      if (url.includes('/api/auth/signup')) {
        return createJsonResponse({}, 429);
      }
      return createJsonResponse({}, 500);
    });

    fireEvent.change(screen.getByLabelText('First Name'), { target: { value: 'Linus' } });
    fireEvent.change(screen.getByLabelText('Last Name'), { target: { value: 'Torvalds' } });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'linus@example.com' } });
    fireEvent.change(screen.getByLabelText(/^Password$/), { target: { value: 'StrongPass1!' } });
    fireEvent.change(screen.getByLabelText('Confirm Password'), {
      target: { value: 'StrongPass1!' },
    });

    await user.click(getSubmitButton(SIGNUP_SUBMIT_LABEL));

    await waitFor(() =>
      expect(showToastErrorMock).toHaveBeenCalledWith(
        'Too many signup attempts. Please try again later.',
      ),
    );
    expect(signInMock).not.toHaveBeenCalled();
  });

  it('shows disabled message when signup route responds with 403', async () => {
    const user = userEvent.setup();
    render(<LoginPage />);

    await switchMode(user, /Create account/i);
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/system-settings/public')) {
        return createJsonResponse({ timezone: 'UTC', allowSignup: true }, 200);
      }
      if (url.includes('/api/auth/signup')) {
        return createJsonResponse({ error: 'Signup is disabled.' }, 403);
      }
      return createJsonResponse({}, 500);
    });

    fireEvent.change(screen.getByLabelText('First Name'), { target: { value: 'Linus' } });
    fireEvent.change(screen.getByLabelText('Last Name'), { target: { value: 'Torvalds' } });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'linus@example.com' } });
    fireEvent.change(screen.getByLabelText(/^Password$/), { target: { value: 'StrongPass1!' } });
    fireEvent.change(screen.getByLabelText('Confirm Password'), {
      target: { value: 'StrongPass1!' },
    });

    await user.click(getSubmitButton(SIGNUP_SUBMIT_LABEL));

    await waitFor(() => expect(showToastErrorMock).toHaveBeenCalledWith('Signup is disabled.'));
    expect(signInMock).not.toHaveBeenCalled();
  });
});

/**
 * What an institutional refusal leaves behind on this page.
 *
 * The callback sends people back to `/login?error=oidc&reason=...`, and the Auth.js client
 * reads an `error` parameter *in the URL a sign-in returns* as that sign-in having failed. With
 * the destination left to default, Auth.js echoes this very page, so every password sign-in
 * afterwards was reported as wrong credentials while the server had signed the person in.
 */
describe('signing in with a password after an institutional refusal', () => {
  beforeEach(() => {
    searchState.current = new URLSearchParams('error=oidc&reason=email-not-verified');
    window.history.replaceState({}, '', '/login?error=oidc&reason=email-not-verified');
  });

  it('tells the sign-in where to go, rather than letting this page decide', async () => {
    signInMock.mockResolvedValueOnce({ error: null });
    const user = userEvent.setup();

    render(<LoginPage />);

    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'admin@example.com' } });
    fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: 'StrongPass1!' } });
    await waitFor(() => expect(getSubmitButton(LOGIN_SUBMIT_LABEL)).not.toBeDisabled());
    await user.click(getSubmitButton(LOGIN_SUBMIT_LABEL));

    await waitFor(() =>
      expect(signInMock).toHaveBeenCalledWith(
        'credentials',
        expect.objectContaining({ callbackUrl: '/dashboard' }),
      ),
    );
  });

  it('takes the message out of the address bar once it has been shown', async () => {
    // Asserted on the rewrite rather than on `location`, which this suite stubs.
    const replaceState = vi.spyOn(window.history, 'replaceState');

    render(<LoginPage />);

    await waitFor(() => expect(showToastErrorMock).toHaveBeenCalled());
    await waitFor(() => expect(replaceState).toHaveBeenCalled());
    const rewritten = String(replaceState.mock.calls.at(-1)?.[2] ?? '');
    expect(rewritten).not.toContain('error=');
    expect(rewritten).not.toContain('reason=');
    replaceState.mockRestore();
  });
});

/**
 * The split-screen redesign, asserted on structure rather than on classes.
 *
 * These are the parts of the new layout that are behaviour: which heading the page has, that
 * the picture is decoration, and above all that a production build ships none of the
 * development shortcuts. The rest of the design is appearance and belongs in front of a human.
 */
describe('the sign-in screen', () => {
  it('has one h1, and it changes its words rather than being replaced', async () => {
    const user = userEvent.setup();
    render(<LoginPage />);

    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Welcome to AFCT');

    await switchMode(user, /Create account/i);

    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Create your account');
  });

  it('names the brand panel and keeps every mark in it out of the accessibility tree', () => {
    render(<LoginPage />);

    const panel = screen.getByRole('region', { name: 'About AFCT' });
    const marks = panel.querySelectorAll('svg');
    expect(marks.length).toBeGreaterThan(0);
    for (const mark of marks) {
      expect(mark).toHaveAttribute('aria-hidden', 'true');
    }
  });

  it('carries the product name for the narrow layout without adding a second heading', () => {
    render(<LoginPage />);

    // The compact header the phone layout shows in place of the brand panel. Deliberately
    // not a heading: the form's title is the page's one h1.
    expect(screen.getByText('AFCT Dashboard')).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  it('offers the seeded-account shortcuts in a development build', () => {
    render(<LoginPage />);

    expect(screen.getByText('Dev build')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Admin' })).toBeInTheDocument();
  });

  it('ships no development markup at all in a production build', () => {
    vi.stubEnv('NODE_ENV', 'production');
    try {
      const { container } = render(<LoginPage />);

      expect(screen.queryByText('Dev build')).toBeNull();
      expect(screen.queryByRole('button', { name: 'Admin' })).toBeNull();
      // Not merely hidden. The four seeded accounts share one password, and neither it nor
      // their addresses may reach a real deployment's HTML.
      expect(container.innerHTML).not.toContain('password123');
      expect(container.innerHTML).not.toContain('@example.com');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('offers the reset link only where the site can send the mail', () => {
    const { unmount } = render(<LoginPage mailConfigured={false} />);
    expect(screen.queryByRole('link', { name: /forgot password/i })).toBeNull();
    unmount();

    render(<LoginPage mailConfigured />);
    expect(screen.getByRole('link', { name: /forgot password/i })).toHaveAttribute(
      'href',
      '/forgot-password',
    );
  });

  it('leaves out the divider as well as the button when no provider is configured', () => {
    const { unmount } = render(<LoginPage oidcButtonLabel={null} />);
    expect(screen.queryByText('or')).toBeNull();
    unmount();

    render(<LoginPage oidcButtonLabel="Sign in with Penn State" />);
    expect(screen.getByText('or')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in with Penn State' })).toBeInTheDocument();
  });

  it('sends an institutional sign-in to the same sanitised destination', async () => {
    const user = userEvent.setup();
    render(<LoginPage oidcButtonLabel="Sign in with Penn State" />);

    await user.click(screen.getByRole('button', { name: 'Sign in with Penn State' }));

    expect(signInMock).toHaveBeenCalledWith('oidc', { callbackUrl: '/dashboard' });
  });
});

/**
 * The sign-in transition, from this side of it.
 *
 * The page leaves two things behind on its way to the dashboard: a full-screen wipe that
 * covers what the reader is looking at, and a one-shot sessionStorage flag that tells the
 * dashboard to pick the movement up. Neither may appear unless the credentials were actually
 * accepted, because both of them say "you are in" before the browser has gone anywhere.
 */
describe('the exit to the dashboard', () => {
  const TRANSITION_KEY = 'afct-login-transition';

  const overlay = () => document.querySelector('.auth-exit-overlay');
  const armed = () => window.sessionStorage.getItem(TRANSITION_KEY);

  const signIn = async (user: ReturnType<typeof userEvent.setup>) => {
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'admin@example.com' } });
    fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: 'StrongPass1!' } });
    await user.click(getSubmitButton(LOGIN_SUBMIT_LABEL));
  };

  it('covers the page and arms the dashboard once the credentials are accepted', async () => {
    signInMock.mockResolvedValueOnce({ error: null });
    const user = userEvent.setup();
    render(<LoginPage />);

    await signIn(user);

    await waitFor(() => expect(overlay()).toBeInTheDocument());
    expect(armed()).toBe('true');
    // Decorative: it says nothing to a screen reader and cannot be clicked through to.
    expect(overlay()).toHaveAttribute('aria-hidden', 'true');
    // And the destination is unchanged by any of it.
    await waitFor(() => expect(window.location.href).toBe('/dashboard'));
  });

  it('blocks a second submit while the page is on its way out', async () => {
    signInMock.mockResolvedValueOnce({ error: null });
    const user = userEvent.setup();
    render(<LoginPage />);

    await signIn(user);
    await waitFor(() => expect(overlay()).toBeInTheDocument());

    const button = getSubmitButton(/Signed in/i);
    expect(button).toBeDisabled();
    fireEvent.submit(button.closest('form') as HTMLFormElement);

    expect(signInMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['bad credentials', 'ok' as const],
    ['a captcha challenge', 'challenge' as const],
    ['a rate-limit block', 'blocked' as const],
  ])('starts nothing after %s', async (_label, status) => {
    setLoginCheckStatus(status);
    signInMock.mockResolvedValueOnce({ error: 'CredentialsSignin' });
    const user = userEvent.setup();
    render(<LoginPage />);

    await signIn(user);

    await waitFor(() => expect(signInMock).toHaveBeenCalled());
    expect(overlay()).toBeNull();
    expect(armed()).toBeNull();
    expect(window.location.href).toBe('');
  });

  it('starts nothing when the form never gets as far as signing in', async () => {
    const user = userEvent.setup();
    render(<LoginPage />);

    await user.click(getSubmitButton(LOGIN_SUBMIT_LABEL));

    expect(signInMock).not.toHaveBeenCalled();
    expect(overlay()).toBeNull();
    expect(armed()).toBeNull();
  });

  /**
   * Skipped, not shortened. Nothing is drawn and nothing is left for the dashboard to draw
   * either, so the whole movement is absent rather than played quickly.
   */
  it('goes straight to the dashboard under reduced motion', async () => {
    reduceMotionRef.value = true;
    signInMock.mockResolvedValueOnce({ error: null });
    const user = userEvent.setup();
    render(<LoginPage />);

    await signIn(user);

    await waitFor(() => expect(window.location.href).toBe('/dashboard'));
    expect(overlay()).toBeNull();
    expect(armed()).toBeNull();
  });

  it('is the same exit after a successful signup', async () => {
    const user = userEvent.setup();
    render(<LoginPage />);
    await switchMode(user, /Create account/i);

    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/auth/signup')) return createJsonResponse({}, 200);
      return createJsonResponse({ timezone: 'UTC', allowSignup: true }, 200);
    });
    signInMock.mockResolvedValue({ error: null });

    fireEvent.change(screen.getByLabelText('First Name'), { target: { value: 'Grace' } });
    fireEvent.change(screen.getByLabelText('Last Name'), { target: { value: 'Hopper' } });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'grace@example.com' } });
    fireEvent.change(screen.getByLabelText(/^Password$/), { target: { value: 'StrongPass1!' } });
    fireEvent.change(screen.getByLabelText('Confirm Password'), {
      target: { value: 'StrongPass1!' },
    });

    await user.click(getSubmitButton(SIGNUP_SUBMIT_LABEL));

    await waitFor(() => expect(overlay()).toBeInTheDocument());
    expect(armed()).toBe('true');
    await waitFor(() => expect(window.location.href).toBe('/dashboard'));
  });
});
