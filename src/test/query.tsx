import React from 'react';
import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * Render a component that reads through TanStack Query.
 *
 * A fresh client per call, so nothing carries between tests, with retries off (a test that
 * asserts an error path should not wait for the app's retry-once default) and `gcTime: 0` so
 * an unmounted entry cannot be served to the next render.
 *
 * Named rather than shadowing `render`, matching `CalendarClient.test.tsx`, so a reader can
 * see at the call site that the component needs a provider.
 */
export function renderWithClient(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return { client, ...render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>) };
}
