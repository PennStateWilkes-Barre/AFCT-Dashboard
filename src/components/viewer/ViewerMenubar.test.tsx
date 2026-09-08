/** @vitest-environment jsdom */
import React from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
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
  alignLeft: vi.fn(),
  alignCenter: vi.fn(),
  alignRight: vi.fn(),
  alignTop: vi.fn(),
  alignMiddle: vi.fn(),
  alignBottom: vi.fn(),
  distributeHorizontally: vi.fn(),
  distributeVertically: vi.fn(),
  selectSelectTool: vi.fn(),
  selectStateTool: vi.fn(),
  selectTransitionTool: vi.fn(),
  selectCommentTool: vi.fn(),
};

/** Every tool a fully capable viewer offers, which is the usual case in these tests. */
const ALL_TOOLS = ['select', 'state', 'transition', 'text'] as const;

/** Stands in for a rendered machine that publishes its actions and its view state. */
function FakeViewer({
  grid = false,
  notes = true,
  snapToGrid = false,
  layout = 'as-drawn',
  canUndo = false,
  canRedo = false,
  tools = ALL_TOOLS,
  selectedStates = 0,
}: {
  grid?: boolean;
  notes?: boolean;
  snapToGrid?: boolean;
  layout?: 'as-drawn' | 'auto';
  canUndo?: boolean;
  canRedo?: boolean;
  tools?: readonly ('select' | 'state' | 'transition' | 'text')[];
  selectedStates?: number;
}) {
  useRegisterViewerActions(actions, {
    grid,
    notes,
    snapToGrid,
    layout,
    canUndo,
    canRedo,
    tools,
    selectedStates,
  });
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

  it('offers the current automaton as a separate download', async () => {
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
    fireEvent.click(await screen.findByRole('menuitem', { name: /current automaton/i }));
    expect(actions.downloadCurrent).toHaveBeenCalledTimes(1);
  });

  it('still offers the original when nothing is drawn, since that needs no graph', async () => {
    // A grammar has no rendered automaton, so there is nothing current to save. The submitted
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
    expect(await screen.findByRole('menuitem', { name: /current automaton/i })).toHaveAttribute(
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
    await user.click(await screen.findByRole('menuitem', { name: 'Export image' }));
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
    await user.click(await screen.findByRole('menuitem', { name: 'Export image' }));
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
 * View answers "what can I see, and from how far away". Arrange answers "where is everything".
 * They were one menu, and Snap to grid sitting under the grid's own visibility was the seam:
 * the two share a word and nothing else. The split is here so that aligning and distributing a
 * selection have somewhere to go that is not the toolbar.
 */
/** The File menu's own shape: the file, a picture of it, and where it came from. */
describe('the File menu', () => {
  const mount = () =>
    render(
      <ViewerActionsProvider>
        <FakeViewer />
        <ViewerMenubar downloadHref="/x?download=1" />
      </ViewerActionsProvider>,
    );

  it('offers Download, Export image and File properties', async () => {
    const user = userEvent.setup();
    mount();

    await user.click(screen.getByRole('menuitem', { name: 'File' }));

    expect(await screen.findByRole('menuitem', { name: 'Download' })).toBeInTheDocument();
    // "Export image": the items above write out the automaton, these write out a picture.
    expect(screen.getByRole('menuitem', { name: 'Export image' })).toBeInTheDocument();
    // "File properties": this viewer also has properties panels for a state and a transition.
    expect(screen.getByRole('menuitem', { name: 'File properties' })).toBeInTheDocument();
  });

  it('puts PNG before SVG', async () => {
    const user = userEvent.setup();
    mount();

    await user.click(screen.getByRole('menuitem', { name: 'File' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Export image' }));

    const labels = (await screen.findAllByRole('menuitem'))
      .map((item) => item.textContent)
      .filter((label) => label === 'PNG' || label === 'SVG');
    expect(labels).toEqual(['PNG', 'SVG']);
  });
});

describe('View and Arrange own different things', () => {
  const openMenu = (user: ReturnType<typeof userEvent.setup>, name: string) =>
    user.click(screen.getByRole('menuitem', { name }));

  const mount = () =>
    render(
      <ViewerActionsProvider>
        <FakeViewer />
        <ViewerMenubar downloadHref="/x?download=1" />
      </ViewerActionsProvider>,
    );

  it('keeps looking at the automaton under View', async () => {
    const user = userEvent.setup();
    mount();

    await openMenu(user, 'View');

    // The camera, and what is drawn on top of it.
    expect(await screen.findByRole('menuitem', { name: /fit to window/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /center in window/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitemcheckbox', { name: 'Grid' })).toBeInTheDocument();
    expect(screen.getByRole('menuitemcheckbox', { name: 'JFLAP notes' })).toBeInTheDocument();
    // Not the arrangement.
    expect(screen.queryByRole('menuitemcheckbox', { name: /snap to grid/i })).toBeNull();
    expect(screen.queryByRole('menuitemradio', { name: /auto-arranged/i })).toBeNull();
  });

  it('keeps where the states go under Arrange', async () => {
    const user = userEvent.setup();
    mount();

    await openMenu(user, 'Arrange');

    expect(await screen.findByRole('menuitemradio', { name: /as drawn/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitemradio', { name: /auto-arranged/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitemcheckbox', { name: /snap to grid/i })).toBeInTheDocument();
    // Not the camera, and not the grid's visibility.
    expect(screen.queryByRole('menuitemcheckbox', { name: 'Grid' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: /fit to window/i })).toBeNull();
  });

  it('keeps changing the automaton under Edit', async () => {
    const user = userEvent.setup();
    mount();

    await openMenu(user, 'Edit');

    // The clipboard, and the far end of Undo.
    expect(await screen.findByRole('menuitem', { name: /copy as png/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /copy as svg/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /reset automaton/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Undo' })).toBeInTheDocument();
  });

  /**
   * Five menus, and the one that used to hold the three items above is gone. It was named
   * after the thing every menu here is about, which is what made it a place to put anything.
   */
  it('offers File, Edit, View, Arrange and Help, and nothing else', () => {
    mount();

    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'File',
      'Edit',
      'View',
      'Arrange',
      'Help',
    ]);
  });
});

describe('copying the automaton', () => {
  // Under Edit with the clipboard. What they copy is a picture of the drawing rather than a
  // selection, which is what the labels say.
  const openEdit = (user: ReturnType<typeof userEvent.setup>) =>
    user.click(screen.getByRole('menuitem', { name: 'Edit' }));

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
    await openEdit(user);
    // fireEvent for the same jsdom reason as the export case above.
    fireEvent.click(await screen.findByRole('menuitem', { name }));
    expect(actions[action]).toHaveBeenCalledTimes(1);
  });

  it('offers the two image copies, and leaves the text one beside the text', async () => {
    // Copying the description moved next to the description itself, where it is wanted. If it
    // ever comes back here as well there would be two ways to do one thing.
    const user = userEvent.setup();
    mountWithViewer();
    await openEdit(user);
    const labels = (await screen.findAllByRole('menuitem')).map((i) => i.textContent);
    expect(labels.filter((l) => l?.startsWith('Copy as'))).toHaveLength(2);
    expect(labels).not.toContain('Copy as text');
  });

  it('offers each format once, so there are not two ways to one thing', async () => {
    const user = userEvent.setup();
    mountWithViewer();

    await user.click(screen.getByRole('menuitem', { name: 'Edit' }));

    const labels = (await screen.findAllByRole('menuitem')).map((i) => i.textContent);
    expect(labels.filter((l) => l === 'Copy as PNG')).toHaveLength(1);
    expect(labels.filter((l) => l === 'Copy as SVG')).toHaveLength(1);
  });
});

describe('Arrange, the arrangement choice', () => {
  const openArrange = async (user: ReturnType<typeof userEvent.setup>) =>
    user.click(screen.getByRole('menuitem', { name: 'Arrange' }));

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
    await openArrange(user);
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
    await openArrange(user);
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
    await openArrange(user);
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

describe('View, JFLAP notes', () => {
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
    expect(await screen.findByRole('menuitemcheckbox', { name: 'JFLAP notes' })).toBeChecked();
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
    expect(await screen.findByRole('menuitemcheckbox', { name: 'JFLAP notes' })).not.toBeChecked();
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
    fireEvent.click(await screen.findByRole('menuitemcheckbox', { name: 'JFLAP notes' }));
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
    fireEvent.click(await screen.findByRole('menuitem', { name: 'File properties' }));
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
    expect(await screen.findByRole('menuitem', { name: 'File properties' })).toHaveAttribute(
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
    expect(await screen.findByRole('menuitem', { name: 'File properties' })).not.toHaveAttribute(
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

describe('Arrange, Snap to grid', () => {
  // Under Arrange, not View: it changes where the states go rather than what can be seen.
  const openView = (user: ReturnType<typeof userEvent.setup>) =>
    user.click(screen.getByRole('menuitem', { name: 'Arrange' }));

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
      tools: ALL_TOOLS,
      selectedStates: 0,
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

describe('resetting an automaton', () => {
  // The `actions` mocks are shared across this file, so a test that asserts something was
  // NOT called has to start from a clean count or an earlier test satisfies it.
  beforeEach(() => actions.resetMachine.mockClear());

  const openEdit = async (user: ReturnType<typeof userEvent.setup>) =>
    user.click(screen.getByRole('menuitem', { name: 'Edit' }));

  const renderWithViewer = () =>
    render(
      <ViewerActionsProvider>
        <ViewerMenubar downloadHref="/f.jff" />
        <FakeViewer />
      </ViewerActionsProvider>,
    );

  it('asks before it does anything', async () => {
    // A reader can spend a while pulling a crowded automaton apart, and the undo history goes
    // with the reset, so there is nothing to step back to afterwards.
    const user = userEvent.setup();
    renderWithViewer();
    await openEdit(user);
    await user.click(await screen.findByRole('menuitem', { name: /reset automaton/i }));

    expect(await screen.findByText(/Reset this automaton\?/i)).toBeTruthy();
    expect(actions.resetMachine).not.toHaveBeenCalled();
  });

  it('resets once it is confirmed', async () => {
    const user = userEvent.setup();
    renderWithViewer();
    await openEdit(user);
    await user.click(await screen.findByRole('menuitem', { name: /reset automaton/i }));
    await user.click(await screen.findByRole('button', { name: 'Reset automaton' }));

    expect(actions.resetMachine).toHaveBeenCalled();
  });

  it('does nothing if the reader backs out', async () => {
    const user = userEvent.setup();
    renderWithViewer();
    await openEdit(user);
    await user.click(await screen.findByRole('menuitem', { name: /reset automaton/i }));
    await user.click(await screen.findByRole('button', { name: /cancel/i }));

    expect(actions.resetMachine).not.toHaveBeenCalled();
  });

  /**
   * The description has to match `resetMachine`, which clears the renames, the initial and
   * final marks, the transition edits, the drawn states and transitions, the deletions, the
   * arrangement choice, the remembered view and the history, and then re-reads the file. It
   * does not touch Snap to grid or what the grid and the notes are showing.
   */
  it('warns that the edits go, not only the arrangement', async () => {
    const user = userEvent.setup();
    renderWithViewer();
    await openEdit(user);

    await user.click(await screen.findByRole('menuitem', { name: /reset automaton/i }));

    const description = await screen.findByText(/discards every change/i);
    expect(description).toHaveTextContent(/states and transitions/i);
    expect(description).toHaveTextContent(/arrangement choice/i);
    expect(description).toHaveTextContent(/undo history/i);
    // And not a word about the two settings it leaves alone.
    expect(description).not.toHaveTextContent(/snap/i);
  });

  it('says what it will and will not touch', async () => {
    // The two things somebody about to click this needs to know: the other tabs are safe, and
    // nothing happens to what the student submitted.
    const user = userEvent.setup();
    renderWithViewer();
    await openEdit(user);
    await user.click(await screen.findByRole('menuitem', { name: /reset automaton/i }));

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
    fireEvent.click(await screen.findByRole('menuitem', { name: /move to other pane/i }));
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
    expect(await screen.findByRole('menuitem', { name: /move to other pane/i })).toHaveAttribute(
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
    expect(screen.queryByRole('menuitem', { name: /move to other pane/i })).toBeNull();
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

    const item = await screen.findByRole('menuitemcheckbox', { name: /link views/i });
    expect(item).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(item);
    expect(onToggleLinkViews).toHaveBeenCalled();
  });

  it('shows it ticked when they are', async () => {
    const user = userEvent.setup();
    renderMenu({ onToggleLinkViews: vi.fn(), canLinkViews: true, linkViews: true });
    await openView(user);
    expect(await screen.findByRole('menuitemcheckbox', { name: /link views/i })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  it('greys it out while there is only one automaton on screen', async () => {
    // Greyed rather than hidden: an item that comes and goes reads as a bug.
    const user = userEvent.setup();
    renderMenu({ onToggleLinkViews: vi.fn(), canLinkViews: false });
    await openView(user);
    expect(await screen.findByRole('menuitemcheckbox', { name: /link views/i })).toHaveAttribute(
      'data-disabled',
    );
  });

  it('is absent where there are no panes at all', async () => {
    // The panel viewer over a page has one machine and nothing to link it to.
    const user = userEvent.setup();
    renderMenu({});
    await openView(user);
    expect(screen.queryByRole('menuitemcheckbox', { name: /link views/i })).toBeNull();
  });
});

/**
 * The keyboard, and where its presses land.
 *
 * One listener, owned by this menu bar, reaching the machine through the same registry the
 * menu items use. That is what makes a shortcut go to the focused pane: only the focused pane
 * is allowed to register, so both are the same question with one answer.
 */
describe('keyboard shortcuts', () => {
  const mountWithViewer = (props: Parameters<typeof FakeViewer>[0] = {}) =>
    render(
      <ViewerActionsProvider>
        <FakeViewer {...props} />
        <ViewerMenubar downloadHref="/x?download=1" />
      </ViewerActionsProvider>,
    );

  const press = (
    key: string,
    mods: Record<string, boolean> = {},
    target: Element | Window = window,
  ) => fireEvent.keyDown(target, { key, ...mods });

  beforeEach(() => {
    for (const fn of Object.values(actions)) fn.mockClear();
  });

  it.each([
    ['f', {}, 'fitToWindow'],
    ['F', { shiftKey: true }, 'centerInWindow'],
    ['g', {}, 'toggleGrid'],
    ['G', { shiftKey: true }, 'toggleSnapToGrid'],
    ['v', {}, 'selectSelectTool'],
    ['n', {}, 'selectStateTool'],
    ['t', {}, 'selectTransitionTool'],
    ['c', {}, 'selectCommentTool'],
  ] as const)('runs %s through the registry', (key, mods, action) => {
    mountWithViewer();

    press(key, mods);

    expect(actions[action]).toHaveBeenCalledTimes(1);
  });

  it('steps back and forward only when there is somewhere to go', () => {
    const { unmount } = mountWithViewer({ canUndo: false, canRedo: false });

    press('z', { ctrlKey: true });
    press('z', { ctrlKey: true, shiftKey: true });

    expect(actions.undo).not.toHaveBeenCalled();
    expect(actions.redo).not.toHaveBeenCalled();

    unmount();
    mountWithViewer({ canUndo: true, canRedo: true });

    press('z', { metaKey: true });
    press('z', { metaKey: true, shiftKey: true });
    press('y', { ctrlKey: true });

    expect(actions.undo).toHaveBeenCalledTimes(1);
    expect(actions.redo).toHaveBeenCalledTimes(2);
  });

  it('offers no tool the viewer does not have', () => {
    // The capability rules stay where they are: the viewer publishes what it can offer, and a
    // key press is refused for the same reason the palette button is absent.
    mountWithViewer({ tools: ['select'] });

    press('n');
    press('t');
    press('c');
    press('v');

    expect(actions.selectStateTool).not.toHaveBeenCalled();
    expect(actions.selectTransitionTool).not.toHaveBeenCalled();
    expect(actions.selectCommentTool).not.toHaveBeenCalled();
    expect(actions.selectSelectTool).toHaveBeenCalledTimes(1);
  });

  it('does nothing while somebody is typing', () => {
    mountWithViewer({ canUndo: true });
    const box = document.createElement('input');
    document.body.appendChild(box);

    press('n', {}, box);
    press('t', {}, box);
    press('c', {}, box);
    press('f', {}, box);
    press('z', { ctrlKey: true }, box);

    expect(actions.selectStateTool).not.toHaveBeenCalled();
    expect(actions.selectTransitionTool).not.toHaveBeenCalled();
    expect(actions.selectCommentTool).not.toHaveBeenCalled();
    expect(actions.fitToWindow).not.toHaveBeenCalled();
    expect(actions.undo).not.toHaveBeenCalled();
    box.remove();
  });

  it('leaves a held key as one press', () => {
    mountWithViewer();

    fireEvent.keyDown(window, { key: 'f' });
    fireEvent.keyDown(window, { key: 'f', repeat: true });
    fireEvent.keyDown(window, { key: 'f', repeat: true });

    expect(actions.fitToWindow).toHaveBeenCalledTimes(1);
  });

  it('leaves the browser its own shortcuts', () => {
    mountWithViewer({ canUndo: true });

    press('n', { ctrlKey: true });
    press('t', { ctrlKey: true });
    press('c', { metaKey: true });
    press('s', { ctrlKey: true });
    press('f', { altKey: true });

    for (const fn of Object.values(actions)) expect(fn).not.toHaveBeenCalled();
  });

  /** Only one pane registers, so only one pane hears a key press. */
  it('reaches the focused pane and not the other one', () => {
    const other = { ...actions, fitToWindow: vi.fn(), selectStateTool: vi.fn() };
    function OtherViewer() {
      useRegisterViewerActions(other, {
        grid: false,
        notes: true,
        snapToGrid: false,
        layout: 'as-drawn',
        canUndo: false,
        canRedo: false,
        tools: ALL_TOOLS,
        selectedStates: 0,
      });
      return null;
    }
    render(
      <ViewerActionsProvider>
        <ViewerActionsGate active>
          <FakeViewer />
        </ViewerActionsGate>
        <ViewerActionsGate active={false}>
          <OtherViewer />
        </ViewerActionsGate>
        <ViewerMenubar downloadHref="/x?download=1" />
      </ViewerActionsProvider>,
    );

    press('f');
    press('n');

    expect(actions.fitToWindow).toHaveBeenCalledTimes(1);
    expect(actions.selectStateTool).toHaveBeenCalledTimes(1);
    expect(other.fitToWindow).not.toHaveBeenCalled();
    expect(other.selectStateTool).not.toHaveBeenCalled();
  });
});

describe('the keyboard shortcuts dialog', () => {
  const mount = () =>
    render(
      <ViewerActionsProvider>
        <FakeViewer />
        <ViewerMenubar downloadHref="/x?download=1" />
      </ViewerActionsProvider>,
    );

  it('opens from Help, above Documentation', async () => {
    const user = userEvent.setup();
    mount();

    await user.click(screen.getByRole('menuitem', { name: 'Help' }));
    const items = (await screen.findAllByRole('menuitem')).map((item) => item.textContent);
    expect(items.indexOf('Keyboard shortcuts?')).toBeLessThan(items.indexOf('Documentation'));

    fireEvent.click(screen.getByRole('menuitem', { name: /keyboard shortcuts/i }));

    expect(await screen.findByRole('dialog', { name: 'Keyboard shortcuts' })).toBeInTheDocument();
  });

  it('opens from ? as well, which is the same dialog', async () => {
    mount();

    fireEvent.keyDown(window, { key: '?', shiftKey: true });

    expect(await screen.findByRole('dialog', { name: 'Keyboard shortcuts' })).toBeInTheDocument();
  });

  it('lists every shortcut, with the keys the handler matches', async () => {
    mount();
    fireEvent.keyDown(window, { key: '?', shiftKey: true });
    const dialog = await screen.findByRole('dialog', { name: 'Keyboard shortcuts' });

    for (const label of [
      'Select tool',
      'State tool',
      'Transition tool',
      'Comment tool',
      'Undo',
      'Redo',
      'Fit to window',
      'Center in window',
      'Toggle grid',
      'Toggle snap to grid',
    ]) {
      expect(within(dialog).getByText(label)).toBeInTheDocument();
    }
    // Its own row as well as the dialog's title, so `?` is discoverable from inside it.
    expect(within(dialog).getAllByText('Keyboard shortcuts')).toHaveLength(2);
    // Straight from the definitions, so a key cannot be listed here and matched differently.
    expect(within(dialog).getByText('N')).toBeInTheDocument();
    expect(within(dialog).getByText('Shift+G')).toBeInTheDocument();
    expect(within(dialog).getByText('Ctrl+Shift+Z')).toBeInTheDocument();
  });
});

/**
 * Lining states up and spreading them out.
 *
 * Greyed until there are enough states picked out to mean anything: two to line up, three to
 * spread out, since two are already evenly spaced whatever they are.
 */
describe('Arrange, Align and Distribute', () => {
  const mount = (selectedStates: number) =>
    render(
      <ViewerActionsProvider>
        <FakeViewer selectedStates={selectedStates} />
        <ViewerMenubar downloadHref="/x?download=1" />
      </ViewerActionsProvider>,
    );

  const openArrange = (user: ReturnType<typeof userEvent.setup>) =>
    user.click(screen.getByRole('menuitem', { name: 'Arrange' }));

  beforeEach(() => {
    for (const fn of Object.values(actions)) fn.mockClear();
  });

  it.each([
    ['Left', 'alignLeft'],
    ['Center', 'alignCenter'],
    ['Right', 'alignRight'],
    ['Top', 'alignTop'],
    ['Middle', 'alignMiddle'],
    ['Bottom', 'alignBottom'],
  ] as const)('runs %s', async (label, action) => {
    const user = userEvent.setup();
    mount(2);
    await openArrange(user);
    await user.click(await screen.findByRole('menuitem', { name: 'Align' }));

    fireEvent.click(await screen.findByRole('menuitem', { name: label }));

    expect(actions[action]).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['Horizontally', 'distributeHorizontally'],
    ['Vertically', 'distributeVertically'],
  ] as const)('runs Distribute %s', async (label, action) => {
    const user = userEvent.setup();
    mount(3);
    await openArrange(user);
    await user.click(await screen.findByRole('menuitem', { name: 'Distribute' }));

    fireEvent.click(await screen.findByRole('menuitem', { name: label }));

    expect(actions[action]).toHaveBeenCalledTimes(1);
  });

  it('greys both while one state is selected', async () => {
    const user = userEvent.setup();
    mount(1);

    await openArrange(user);

    expect(await screen.findByRole('menuitem', { name: 'Align' })).toHaveAttribute('data-disabled');
    expect(screen.getByRole('menuitem', { name: 'Distribute' })).toHaveAttribute('data-disabled');
  });

  it('offers Align at two states, and Distribute only at three', async () => {
    const user = userEvent.setup();
    const { unmount } = mount(2);
    await openArrange(user);
    expect(await screen.findByRole('menuitem', { name: 'Align' })).not.toHaveAttribute(
      'data-disabled',
    );
    expect(screen.getByRole('menuitem', { name: 'Distribute' })).toHaveAttribute('data-disabled');

    unmount();
    mount(3);
    await openArrange(user);
    expect(await screen.findByRole('menuitem', { name: 'Distribute' })).not.toHaveAttribute(
      'data-disabled',
    );
  });
});
