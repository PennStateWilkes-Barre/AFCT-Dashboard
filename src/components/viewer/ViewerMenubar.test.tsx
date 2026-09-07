/** @vitest-environment jsdom */
import React from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ViewerMenubar } from './ViewerMenubar';
import {
  ViewerActionsGate,
  ViewerActionsProvider,
  useRegisterViewerActions,
} from './viewer-actions';

const actions = {
  downloadSVG: vi.fn(),
  downloadPNG: vi.fn(),
  copyPNG: vi.fn(),
  downloadCurrent: vi.fn(),
  copySVG: vi.fn(),
  undo: vi.fn(),
  redo: vi.fn(),
  toggleGrid: vi.fn(),
  toggleNotes: vi.fn(),
  toggleSnapToGrid: vi.fn(),
  fitToWindow: vi.fn(),
  showTextRepresentation: vi.fn(),
  setAsDrawn: vi.fn(),
  setAutoArranged: vi.fn(),
  resetMachine: vi.fn(),
  centerInWindow: vi.fn(),
};

/** Stands in for a rendered machine that publishes its actions and its view state. */
function FakeViewer({
  grid = false,
  notes = true,
  snapToGrid = false,
  layout = 'as-drawn',
  canUndo = false,
  canRedo = false,
}: {
  grid?: boolean;
  notes?: boolean;
  snapToGrid?: boolean;
  layout?: 'as-drawn' | 'auto';
  canUndo?: boolean;
  canRedo?: boolean;
}) {
  useRegisterViewerActions(actions, { grid, notes, snapToGrid, layout, canUndo, canRedo });
  return null;
}

const openFile = async (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getByRole('menuitem', { name: 'File' }));

describe('the standalone viewer menu bar', () => {
  it('offers the original file as a download, marked as one', async () => {
    // ?download=1 is what makes the file route record a download rather than a view. The two
    // are deliberately different access events, so the link must carry it.
    const user = userEvent.setup();
    render(
      <ViewerActionsProvider>
        <ViewerMenubar downloadHref="/api/files/submissions/abc.jff?download=1" />
      </ViewerActionsProvider>,
    );
    await openFile(user);
    await user.click(await screen.findByRole('menuitem', { name: 'Download' }));
    const link = await screen.findByRole('menuitem', { name: /original file/i });
    expect(link).toHaveAttribute('href', '/api/files/submissions/abc.jff?download=1');
  });

  it('offers the current view as a separate download', async () => {
    // Two distinct things: what the student submitted, and what is on screen after the layout
    // engine has had a go at it. Collapsing them into one item would hide that difference.
    const user = userEvent.setup();
    render(
      <ViewerActionsProvider>
        <FakeViewer />
        <ViewerMenubar downloadHref="/x?download=1" />
      </ViewerActionsProvider>,
    );
    await openFile(user);
    await user.click(await screen.findByRole('menuitem', { name: 'Download' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /current view/i }));
    expect(actions.downloadCurrent).toHaveBeenCalledTimes(1);
  });

  it('still offers the original when nothing is drawn, since that needs no graph', async () => {
    // A grammar has no rendered machine, so there is no current view to save. The submitted
    // file is still right there and must not be disabled with it.
    const user = userEvent.setup();
    render(
      <ViewerActionsProvider>
        <ViewerMenubar downloadHref="/x?download=1" />
      </ViewerActionsProvider>,
    );
    await openFile(user);
    await user.click(await screen.findByRole('menuitem', { name: 'Download' }));
    expect(await screen.findByRole('menuitem', { name: /original file/i })).not.toHaveAttribute(
      'data-disabled',
    );
    expect(await screen.findByRole('menuitem', { name: /current view/i })).toHaveAttribute(
      'data-disabled',
    );
  });

  it('runs the export the viewer registered', async () => {
    const user = userEvent.setup();
    render(
      <ViewerActionsProvider>
        <FakeViewer />
        <ViewerMenubar downloadHref="/x?download=1" />
      </ViewerActionsProvider>,
    );
    await openFile(user);
    await user.click(await screen.findByRole('menuitem', { name: 'Export' }));
    // fireEvent, not userEvent, for this one click. Radix decides whether an item is
    // clickable partly from pointer-events, which jsdom cannot compute without layout, so a
    // realistic click lands on a menu item that reports itself unclickable and onSelect
    // never runs. The item is not disabled (the case below proves the disabled path
    // separately), and a real browser has no such trouble.
    fireEvent.click(await screen.findByRole('menuitem', { name: 'SVG' }));
    expect(actions.downloadSVG).toHaveBeenCalledTimes(1);
  });

  it('disables the exports when nothing has registered, rather than hiding them', async () => {
    // A grammar or a regular expression has nothing to export. A missing item reads as a
    // bug; a disabled one reads as "not for this kind of file".
    const user = userEvent.setup();
    render(
      <ViewerActionsProvider>
        <ViewerMenubar downloadHref="/x?download=1" />
      </ViewerActionsProvider>,
    );
    await openFile(user);
    await user.click(await screen.findByRole('menuitem', { name: 'Export' }));
    expect(await screen.findByRole('menuitem', { name: 'PNG' })).toHaveAttribute('data-disabled');
  });
});

describe('the View menu', () => {
  const openView = (user: ReturnType<typeof userEvent.setup>) =>
    user.click(screen.getByRole('menuitem', { name: 'View' }));

  it('shows the grid ticked when the viewer has it on', async () => {
    // The menu reports the current state rather than only offering the action, so it cannot
    // disagree with the Grid button in the viewer's own toolbar.
    const user = userEvent.setup();
    render(
      <ViewerActionsProvider>
        <FakeViewer grid />
        <ViewerMenubar downloadHref="/x?download=1" />
      </ViewerActionsProvider>,
    );
    await openView(user);
    expect(await screen.findByRole('menuitemcheckbox', { name: 'Grid' })).toBeChecked();
  });

  it('shows it unticked when the viewer has it off', async () => {
    const user = userEvent.setup();
    render(
      <ViewerActionsProvider>
        <FakeViewer grid={false} />
        <ViewerMenubar downloadHref="/x?download=1" />
      </ViewerActionsProvider>,
    );
    await openView(user);
    expect(await screen.findByRole('menuitemcheckbox', { name: 'Grid' })).not.toBeChecked();
  });

  it('asks the viewer to toggle the grid when selected', async () => {
    const user = userEvent.setup();
    render(
      <ViewerActionsProvider>
        <FakeViewer />
        <ViewerMenubar downloadHref="/x?download=1" />
      </ViewerActionsProvider>,
    );
    await openView(user);
    // fireEvent for the same jsdom reason as the export case above.
    fireEvent.click(await screen.findByRole('menuitemcheckbox', { name: 'Grid' }));
    expect(actions.toggleGrid).toHaveBeenCalledTimes(1);
  });

  it('disables the toggle when no graph is rendered', async () => {
    const user = userEvent.setup();
    render(
      <ViewerActionsProvider>
        <ViewerMenubar downloadHref="/x?download=1" />
      </ViewerActionsProvider>,
    );
    await openView(user);
    expect(await screen.findByRole('menuitemcheckbox', { name: 'Grid' })).toHaveAttribute(
      'data-disabled',
    );
  });
});

/**
 * Which menu owns what.
 *
 * View answers "what can I see, and from how far away". Layout answers "where is everything".
 * They were one menu, and Snap to grid sitting under the grid's own visibility was the seam:
 * the two share a word and nothing else. The split is here so that aligning and distributing a
 * selection have somewhere to go that is not the toolbar.
 */
describe('View and Layout own different things', () => {
  const openMenu = (user: ReturnType<typeof userEvent.setup>, name: string) =>
    user.click(screen.getByRole('menuitem', { name }));

  const mount = () =>
    render(
      <ViewerActionsProvider>
        <FakeViewer />
        <ViewerMenubar downloadHref="/x?download=1" />
      </ViewerActionsProvider>,
    );

  it('keeps looking at the machine under View', async () => {
    const user = userEvent.setup();
    mount();

    await openMenu(user, 'View');

    // The camera, and what is drawn on top of it.
    expect(await screen.findByRole('menuitem', { name: /fit to window/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /center in window/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitemcheckbox', { name: 'Grid' })).toBeInTheDocument();
    expect(screen.getByRole('menuitemcheckbox', { name: 'JFLAP Notes' })).toBeInTheDocument();
    // Not the arrangement.
    expect(screen.queryByRole('menuitemcheckbox', { name: /snap to grid/i })).toBeNull();
    expect(screen.queryByRole('menuitemradio', { name: /auto-arranged/i })).toBeNull();
  });

  it('keeps where the states go under Layout', async () => {
    const user = userEvent.setup();
    mount();

    await openMenu(user, 'Layout');

    expect(await screen.findByRole('menuitemradio', { name: /as drawn/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitemradio', { name: /auto-arranged/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitemcheckbox', { name: /snap to grid/i })).toBeInTheDocument();
    // Not the camera, and not the grid's visibility.
    expect(screen.queryByRole('menuitemcheckbox', { name: 'Grid' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: /fit to window/i })).toBeNull();
  });

  it('leaves the Machine menu about the machine rather than its arrangement', async () => {
    const user = userEvent.setup();
    mount();

    await openMenu(user, 'Machine');

    expect(await screen.findByRole('menuitem', { name: /copy as png/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /reset machine/i })).toBeInTheDocument();
    expect(screen.queryByRole('menuitemradio', { name: /as drawn/i })).toBeNull();
  });
});

describe('copying the machine', () => {
  // Under Machine rather than Edit: what these copy is the drawing, not a selection.
  const openMachine = (user: ReturnType<typeof userEvent.setup>) =>
    user.click(screen.getByRole('menuitem', { name: 'Machine' }));

  const mountWithViewer = () =>
    render(
      <ViewerActionsProvider>
        <FakeViewer />
        <ViewerMenubar downloadHref="/x?download=1" />
      </ViewerActionsProvider>,
    );

  it.each([
    [/copy as png/i, 'copyPNG'],
    [/copy as svg/i, 'copySVG'],
  ] as const)('runs %s', async (name, action) => {
    const user = userEvent.setup();
    mountWithViewer();
    await openMachine(user);
    // fireEvent for the same jsdom reason as the export case above.
    fireEvent.click(await screen.findByRole('menuitem', { name }));
    expect(actions[action]).toHaveBeenCalledTimes(1);
  });

  it('offers the two image copies, and leaves the text one beside the text', async () => {
    // Copying the description moved next to the description itself, where it is wanted. If it
    // ever comes back here as well there would be two ways to do one thing.
    const user = userEvent.setup();
    mountWithViewer();
    await openMachine(user);
    const labels = (await screen.findAllByRole('menuitem')).map((i) => i.textContent);
    expect(labels.filter((l) => l?.startsWith('Copy as'))).toHaveLength(2);
    expect(labels).not.toContain('Copy as text');
  });

  it('is not left behind under Edit, which would be two ways to one thing', async () => {
    const user = userEvent.setup();
    mountWithViewer();
    await user.click(screen.getByRole('menuitem', { name: 'Edit' }));
    const labels = (await screen.findAllByRole('menuitem')).map((i) => i.textContent);
    expect(labels.filter((l) => l?.startsWith('Copy as'))).toHaveLength(0);
  });
});

describe('Layout, the arrangement choice', () => {
  const openLayout = async (user: ReturnType<typeof userEvent.setup>) =>
    user.click(screen.getByRole('menuitem', { name: 'Layout' }));

  it('marks exactly one of the two, never both', async () => {
    // The machine is drawn one way or the other. A pair of checkboxes could show neither or
    // both, which is why these are radio items.
    const user = userEvent.setup();
    render(
      <ViewerActionsProvider>
        <FakeViewer layout="auto" />
        <ViewerMenubar downloadHref="/x?download=1" />
      </ViewerActionsProvider>,
    );
    await openLayout(user);
    const items = await screen.findAllByRole('menuitemradio');
    expect(items.filter((i) => i.getAttribute('aria-checked') === 'true')).toHaveLength(1);
    expect(screen.getByRole('menuitemradio', { name: 'Auto-arranged' })).toBeChecked();
    expect(screen.getByRole('menuitemradio', { name: 'As drawn' })).not.toBeChecked();
  });

  it('follows the viewer when it is drawn as the author placed it', async () => {
    const user = userEvent.setup();
    render(
      <ViewerActionsProvider>
        <FakeViewer layout="as-drawn" />
        <ViewerMenubar downloadHref="/x?download=1" />
      </ViewerActionsProvider>,
    );
    await openLayout(user);
    expect(screen.getByRole('menuitemradio', { name: 'As drawn' })).toBeChecked();
  });

  it('asks for auto-arranging when that one is chosen', async () => {
    const user = userEvent.setup();
    render(
      <ViewerActionsProvider>
        <FakeViewer layout="as-drawn" />
        <ViewerMenubar downloadHref="/x?download=1" />
      </ViewerActionsProvider>,
    );
    await openLayout(user);
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Auto-arranged' }));
    expect(actions.setAutoArranged).toHaveBeenCalledTimes(1);
    expect(actions.setAsDrawn).not.toHaveBeenCalled();
  });
});

describe('View, Fit to window', () => {
  it('asks the viewer to fit the machine on screen', async () => {
    const user = userEvent.setup();
    render(
      <ViewerActionsProvider>
        <FakeViewer />
        <ViewerMenubar downloadHref="/x?download=1" />
      </ViewerActionsProvider>,
    );
    await user.click(screen.getByRole('menuitem', { name: 'View' }));
    // fireEvent for the same jsdom reason as the export case above.
    fireEvent.click(await screen.findByRole('menuitem', { name: /fit to window/i }));
    expect(actions.fitToWindow).toHaveBeenCalledTimes(1);
  });

  it('asks the viewer to centre the machine, which is the other half of it', async () => {
    // Two ways out of being lost on a large machine, and they are not the same: this one
    // keeps whatever the reader had zoomed to.
    const user = userEvent.setup();
    render(
      <ViewerActionsProvider>
        <FakeViewer />
        <ViewerMenubar downloadHref="/x?download=1" />
      </ViewerActionsProvider>,
    );
    actions.fitToWindow.mockClear();

    await user.click(screen.getByRole('menuitem', { name: 'View' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /center in window/i }));
    expect(actions.centerInWindow).toHaveBeenCalledTimes(1);
    expect(actions.fitToWindow).not.toHaveBeenCalled();
  });

  it('is unavailable when nothing is drawn', async () => {
    const user = userEvent.setup();
    render(
      <ViewerActionsProvider>
        <ViewerMenubar downloadHref="/x?download=1" />
      </ViewerActionsProvider>,
    );
    await user.click(screen.getByRole('menuitem', { name: 'View' }));
    expect(await screen.findByRole('menuitem', { name: /fit to window/i })).toHaveAttribute(
      'data-disabled',
    );
  });
});

describe('View, Text representation', () => {
  it('asks the viewer to show the machine written out', async () => {
    const user = userEvent.setup();
    render(
      <ViewerActionsProvider>
        <FakeViewer />
        <ViewerMenubar downloadHref="/x?download=1" />
      </ViewerActionsProvider>,
    );
    await user.click(screen.getByRole('menuitem', { name: 'View' }));
    // fireEvent for the same jsdom reason as the export case above.
    fireEvent.click(await screen.findByRole('menuitem', { name: /text representation/i }));
    expect(actions.showTextRepresentation).toHaveBeenCalledTimes(1);
  });
});

describe('View, JFLAP Notes', () => {
  const openView = (user: ReturnType<typeof userEvent.setup>) =>
    user.click(screen.getByRole('menuitem', { name: 'View' }));

  it('is ticked by default, because a note is part of the answer', async () => {
    const user = userEvent.setup();
    render(
      <ViewerActionsProvider>
        <FakeViewer />
        <ViewerMenubar downloadHref="/x?download=1" />
      </ViewerActionsProvider>,
    );
    await openView(user);
    expect(await screen.findByRole('menuitemcheckbox', { name: 'JFLAP Notes' })).toBeChecked();
  });

  it('follows the viewer when they are hidden', async () => {
    const user = userEvent.setup();
    render(
      <ViewerActionsProvider>
        <FakeViewer notes={false} />
        <ViewerMenubar downloadHref="/x?download=1" />
      </ViewerActionsProvider>,
    );
    await openView(user);
    expect(await screen.findByRole('menuitemcheckbox', { name: 'JFLAP Notes' })).not.toBeChecked();
  });

  it('asks the viewer to toggle them', async () => {
    const user = userEvent.setup();
    render(
      <ViewerActionsProvider>
        <FakeViewer />
        <ViewerMenubar downloadHref="/x?download=1" />
      </ViewerActionsProvider>,
    );
    await openView(user);
    // fireEvent for the same jsdom reason as the export case above.
    fireEvent.click(await screen.findByRole('menuitemcheckbox', { name: 'JFLAP Notes' }));
    expect(actions.toggleNotes).toHaveBeenCalledTimes(1);
  });
});

describe('the Help menu', () => {
  it('links to the published documentation for this viewer', async () => {
    const user = userEvent.setup();
    render(
      <ViewerActionsProvider>
        <ViewerMenubar downloadHref="/x?download=1" />
      </ViewerActionsProvider>,
    );
    await user.click(screen.getByRole('menuitem', { name: 'Help' }));
    const link = await screen.findByRole('menuitem', { name: /documentation/i });
    // The trailing slash is the canonical form; without it GitHub Pages answers a redirect.
    expect(link).toHaveAttribute('href', 'https://pennstatecs.github.io/AFCT/admin/submissions/');
  });

  it('opens it away from the window, without handing over an opener', async () => {
    // It leaves the application, so the new tab must not keep a handle back to this one.
    const user = userEvent.setup();
    render(
      <ViewerActionsProvider>
        <ViewerMenubar downloadHref="/x?download=1" />
      </ViewerActionsProvider>,
    );
    await user.click(screen.getByRole('menuitem', { name: 'Help' }));
    const link = await screen.findByRole('menuitem', { name: /documentation/i });
    expect(link).toHaveAttribute('target', '_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
  });

  it('is available even when no machine is drawn', async () => {
    // Help is about the window, not its contents. A grammar disables everything else in the
    // menus, and being unable to reach the documentation from there would be perverse.
    const user = userEvent.setup();
    render(
      <ViewerActionsProvider>
        <ViewerMenubar downloadHref="/x?download=1" />
      </ViewerActionsProvider>,
    );
    await user.click(screen.getByRole('menuitem', { name: 'Help' }));
    expect(await screen.findByRole('menuitem', { name: /documentation/i })).not.toHaveAttribute(
      'data-disabled',
    );
  });
});

describe('File, Properties', () => {
  const props = {
    rows: [
      { label: 'Course', value: 'CMPEN 331 Automata' },
      { label: 'Assignment', value: 'Homework 2' },
      { label: 'Submitted', value: '2026-03-04 09:05 UTC' },
    ],
  };

  it('shows where the file came from', async () => {
    const user = userEvent.setup();
    render(
      <ViewerActionsProvider>
        <ViewerMenubar downloadHref="/x?download=1" properties={props} />
      </ViewerActionsProvider>,
    );
    await user.click(screen.getByRole('menuitem', { name: 'File' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Properties' }));
    expect(await screen.findByText('CMPEN 331 Automata')).toBeInTheDocument();
    expect(screen.getByText('Homework 2')).toBeInTheDocument();
    expect(screen.getByText('2026-03-04 09:05 UTC')).toBeInTheDocument();
  });

  it('is disabled rather than hidden when there is nothing to show', async () => {
    // The menu keeps its shape between files. A vanishing item reads as a bug.
    const user = userEvent.setup();
    render(
      <ViewerActionsProvider>
        <ViewerMenubar downloadHref="/x?download=1" properties={null} />
      </ViewerActionsProvider>,
    );
    await user.click(screen.getByRole('menuitem', { name: 'File' }));
    expect(await screen.findByRole('menuitem', { name: 'Properties' })).toHaveAttribute(
      'data-disabled',
    );
  });

  it('does not need a drawn machine, since it describes the file not the picture', async () => {
    // A grammar disables the exports; where the file came from is still a fair question.
    const user = userEvent.setup();
    render(
      <ViewerActionsProvider>
        <ViewerMenubar downloadHref="/x?download=1" properties={props} />
      </ViewerActionsProvider>,
    );
    await user.click(screen.getByRole('menuitem', { name: 'File' }));
    expect(await screen.findByRole('menuitem', { name: 'Properties' })).not.toHaveAttribute(
      'data-disabled',
    );
  });
});

/**
 * The menu's icon conventions, which are easy to break one item at a time.
 *
 * A source check rather than a rendered one, because it is about what the file says rather
 * than what any single open menu shows, and a menu bar only renders the one menu that is open.
 */
describe('the menu uses icons consistently', () => {
  const source = () => readFileSync(path.resolve(__dirname, 'ViewerMenubar.tsx'), 'utf8');

  const itemsOf = (kind: string) => {
    const found: string[] = [];
    const re = new RegExp(`<${kind}\\b((?:.|\\n)*?)</${kind}>`, 'g');
    for (const m of source().matchAll(re)) found.push(m[1] ?? '');
    return found;
  };

  it('gives every plain item an icon, so none reads as an odd one out', () => {
    const items = itemsOf('MenubarItem');
    expect(items.length).toBeGreaterThan(5);
    for (const body of items) expect(body).toMatch(/<[A-Z]\w+ aria-hidden/);
  });

  it('gives the submenu triggers icons too, so a menu is not half iconned', () => {
    // Download, Export and Layout sit in the same column as items that all carry one. Leaving
    // them bare made those three lines start at a different place from every other.
    const triggers = itemsOf('MenubarSubTrigger');
    expect(triggers.length).toBeGreaterThan(1);
    for (const body of triggers) expect(body).toMatch(/<[A-Z]\w+ aria-hidden/);
  });

  it('gives the checkbox and radio items none, because that slot holds the tick', () => {
    // Radix draws the check or the dot in the leading slot. An icon there collides with it.
    for (const body of [...itemsOf('MenubarCheckboxItem'), ...itemsOf('MenubarRadioItem')]) {
      expect(body).not.toMatch(/<[A-Z]\w+ aria-hidden/);
    }
  });

  it('marks every icon as decoration, since the label already names the item', () => {
    expect(source()).not.toMatch(/<[A-Z]\w+ className="[^"]*"\s*\/>\s*\n\s*[A-Z]/);
  });
});

describe('Edit, Undo and Redo', () => {
  const openEdit = (user: ReturnType<typeof userEvent.setup>) =>
    user.click(screen.getByRole('menuitem', { name: 'Edit' }));

  it('is disabled when there is nothing to step back to', async () => {
    // A fresh viewer has no history. Greyed rather than hidden, so the menu keeps its shape.
    const user = userEvent.setup();
    render(
      <ViewerActionsProvider>
        <FakeViewer />
        <ViewerMenubar downloadHref="/x?download=1" />
      </ViewerActionsProvider>,
    );
    await openEdit(user);
    expect(await screen.findByRole('menuitem', { name: 'Undo' })).toHaveAttribute('data-disabled');
    expect(await screen.findByRole('menuitem', { name: 'Redo' })).toHaveAttribute('data-disabled');
  });

  it('offers undo once something has changed', async () => {
    const user = userEvent.setup();
    render(
      <ViewerActionsProvider>
        <FakeViewer canUndo />
        <ViewerMenubar downloadHref="/x?download=1" />
      </ViewerActionsProvider>,
    );
    await openEdit(user);
    const undo = await screen.findByRole('menuitem', { name: 'Undo' });
    expect(undo).not.toHaveAttribute('data-disabled');
    // fireEvent for the same jsdom reason as the export case above.
    fireEvent.click(undo);
    expect(actions.undo).toHaveBeenCalledTimes(1);
  });

  it('offers redo only after an undo', async () => {
    const user = userEvent.setup();
    render(
      <ViewerActionsProvider>
        <FakeViewer canRedo />
        <ViewerMenubar downloadHref="/x?download=1" />
      </ViewerActionsProvider>,
    );
    await openEdit(user);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Redo' }));
    expect(actions.redo).toHaveBeenCalledTimes(1);
  });
});

describe('Layout, Snap to grid', () => {
  // Under Layout, not View: it changes where the states go rather than what can be seen.
  const openView = (user: ReturnType<typeof userEvent.setup>) =>
    user.click(screen.getByRole('menuitem', { name: 'Layout' }));

  it('is off to begin with, so nothing moves unasked', async () => {
    const user = userEvent.setup();
    render(
      <ViewerActionsProvider>
        <FakeViewer />
        <ViewerMenubar downloadHref="/x?download=1" />
      </ViewerActionsProvider>,
    );
    await openView(user);
    expect(await screen.findByRole('menuitemcheckbox', { name: 'Snap to grid' })).not.toBeChecked();
  });

  it('follows the viewer when it is on', async () => {
    const user = userEvent.setup();
    render(
      <ViewerActionsProvider>
        <FakeViewer snapToGrid />
        <ViewerMenubar downloadHref="/x?download=1" />
      </ViewerActionsProvider>,
    );
    await openView(user);
    expect(await screen.findByRole('menuitemcheckbox', { name: 'Snap to grid' })).toBeChecked();
  });

  it('asks the viewer to toggle it', async () => {
    const user = userEvent.setup();
    render(
      <ViewerActionsProvider>
        <FakeViewer />
        <ViewerMenubar downloadHref="/x?download=1" />
      </ViewerActionsProvider>,
    );
    await openView(user);
    // fireEvent for the same jsdom reason as the export case above.
    fireEvent.click(await screen.findByRole('menuitemcheckbox', { name: 'Snap to grid' }));
    expect(actions.toggleSnapToGrid).toHaveBeenCalledTimes(1);
  });
});

describe('several viewers mounted at once', () => {
  /**
   * The standalone window keeps every opened tab mounted so each keeps its own zoom and undo
   * history, so more than one viewer publishes actions. The menu has to drive the one being
   * looked at, not whichever rendered last, and last is what it would get without the gate.
   *
   * Fresh mocks per test, not the shared `actions` above: those accumulate calls across this
   * file, so asserting on them here would pass whatever the gate did.
   */
  const makeActions = () => ({ ...actions, undo: vi.fn(), redo: vi.fn() });

  function Viewer({ own, canUndo }: { own: typeof actions; canUndo: boolean }) {
    useRegisterViewerActions(own, {
      grid: false,
      notes: true,
      snapToGrid: false,
      layout: 'as-drawn',
      canUndo,
      canRedo: true,
    });
    return null;
  }

  /** Two viewers in the tree, the second rendered last, with one of them showing. */
  function TwoViewers({
    first,
    second,
    activeSecond,
  }: {
    first: typeof actions;
    second: typeof actions;
    activeSecond: boolean;
  }) {
    return (
      <>
        <ViewerActionsGate active={!activeSecond}>
          <Viewer own={first} canUndo />
        </ViewerActionsGate>
        <ViewerActionsGate active={activeSecond}>
          <Viewer own={second} canUndo={false} />
        </ViewerActionsGate>
      </>
    );
  }

  it('undoes in the tab being looked at, not the one that rendered last', async () => {
    const user = userEvent.setup();
    const first = makeActions();
    const second = makeActions();
    render(
      <ViewerActionsProvider>
        <ViewerMenubar downloadHref="/f.jff" />
        <TwoViewers first={first} second={second} activeSecond={false} />
      </ViewerActionsProvider>,
    );

    await user.click(screen.getByRole('menuitem', { name: 'Edit' }));
    await user.click(await screen.findByRole('menuitem', { name: /^Undo/ }));

    expect(first.undo).toHaveBeenCalled();
    expect(second.undo).not.toHaveBeenCalled();
  });

  it('follows the switch when a different tab is selected', async () => {
    // The case the two static tests cannot reach. Switching hands the registry from one
    // viewer to the other in a single commit: the one losing it withdraws in the same flush
    // that the one gaining it registers, and getting that order wrong would leave the menu
    // driving nothing, or still driving the tab that was left behind.
    const user = userEvent.setup();
    const first = makeActions();
    const second = makeActions();
    const { rerender } = render(
      <ViewerActionsProvider>
        <ViewerMenubar downloadHref="/f.jff" />
        <TwoViewers first={first} second={second} activeSecond />
      </ViewerActionsProvider>,
    );

    // Back to the first, which is not the one that renders last: that is what makes this
    // fail if the menu is driven by render order rather than by which tab is showing.
    rerender(
      <ViewerActionsProvider>
        <ViewerMenubar downloadHref="/f.jff" />
        <TwoViewers first={first} second={second} activeSecond={false} />
      </ViewerActionsProvider>,
    );

    await user.click(screen.getByRole('menuitem', { name: 'Edit' }));
    await user.click(await screen.findByRole('menuitem', { name: /^Redo/ }));

    expect(first.redo).toHaveBeenCalled();
    expect(second.redo).not.toHaveBeenCalled();
  });

  it('offers nothing once the last viewer has gone', async () => {
    // Closing the last tab leaves the menu bar with no machine behind it. The items have to
    // go quiet rather than run against a graph that has been torn down.
    const user = userEvent.setup();
    const { rerender } = render(
      <ViewerActionsProvider>
        <ViewerMenubar downloadHref="/f.jff" />
        <TwoViewers first={makeActions()} second={makeActions()} activeSecond={false} />
      </ViewerActionsProvider>,
    );
    rerender(
      <ViewerActionsProvider>
        <ViewerMenubar downloadHref="/f.jff" />
      </ViewerActionsProvider>,
    );

    await user.click(screen.getByRole('menuitem', { name: 'Edit' }));
    const redo = await screen.findByRole('menuitem', { name: /^Redo/ });
    expect(redo.getAttribute('aria-disabled')).toBe('true');
  });

  it("shows the active tab's view state, not the last one's", async () => {
    // The tab being looked at has something to undo; the one behind it does not, and renders
    // last. The menu must offer Undo.
    const user = userEvent.setup();
    render(
      <ViewerActionsProvider>
        <ViewerMenubar downloadHref="/f.jff" />
        <TwoViewers first={makeActions()} second={makeActions()} activeSecond={false} />
      </ViewerActionsProvider>,
    );
    await user.click(screen.getByRole('menuitem', { name: 'Edit' }));
    const undo = await screen.findByRole('menuitem', { name: /^Undo/ });
    expect(undo.getAttribute('aria-disabled')).not.toBe('true');
  });
});

describe('resetting a machine', () => {
  // The `actions` mocks are shared across this file, so a test that asserts something was
  // NOT called has to start from a clean count or an earlier test satisfies it.
  beforeEach(() => actions.resetMachine.mockClear());

  const openMachine = async (user: ReturnType<typeof userEvent.setup>) =>
    user.click(screen.getByRole('menuitem', { name: 'Machine' }));

  const renderWithViewer = () =>
    render(
      <ViewerActionsProvider>
        <ViewerMenubar downloadHref="/f.jff" />
        <FakeViewer />
      </ViewerActionsProvider>,
    );

  it('asks before it does anything', async () => {
    // A reader can spend a while pulling a crowded machine apart, and the undo history goes
    // with the reset, so there is nothing to step back to afterwards.
    const user = userEvent.setup();
    renderWithViewer();
    await openMachine(user);
    await user.click(await screen.findByRole('menuitem', { name: /reset machine/i }));

    expect(await screen.findByText(/Reset this machine\?/i)).toBeTruthy();
    expect(actions.resetMachine).not.toHaveBeenCalled();
  });

  it('resets once it is confirmed', async () => {
    const user = userEvent.setup();
    renderWithViewer();
    await openMachine(user);
    await user.click(await screen.findByRole('menuitem', { name: /reset machine/i }));
    await user.click(await screen.findByRole('button', { name: 'Reset machine' }));

    expect(actions.resetMachine).toHaveBeenCalled();
  });

  it('does nothing if the reader backs out', async () => {
    const user = userEvent.setup();
    renderWithViewer();
    await openMachine(user);
    await user.click(await screen.findByRole('menuitem', { name: /reset machine/i }));
    await user.click(await screen.findByRole('button', { name: /cancel/i }));

    expect(actions.resetMachine).not.toHaveBeenCalled();
  });

  it('says what it will and will not touch', async () => {
    // The two things somebody about to click this needs to know: the other tabs are safe, and
    // nothing happens to what the student submitted.
    const user = userEvent.setup();
    renderWithViewer();
    await openMachine(user);
    await user.click(await screen.findByRole('menuitem', { name: /reset machine/i }));

    const text = (await screen.findByText(/other open files/i)).textContent ?? '';
    expect(text).toMatch(/submitted file is not changed/i);
  });
});

describe('the keyboard route to a split', () => {
  const openView = (user: ReturnType<typeof userEvent.setup>) =>
    user.click(screen.getByRole('menuitem', { name: 'View' }));

  it('offers the move, and runs it', async () => {
    const user = userEvent.setup();
    const onMoveToOtherSide = vi.fn();
    render(
      <ViewerActionsProvider>
        <FakeViewer />
        <ViewerMenubar
          downloadHref="/x?download=1"
          onMoveToOtherSide={onMoveToOtherSide}
          canMoveToOtherSide
        />
      </ViewerActionsProvider>,
    );
    await openView(user);
    fireEvent.click(await screen.findByRole('menuitem', { name: /move to other side/i }));
    expect(onMoveToOtherSide).toHaveBeenCalled();
  });

  it('greys it out when there is nothing to split away from', async () => {
    const user = userEvent.setup();
    render(
      <ViewerActionsProvider>
        <FakeViewer />
        <ViewerMenubar downloadHref="/x?download=1" onMoveToOtherSide={vi.fn()} />
      </ViewerActionsProvider>,
    );
    await openView(user);
    expect(await screen.findByRole('menuitem', { name: /move to other side/i })).toHaveAttribute(
      'data-disabled',
    );
  });

  it('is absent where there are no panes at all', async () => {
    // The panel viewer over a page has one machine and nowhere to put a second.
    const user = userEvent.setup();
    render(
      <ViewerActionsProvider>
        <FakeViewer />
        <ViewerMenubar downloadHref="/x?download=1" />
      </ViewerActionsProvider>,
    );
    await openView(user);
    expect(screen.queryByRole('menuitem', { name: /move to other side/i })).toBeNull();
  });
});

describe('linking the two views', () => {
  const openView = (user: ReturnType<typeof userEvent.setup>) =>
    user.click(screen.getByRole('menuitem', { name: 'View' }));

  const renderMenu = (props: Record<string, unknown>) =>
    render(
      <ViewerActionsProvider>
        <FakeViewer />
        <ViewerMenubar downloadHref="/x?download=1" {...props} />
      </ViewerActionsProvider>,
    );

  it('shows whether the two are linked, and switches it', async () => {
    const user = userEvent.setup();
    const onToggleLinkViews = vi.fn();
    renderMenu({ onToggleLinkViews, canLinkViews: true, linkViews: false });
    await openView(user);

    const item = await screen.findByRole('menuitemcheckbox', { name: /link the two views/i });
    expect(item).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(item);
    expect(onToggleLinkViews).toHaveBeenCalled();
  });

  it('shows it ticked when they are', async () => {
    const user = userEvent.setup();
    renderMenu({ onToggleLinkViews: vi.fn(), canLinkViews: true, linkViews: true });
    await openView(user);
    expect(
      await screen.findByRole('menuitemcheckbox', { name: /link the two views/i }),
    ).toHaveAttribute('aria-checked', 'true');
  });

  it('greys it out while there is only one machine on screen', async () => {
    // Greyed rather than hidden: an item that comes and goes reads as a bug.
    const user = userEvent.setup();
    renderMenu({ onToggleLinkViews: vi.fn(), canLinkViews: false });
    await openView(user);
    expect(
      await screen.findByRole('menuitemcheckbox', { name: /link the two views/i }),
    ).toHaveAttribute('data-disabled');
  });

  it('is absent where there are no panes at all', async () => {
    // The panel viewer over a page has one machine and nothing to link it to.
    const user = userEvent.setup();
    renderMenu({});
    await openView(user);
    expect(screen.queryByRole('menuitemcheckbox', { name: /link the two views/i })).toBeNull();
  });
});
