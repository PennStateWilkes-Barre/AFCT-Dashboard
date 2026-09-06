// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOGIN_TRANSITION_KEY } from '@/lib/login-transition';
import { DASHBOARD_ENTRY_SCRIPT } from './DashboardEntryTransition';

/**
 * The dashboard's half of the sign-in transition is an inline script, because it has to run
 * before the dashboard paints and therefore before React exists on the page. That puts it out
 * of reach of a render test, so these run the script itself, which is the thing that ships.
 */

const runEntryScript = () => new Function(DASHBOARD_ENTRY_SCRIPT)();

const setReducedMotion = (reduce: boolean) => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({ matches: reduce, media: query }),
  });
};

beforeEach(() => {
  vi.useFakeTimers();
  window.sessionStorage.clear();
  document.documentElement.removeAttribute('data-afct-entering');
  setReducedMotion(false);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// The overlay itself is inert markup: CSS shows it only while this attribute is present, so
// the attribute is the whole of the script's visible effect.
const entering = () => document.documentElement.hasAttribute('data-afct-entering');

describe('the dashboard entry script', () => {
  it('does nothing on an ordinary dashboard load', () => {
    runEntryScript();
    expect(entering()).toBe(false);
  });

  it('plays once when the login page armed it, then clears the flag', () => {
    window.sessionStorage.setItem(LOGIN_TRANSITION_KEY, 'true');

    runEntryScript();
    expect(entering()).toBe(true);
    // Cleared on read: a refresh, a back-navigation or the next visit must not replay it.
    expect(window.sessionStorage.getItem(LOGIN_TRANSITION_KEY)).toBeNull();

    // Second load of the dashboard in the same session.
    document.documentElement.removeAttribute('data-afct-entering');
    runEntryScript();
    expect(entering()).toBe(false);
  });

  it('tidies up after itself once the animation is over', () => {
    window.sessionStorage.setItem(LOGIN_TRANSITION_KEY, 'true');
    runEntryScript();

    vi.advanceTimersByTime(1000);
    expect(entering()).toBe(false);
  });

  /**
   * Skipped entirely, not shortened. The flag is still consumed so it cannot fire later.
   */
  it('shows nothing under prefers-reduced-motion', () => {
    setReducedMotion(true);
    window.sessionStorage.setItem(LOGIN_TRANSITION_KEY, 'true');

    runEntryScript();

    expect(entering()).toBe(false);
    expect(window.sessionStorage.getItem(LOGIN_TRANSITION_KEY)).toBeNull();
  });

  it('gives up quietly when storage is unavailable', () => {
    vi.spyOn(window.sessionStorage, 'getItem').mockImplementation(() => {
      throw new Error('storage disabled');
    });
    expect(() => runEntryScript()).not.toThrow();
    expect(entering()).toBe(false);
  });
});
