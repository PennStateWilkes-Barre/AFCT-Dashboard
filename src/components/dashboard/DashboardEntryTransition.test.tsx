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
  document.body.innerHTML = '<div id="afct-entry-overlay" hidden></div>';
  setReducedMotion(false);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const overlay = () => document.getElementById('afct-entry-overlay') as HTMLElement;
const entering = () => document.documentElement.hasAttribute('data-afct-entering');

describe('the dashboard entry script', () => {
  it('does nothing on an ordinary dashboard load', () => {
    runEntryScript();
    expect(entering()).toBe(false);
    expect(overlay().hidden).toBe(true);
  });

  it('plays once when the login page armed it, then clears the flag', () => {
    window.sessionStorage.setItem(LOGIN_TRANSITION_KEY, 'true');

    runEntryScript();
    expect(entering()).toBe(true);
    expect(overlay().hidden).toBe(false);
    // Cleared on read: a refresh, a back-navigation or the next visit must not replay it.
    expect(window.sessionStorage.getItem(LOGIN_TRANSITION_KEY)).toBeNull();

    // Second load of the dashboard in the same session.
    document.documentElement.removeAttribute('data-afct-entering');
    overlay().hidden = true;
    runEntryScript();
    expect(entering()).toBe(false);
    expect(overlay().hidden).toBe(true);
  });

  it('tidies up after itself once the animation is over', () => {
    window.sessionStorage.setItem(LOGIN_TRANSITION_KEY, 'true');
    runEntryScript();

    vi.advanceTimersByTime(1000);
    expect(entering()).toBe(false);
    expect(overlay().hidden).toBe(true);
  });

  /**
   * Skipped entirely, not shortened. The flag is still consumed so it cannot fire later.
   */
  it('shows nothing under prefers-reduced-motion', () => {
    setReducedMotion(true);
    window.sessionStorage.setItem(LOGIN_TRANSITION_KEY, 'true');

    runEntryScript();

    expect(entering()).toBe(false);
    expect(overlay().hidden).toBe(true);
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
