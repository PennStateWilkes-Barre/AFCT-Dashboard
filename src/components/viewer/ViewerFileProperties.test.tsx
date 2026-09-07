/** @vitest-environment jsdom */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { ViewerFileProperties } from './ViewerFileProperties';

const PROPERTIES = {
  rows: [
    { label: 'Course', value: 'CMPEN 331 Automata' },
    { label: 'Assignment', value: 'Homework 2' },
    { label: 'Student', value: 'Ada Lovelace' },
    { label: 'Submitted', value: '2026-03-04 09:05 UTC' },
  ],
};

describe('the toolbar Properties button', () => {
  // The same rows the File menu's Properties dialog shows. Both are offered on purpose; see
  // the component's own note.

  it('says nothing until it is asked', () => {
    render(<ViewerFileProperties properties={PROPERTIES} />);

    expect(screen.getByRole('button', { name: 'File properties' })).toBeInTheDocument();
    expect(screen.queryByText('CMPEN 331 Automata')).toBeNull();
  });

  it('lists every row the server sent, as a label and a value', async () => {
    const user = userEvent.setup();
    render(<ViewerFileProperties properties={PROPERTIES} />);

    await user.click(screen.getByRole('button', { name: 'File properties' }));

    for (const row of PROPERTIES.rows) {
      expect(await screen.findByText(row.label)).toBeInTheDocument();
      expect(screen.getByText(row.value)).toBeInTheDocument();
    }
  });

  /**
   * It renders whatever `rows` carries and knows nothing about what those are, which is what
   * keeps the decision about what a reader may see in `loadViewerProperties` alone. This is
   * the test that would fail if this component ever grew opinions of its own.
   */
  it('shows exactly what it was handed, in the order it was handed it', async () => {
    const user = userEvent.setup();
    render(
      <ViewerFileProperties properties={{ rows: [{ label: 'Anything', value: 'at all' }] }} />,
    );

    await user.click(screen.getByRole('button', { name: 'File properties' }));

    const labels = (await screen.findByRole('definition')).parentElement;
    expect(labels).toHaveTextContent('Anythingat all');
  });

  it('is disabled rather than hidden when the server had nothing to say', () => {
    // Unknown file, or one that is not this reader's to see. The toolbar keeps its shape
    // between files so the button stays where it was learned.
    render(<ViewerFileProperties properties={null} />);

    expect(screen.getByRole('button', { name: 'File properties' })).toBeDisabled();
  });
});
