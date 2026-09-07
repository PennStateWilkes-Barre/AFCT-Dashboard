// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOGIN_TRANSITION_KEY, markLoginTransition } from './login-transition';

afterEach(() => {
  vi.restoreAllMocks();
  window.sessionStorage.clear();
});

describe('markLoginTransition', () => {
  it('arms the flag the dashboard looks for', () => {
    markLoginTransition();
    expect(window.sessionStorage.getItem(LOGIN_TRANSITION_KEY)).toBe('true');
  });

  /**
   * Storage is not always there. A private window, a browser told to block site data, or an
   * embedded context can all make `sessionStorage` throw on access rather than return null,
   * and this runs in the middle of a successful sign-in. A decorative animation must never be
   * the reason somebody cannot get in.
   */
  it('does not throw when storage is unavailable', () => {
    vi.spyOn(window.sessionStorage, 'setItem').mockImplementation(() => {
      throw new Error('storage disabled');
    });
    expect(() => markLoginTransition()).not.toThrow();
  });
});
