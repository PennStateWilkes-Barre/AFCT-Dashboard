/** @vitest-environment jsdom */

import React from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import DiscussionPanel, { type Comment } from './DiscussionPanel';

vi.mock('@/lib/date-format', () => ({
  formatDateTimeInTimeZone: () => 'a while ago',
}));
vi.mock('@/hooks/use-effective-timezone', () => ({
  useEffectiveTimezone: () => ({ timezone: 'UTC', hour12: true }),
}));
vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: { user: { id: 'stu1' } } }),
}));

const ownComment: Comment = {
  id: 'c1',
  content: 'Is the initial state meant to be q0?',
  createdAt: '2026-01-01T00:00:00.000Z',
  aboutGroupId: null,
  aboutStudentId: 'stu1',
  author: { id: 'stu1', firstName: 'Stu', lastName: 'Dent', role: 'STUDENT' },
};

const baseProps = {
  courseIsArchived: false,
  comments: [] as Comment[],
  commentText: '',
  onCommentTextChange: vi.fn(),
  onSaveComment: vi.fn(),
  onDeleteComment: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
});

/**
 * Writing a comment, which is the one thing on this panel a student does rather than reads.
 */
describe('the comment box', () => {
  it('reports what was typed', async () => {
    const onCommentTextChange = vi.fn();
    render(<DiscussionPanel {...baseProps} onCommentTextChange={onCommentTextChange} />);

    await userEvent.type(screen.getByRole('textbox'), 'Hi');

    // Controlled, so each keystroke is reported on its own rather than accumulating.
    expect(onCommentTextChange).toHaveBeenCalledTimes(2);
    expect(onCommentTextChange).toHaveBeenLastCalledWith('i');
  });

  it('posts on Ctrl+Enter without reaching for the mouse', async () => {
    const onSaveComment = vi.fn();
    render(
      <DiscussionPanel
        {...baseProps}
        commentText="Looks right now"
        onSaveComment={onSaveComment}
      />,
    );

    screen.getByRole('textbox').focus();
    await userEvent.keyboard('{Control>}{Enter}{/Control}');

    expect(onSaveComment).toHaveBeenCalledTimes(1);
  });

  it('posts on Cmd+Enter too, which is the same shortcut on a Mac', async () => {
    const onSaveComment = vi.fn();
    render(
      <DiscussionPanel
        {...baseProps}
        commentText="Looks right now"
        onSaveComment={onSaveComment}
      />,
    );

    screen.getByRole('textbox').focus();
    await userEvent.keyboard('{Meta>}{Enter}{/Meta}');

    expect(onSaveComment).toHaveBeenCalledTimes(1);
  });

  it('leaves a plain Enter to start a new line', async () => {
    const onSaveComment = vi.fn();
    render(
      <DiscussionPanel
        {...baseProps}
        commentText="Looks right now"
        onSaveComment={onSaveComment}
      />,
    );

    screen.getByRole('textbox').focus();
    await userEvent.keyboard('{Enter}');

    expect(onSaveComment).not.toHaveBeenCalled();
  });
});

/**
 * Deleting is staff-only in practice, but the confirm step is what stands between a misclick
 * and a comment nobody can get back: comments are not soft-deleted.
 *
 * The trigger and the confirm carry the same name, "Delete comment", so the confirm is found
 * inside the dialog rather than by name alone.
 */
describe('deleting a comment', () => {
  const openConfirm = async (onDeleteComment = vi.fn()) => {
    render(
      <DiscussionPanel {...baseProps} comments={[ownComment]} onDeleteComment={onDeleteComment} />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Delete comment' }));
    return {
      onDeleteComment,
      dialog: screen.getByRole('dialog', { name: 'Delete comment?' }),
    };
  };

  it('asks before deleting rather than acting on the click', async () => {
    const { onDeleteComment, dialog } = await openConfirm();

    expect(dialog).toBeInTheDocument();
    expect(onDeleteComment).not.toHaveBeenCalled();
  });

  it('deletes the comment the button belonged to once confirmed', async () => {
    const { onDeleteComment, dialog } = await openConfirm();

    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete comment' }));

    expect(onDeleteComment).toHaveBeenCalledWith('c1');
  });

  it('deletes nothing when the confirm is dismissed', async () => {
    const { onDeleteComment, dialog } = await openConfirm();

    await userEvent.click(within(dialog).getByRole('button', { name: /cancel/i }));

    expect(onDeleteComment).not.toHaveBeenCalled();
  });
});
