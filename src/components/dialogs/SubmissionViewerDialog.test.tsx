/** @vitest-environment jsdom */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

// Stub each underlying viewer so we can assert which one the selector renders.
vi.mock('@/components/JffViewerDialog', () => ({
  default: ({
    windowTarget,
  }: {
    windowTarget?: { href: string; tab: { file: string } } | null;
  }) => (
    <div
      data-testid="jff-viewer"
      data-window-href={windowTarget?.href ?? ''}
      data-window-tab={windowTarget?.tab.file ?? ''}
    />
  ),
}));
vi.mock('@/components/dialogs/RegexViewerDialog', () => ({
  RegexViewerDialog: ({
    windowTarget,
  }: {
    windowTarget?: { href: string; tab: { file: string } } | null;
  }) => (
    <div
      data-testid="regex-viewer"
      data-window-href={windowTarget?.href ?? ''}
      data-window-tab={windowTarget?.tab.file ?? ''}
    />
  ),
}));
vi.mock('@/components/dialogs/CfgViewerDialog', () => ({
  CfgViewerDialog: ({
    windowTarget,
  }: {
    windowTarget?: { href: string; tab: { file: string } } | null;
  }) => (
    <div
      data-testid="cfg-viewer"
      data-window-href={windowTarget?.href ?? ''}
      data-window-tab={windowTarget?.tab.file ?? ''}
    />
  ),
}));

import { SubmissionViewerDialog } from './SubmissionViewerDialog';

const baseProps = {
  open: true,
  onOpenChange: vi.fn(),
  src: '/file',
  title: 'A submission',
};

describe('SubmissionViewerDialog', () => {
  it.each(['FA', 'PDA', 'TM'])('renders the JFLAP viewer for %s', (type) => {
    render(<SubmissionViewerDialog {...baseProps} problemType={type} />);
    expect(screen.getByTestId('jff-viewer')).toBeTruthy();
  });

  it('renders the regex viewer for RE', () => {
    render(<SubmissionViewerDialog {...baseProps} problemType="RE" />);
    expect(screen.getByTestId('regex-viewer')).toBeTruthy();
  });

  it('renders the grammar viewer for CFG', () => {
    render(<SubmissionViewerDialog {...baseProps} problemType="CFG" />);
    expect(screen.getByTestId('cfg-viewer')).toBeTruthy();
  });

  it('renders nothing for an unknown or missing type', () => {
    const { container: unknown } = render(
      <SubmissionViewerDialog {...baseProps} problemType="ZZZ" />,
    );
    expect(unknown.querySelector('[data-testid]')).toBeNull();

    const { container: missing } = render(
      <SubmissionViewerDialog {...baseProps} problemType={null} />,
    );
    expect(missing.querySelector('[data-testid]')).toBeNull();
  });
});

describe('the link to the standalone window', () => {
  const fileSrc = '/api/files/submissions/abc.jff';

  it.each([
    ['FA', 'jff-viewer'],
    ['RE', 'regex-viewer'],
    ['CFG', 'cfg-viewer'],
  ])('is passed to the %s viewer when the file can be linked to', (type, testId) => {
    render(<SubmissionViewerDialog {...baseProps} src={fileSrc} problemType={type} />);
    const href = screen.getByTestId(testId).getAttribute('data-window-href') ?? '';
    expect(href).toContain('/viewer?');
    expect(href).toContain('kind=submissions');
    expect(href).toContain(`type=${type}`);
    // The tab the window is asked to open, which is what an already-open window is sent.
    expect(screen.getByTestId(testId).getAttribute('data-window-tab')).toBe('abc.jff');
  });

  it('is absent when the source is not one of the file routes', () => {
    // The dialog still works; it simply offers no button, rather than one that would fail
    // once the window had already opened.
    render(<SubmissionViewerDialog {...baseProps} src="/file" problemType="FA" />);
    expect(screen.getByTestId('jff-viewer').getAttribute('data-window-href')).toBe('');
  });
});

/**
 * The standalone viewer window is a staff tool. A student is reading one attempt of their
 * own, where the preview is the whole job.
 *
 * Asserted through the viewer's `windowTarget` prop, which is what each dialog turns into the
 * button: a null target is already how "no button" is expressed everywhere else.
 */
describe('who is offered the standalone viewer window', () => {
  const renderWith = (props: Record<string, unknown>) =>
    render(
      <SubmissionViewerDialog
        open
        onOpenChange={() => {}}
        problemType="FA"
        src="/api/files/submissions/a.jff"
        title="Traffic Light"
        {...props}
      />,
    );

  it('offers it by default, which is the staff surfaces', () => {
    renderWith({});
    expect(screen.getByTestId('jff-viewer').getAttribute('data-window-href')).not.toBe('');
  });

  it('withholds it when the caller says not to', () => {
    renderWith({ allowOpenInWindow: false });
    expect(screen.getByTestId('jff-viewer').getAttribute('data-window-href')).toBe('');
  });
});
