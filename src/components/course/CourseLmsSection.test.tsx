/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';

import { CourseLmsSection } from './CourseLmsSection';
import { renderWithClient } from '@/test/query';

vi.mock('@/components/course/RosterSyncDialog', () => ({
  RosterSyncDialog: ({ open }: { open: boolean }) => (open ? <div>sync dialog</div> : null),
}));
vi.mock('@/hooks/use-effective-timezone', () => ({
  useEffectiveTimezone: () => ({ timezone: 'UTC', hour12: false }),
}));

const link = (over: Record<string, unknown> = {}) => ({
  id: 'link-1',
  platformName: 'Canvas',
  contextTitle: 'Introduction to the Theory of Computation, Section 002',
  contextId: 'ctx-1',
  linkedAt: '2026-08-01T14:00:00.000Z',
  canSendGrades: true,
  linkedBy: 'Jeffrey Chiampi',
  ...over,
});

const answering = (links: unknown[]) =>
  vi.fn().mockResolvedValue({ ok: true, json: async () => ({ links }) } as Response);

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

/**
 * This lives in the Settings tab's rail, beside Course Status, on a 288px column. jsdom does
 * no layout, so what is worth pinning is what the width decides: the whole LMS course name
 * is present rather than cut short, and each connection carries its own Disconnect.
 */
describe('the LMS connection card', () => {
  it('names the card so the rail is not two anonymous boxes', async () => {
    vi.stubGlobal('fetch', answering([link()]));

    renderWithClient(<CourseLmsSection courseId="c-1" />);

    const card = await screen.findByRole('complementary', { name: 'Connected to your LMS' });
    expect(within(card).getByRole('heading', { level: 3 })).toBeVisible();
  });

  it('keeps the whole LMS course name, and says where it came from', async () => {
    vi.stubGlobal('fetch', answering([link()]));

    renderWithClient(<CourseLmsSection courseId="c-1" />);

    expect(
      await screen.findByText('Introduction to the Theory of Computation, Section 002'),
    ).toBeInTheDocument();
    expect(screen.getByText(/Canvas, connected by Jeffrey Chiampi/)).toBeInTheDocument();
  });

  it('gives every connection its own Disconnect, and the card one roster sync', async () => {
    vi.stubGlobal(
      'fetch',
      answering([link(), link({ id: 'link-2', contextTitle: 'Section 003' })]),
    );

    renderWithClient(<CourseLmsSection courseId="c-1" />);

    expect(await screen.findAllByRole('button', { name: /Disconnect/ })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: /Sync roster/ })).toHaveLength(1);
  });

  /** A connection that cannot carry grades yet looks identical otherwise, so it has to say so. */
  it('says when grades cannot be sent yet', async () => {
    vi.stubGlobal('fetch', answering([link({ canSendGrades: false })]));

    renderWithClient(<CourseLmsSection courseId="c-1" />);

    expect(await screen.findByText(/Grades cannot be sent yet/)).toBeInTheDocument();
  });

  it('shows nothing at all on a course no LMS opens', async () => {
    const fetchMock = answering([]);
    vi.stubGlobal('fetch', fetchMock);

    const { container } = renderWithClient(<CourseLmsSection courseId="c-1" />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});
