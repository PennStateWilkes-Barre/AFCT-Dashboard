import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTOMATIC } from '@/lib/linked-identity';
import { NextRequest } from 'next/server';

const prismaMock = vi.hoisted(() => ({
  user: {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    count: vi.fn(),
  },
  roster: { findMany: vi.fn() },
  activityLog: { deleteMany: vi.fn() },
  // Promotion clears automatically-attached sign-ins in the same transaction as the update, and
  // switching an account off reads them in the same transaction as its own (see the route: that
  // read is what makes the two conflict rather than both committing).
  linkedIdentity: {
    deleteMany: vi.fn(async () => ({ count: 0 })),
    count: vi.fn(async () => 0),
  },
  // The last-administrator rule counts and updates in one serializable transaction, so the
  // pair conflicts in Postgres rather than both succeeding. Here it simply runs the callback.
  $transaction: vi.fn(),
}));

const authMock = vi.hoisted(() => vi.fn());
const activityLogMock = vi.hoisted(() => vi.fn());
const getSystemUploadLimitMock = vi.hoisted(() => vi.fn());
const writeFileMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const unlinkMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }));
vi.mock('@/lib/auth', () => ({ auth: authMock }));
vi.mock('@/lib/activity-log-utils', () => ({ createEnhancedActivityLog: activityLogMock }));
vi.mock('@/lib/upload-limits', () => ({ getSystemUploadLimit: getSystemUploadLimitMock }));
vi.mock('fs/promises', () => ({
  writeFile: writeFileMock,
  unlink: unlinkMock,
}));

import { PATCH, DELETE, GET, POST } from './route';

// A minimal valid PNG (8-byte magic header + padding) so uploads pass the
// magic-byte signature check in avatar-upload.
const pngBytes = () =>
  Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);

beforeEach(() => {
  prismaMock.$transaction.mockImplementation(async (cb: (client: typeof prismaMock) => unknown) =>
    cb(prismaMock),
  );
  vi.clearAllMocks();
  getSystemUploadLimitMock.mockResolvedValue({ maxBytes: 1024 * 1024, maxMb: 1 });
  prismaMock.roster.findMany.mockResolvedValue([]);
  // Another active admin exists by default; the last-admin tests override this.
  prismaMock.user.count.mockResolvedValue(1);
  // No email collision by default; the duplicate-email test overrides this.
  prismaMock.user.findFirst.mockResolvedValue(null);
});

describe('PATCH /api/users/[id]', () => {
  it('returns 401 when unauthenticated', async () => {
    authMock.mockResolvedValue(null);

    const req = new NextRequest('http://localhost/api/users/u1', {
      method: 'PATCH',
      body: JSON.stringify({ firstName: 'A' }),
    });

    const res = await PATCH(req, { params: Promise.resolve({ id: 'u1' }) });

    expect(res.status).toBe(401);
  });

  it('returns 401 when session has no user', async () => {
    authMock.mockResolvedValue({ user: null });

    const req = new NextRequest('http://localhost/api/users/u1', {
      method: 'PATCH',
      body: JSON.stringify({ firstName: 'A' }),
    });

    const res = await PATCH(req, { params: Promise.resolve({ id: 'u1' }) });

    expect(res.status).toBe(401);
  });

  it('returns 401 when user has no id', async () => {
    authMock.mockResolvedValue({ user: { email: 'test@test.com' } });

    const req = new NextRequest('http://localhost/api/users/u1', {
      method: 'PATCH',
      body: JSON.stringify({ firstName: 'A' }),
    });

    const res = await PATCH(req, { params: Promise.resolve({ id: 'u1' }) });

    expect(res.status).toBe(401);
  });

  it('returns 403 when forbidden', async () => {
    authMock.mockResolvedValue({ user: { id: 'u2', role: 'STUDENT' } });

    const req = new NextRequest('http://localhost/api/users/u1', {
      method: 'PATCH',
      body: JSON.stringify({ firstName: 'A' }),
    });

    const res = await PATCH(req, { params: Promise.resolve({ id: 'u1' }) });

    expect(res.status).toBe(403);
  });

  it('allows ADMIN to update any user', async () => {
    authMock.mockResolvedValue({ user: { id: 'admin', role: 'ADMIN', isAdmin: true } });
    prismaMock.user.findUnique.mockResolvedValue({ avatar: null });
    prismaMock.user.update.mockResolvedValue({
      id: 'u1',
      email: 'u1@example.com',
      firstName: 'Updated',
      lastName: 'User',
      role: 'STUDENT',
      inactive: false,
      avatar: null,
      timezone: null,
    });

    const req = new NextRequest('http://localhost/api/users/u1', {
      method: 'PATCH',
      body: JSON.stringify({ firstName: 'Updated', lastName: 'User' }),
    });

    const res = await PATCH(req, { params: Promise.resolve({ id: 'u1' }) });

    expect(res.status).toBe(200);
    expect(prismaMock.user.update).toHaveBeenCalled();
  });

  it('denies a non-admin FACULTY editing another user', async () => {
    authMock.mockResolvedValue({ user: { id: 'faculty', role: 'FACULTY' } });

    const req = new NextRequest('http://localhost/api/users/u1', {
      method: 'PATCH',
      body: JSON.stringify({ firstName: 'A' }),
    });

    const res = await PATCH(req, { params: Promise.resolve({ id: 'u1' }) });

    expect(res.status).toBe(403);
    expect(prismaMock.user.update).not.toHaveBeenCalled();
    // The forbidden attempt is recorded as a SECURITY event.
    expect(activityLogMock).toHaveBeenCalledWith(
      prismaMock,
      req,
      expect.objectContaining({ action: 'USER_UPDATE_DENIED', severity: 'SECURITY' }),
    );
  });

  it('denies a non-admin TA editing another user', async () => {
    authMock.mockResolvedValue({ user: { id: 'ta', role: 'TA' } });

    const req = new NextRequest('http://localhost/api/users/u1', {
      method: 'PATCH',
      body: JSON.stringify({ firstName: 'A' }),
    });

    const res = await PATCH(req, { params: Promise.resolve({ id: 'u1' }) });

    expect(res.status).toBe(403);
    expect(prismaMock.user.update).not.toHaveBeenCalled();
  });

  it('allows user to update their own profile', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'STUDENT' } });
    prismaMock.user.findUnique.mockResolvedValue({ avatar: null });
    prismaMock.user.update.mockResolvedValue({
      id: 'u1',
      email: 'u1@example.com',
      firstName: 'Self',
      lastName: 'Update',
      role: 'STUDENT',
      inactive: false,
      avatar: null,
      timezone: null,
    });

    const req = new NextRequest('http://localhost/api/users/u1', {
      method: 'PATCH',
      body: JSON.stringify({ firstName: 'Self' }),
    });

    const res = await PATCH(req, { params: Promise.resolve({ id: 'u1' }) });

    expect(res.status).toBe(200);
  });

  it('lets an admin grant the isAdmin flag', async () => {
    authMock.mockResolvedValue({ user: { id: 'admin', role: 'ADMIN', isAdmin: true } });
    prismaMock.user.findUnique.mockResolvedValue({ avatar: null, isAdmin: false });
    prismaMock.user.update.mockResolvedValue({
      id: 'u1',
      email: 'u1@example.com',
      firstName: 'A',
      lastName: 'B',
      role: 'FACULTY',
      isAdmin: true,
      inactive: false,
      avatar: null,
      timezone: null,
    });

    const req = new NextRequest('http://localhost/api/users/u1', {
      method: 'PATCH',
      body: JSON.stringify({ isAdmin: true }),
    });

    const res = await PATCH(req, { params: Promise.resolve({ id: 'u1' }) });

    expect(res.status).toBe(200);
    expect(prismaMock.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ isAdmin: true }) }),
    );
  });

  /**
   * Promotion clears the sign-ins that were attached automatically, because an administrator
   * must not be reachable through a link somebody else's LMS could have created. That delete
   * is scoped to the account being promoted. The prisma mock reports a count either way, so
   * without the `userId` it would strip automatic sign-ins from every account in the
   * installation, and nothing else here would notice.
   */
  it('clears automatic sign-ins for the promoted account only', async () => {
    authMock.mockResolvedValue({ user: { id: 'admin', role: 'ADMIN', isAdmin: true } });
    prismaMock.user.findUnique.mockResolvedValue({ avatar: null, isAdmin: false });
    prismaMock.user.update.mockResolvedValue({
      id: 'u1',
      email: 'u1@example.com',
      firstName: 'A',
      lastName: 'B',
      role: 'FACULTY',
      isAdmin: true,
      inactive: false,
      avatar: null,
      timezone: null,
    });

    const req = new NextRequest('http://localhost/api/users/u1', {
      method: 'PATCH',
      body: JSON.stringify({ isAdmin: true }),
    });

    const res = await PATCH(req, { params: Promise.resolve({ id: 'u1' }) });
    expect(res.status).toBe(200);

    expect(prismaMock.linkedIdentity.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'u1', linkedVia: { in: AUTOMATIC } },
    });
  });

  it('ignores isAdmin from a non-admin editing their own account', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'STUDENT' } });
    prismaMock.user.findUnique.mockResolvedValue({ avatar: null, isAdmin: false });
    prismaMock.user.update.mockResolvedValue({
      id: 'u1',
      email: 'u1@example.com',
      firstName: 'A',
      lastName: 'B',
      role: 'STUDENT',
      isAdmin: false,
      inactive: false,
      avatar: null,
      timezone: null,
    });

    const req = new NextRequest('http://localhost/api/users/u1', {
      method: 'PATCH',
      body: JSON.stringify({ isAdmin: true }),
    });

    const res = await PATCH(req, { params: Promise.resolve({ id: 'u1' }) });

    expect(res.status).toBe(200);
    // The self-editing student's admin flag must be left untouched (undefined).
    expect(prismaMock.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ isAdmin: undefined }) }),
    );
  });

  it('handles a request with an empty content-type header (JSON fallback path)', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'ADMIN' } });
    prismaMock.user.findUnique.mockResolvedValue({ avatar: null });
    prismaMock.user.update.mockResolvedValue({
      id: 'u1',
      email: 'u1@example.com',
      firstName: 'A',
      lastName: 'B',
      role: 'ADMIN',
      inactive: false,
      avatar: null,
      timezone: null,
    });

    const req = new NextRequest('http://localhost/api/users/u1', {
      method: 'PATCH',
      headers: { 'content-type': '' },
      body: JSON.stringify({ firstName: 'A' }),
    });

    const res = await PATCH(req, { params: Promise.resolve({ id: 'u1' }) });

    expect(res.status).toBe(200);
  });

  it('applies the isAdmin flag sent via multipart form data (admin actor)', async () => {
    authMock.mockResolvedValue({ user: { id: 'admin', role: 'ADMIN', isAdmin: true } });
    prismaMock.user.findUnique.mockResolvedValue({ avatar: null, isAdmin: false });
    prismaMock.user.update.mockResolvedValue({
      id: 'u1',
      email: 'u1@example.com',
      firstName: 'A',
      lastName: 'B',
      role: 'FACULTY',
      isAdmin: true,
      inactive: false,
      avatar: null,
      timezone: null,
    });

    const formData = new FormData();
    formData.append('isAdmin', 'true');
    formData.append('firstName', 'A');

    const req = new NextRequest('http://localhost/api/users/u1', {
      method: 'PATCH',
      body: formData,
    });

    const res = await PATCH(req, { params: Promise.resolve({ id: 'u1' }) });

    expect(res.status).toBe(200);
    expect(prismaMock.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ isAdmin: true }) }),
    );
  });

  it('returns 500 with "unknown error" when a non-Error value is thrown', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'ADMIN' } });
    prismaMock.user.findUnique.mockResolvedValue({ avatar: null });
    prismaMock.user.update.mockRejectedValue('a plain string');

    const req = new NextRequest('http://localhost/api/users/u1', {
      method: 'PATCH',
      body: JSON.stringify({ firstName: 'A' }),
    });

    const res = await PATCH(req, { params: Promise.resolve({ id: 'u1' }) });

    expect(res.status).toBe(500);
    expect(activityLogMock).toHaveBeenCalledWith(
      prismaMock,
      req,
      expect.objectContaining({
        action: 'USER_UPDATE_ERROR',
        metadata: expect.objectContaining({ error: 'unknown error' }),
      }),
    );
  });

  it('returns 400 when timezone invalid', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'ADMIN' } });

    const req = new NextRequest('http://localhost/api/users/u1', {
      method: 'PATCH',
      body: JSON.stringify({ timezone: 'Invalid/Zone' }),
    });

    const res = await PATCH(req, { params: Promise.resolve({ id: 'u1' }) });

    expect(res.status).toBe(400);
  });

  it('accepts valid timezone', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'ADMIN' } });
    prismaMock.user.findUnique.mockResolvedValue({ avatar: null });
    prismaMock.user.update.mockResolvedValue({
      id: 'u1',
      email: 'u1@example.com',
      firstName: 'A',
      lastName: 'B',
      role: 'ADMIN',
      inactive: false,
      avatar: null,
      timezone: 'America/New_York',
    });

    const req = new NextRequest('http://localhost/api/users/u1', {
      method: 'PATCH',
      body: JSON.stringify({ timezone: 'America/New_York' }),
    });

    const res = await PATCH(req, { params: Promise.resolve({ id: 'u1' }) });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.timezone).toBe('America/New_York');
  });

  it('returns 413 when avatar file exceeds size limit', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'ADMIN' } });
    getSystemUploadLimitMock.mockResolvedValue({ maxBytes: 100, maxMb: 0.0001 });

    const largeBuffer = Buffer.alloc(200);
    const formData = new FormData();
    formData.append('avatar', new Blob([largeBuffer], { type: 'image/png' }), 'large.png');

    const req = new NextRequest('http://localhost/api/users/u1', {
      method: 'PATCH',
      body: formData,
    });

    const res = await PATCH(req, { params: Promise.resolve({ id: 'u1' }) });

    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.error).toContain('exceeds max upload size');
  });

  it('handles multipart form data with avatar upload', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'ADMIN' } });
    prismaMock.user.findUnique.mockResolvedValue({ avatar: null });
    prismaMock.user.update.mockResolvedValue({
      id: 'u1',
      email: 'u1@example.com',
      firstName: 'A',
      lastName: 'B',
      role: 'ADMIN',
      inactive: false,
      avatar: 'u1-123456-avatar.png',
      timezone: null,
    });

    const avatarBuffer = pngBytes();
    const formData = new FormData();
    formData.append('firstName', 'A');
    formData.append('avatar', new Blob([avatarBuffer], { type: 'image/png' }), 'avatar.png');

    const req = new NextRequest('http://localhost/api/users/u1', {
      method: 'PATCH',
      body: formData,
    });

    const res = await PATCH(req, { params: Promise.resolve({ id: 'u1' }) });

    expect(res.status).toBe(200);
    expect(writeFileMock).toHaveBeenCalled();
  });

  it('deletes old avatar when uploading new one', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'ADMIN' } });
    prismaMock.user.findUnique.mockResolvedValue({ avatar: 'old-avatar.png' });
    prismaMock.user.update.mockResolvedValue({
      id: 'u1',
      email: 'u1@example.com',
      firstName: 'A',
      lastName: 'B',
      role: 'ADMIN',
      inactive: false,
      avatar: 'new-avatar.png',
      timezone: null,
    });

    const avatarBuffer = pngBytes();
    const formData = new FormData();
    formData.append('avatar', new Blob([avatarBuffer], { type: 'image/png' }), 'new.png');

    const req = new NextRequest('http://localhost/api/users/u1', {
      method: 'PATCH',
      body: formData,
    });

    const res = await PATCH(req, { params: Promise.resolve({ id: 'u1' }) });

    expect(res.status).toBe(200);
    expect(unlinkMock).toHaveBeenCalled();
    expect(writeFileMock).toHaveBeenCalled();
  });

  it('still uploads a new avatar when removing the old one fails', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'ADMIN' } });
    prismaMock.user.findUnique.mockResolvedValue({ avatar: 'old-avatar.png' });
    prismaMock.user.update.mockResolvedValue({
      id: 'u1',
      email: 'u1@example.com',
      firstName: 'A',
      lastName: 'B',
      role: 'ADMIN',
      inactive: false,
      avatar: 'new-avatar.png',
      timezone: null,
    });
    unlinkMock.mockRejectedValue(new Error('fs error'));

    const avatarBuffer = pngBytes();
    const formData = new FormData();
    formData.append('avatar', new Blob([avatarBuffer], { type: 'image/png' }), 'new.png');

    const req = new NextRequest('http://localhost/api/users/u1', {
      method: 'PATCH',
      body: formData,
    });

    const res = await PATCH(req, { params: Promise.resolve({ id: 'u1' }) });

    // The old-avatar unlink rejection is swallowed; the new file is still written.
    expect(res.status).toBe(200);
    expect(writeFileMock).toHaveBeenCalled();
  });

  it('handles deleteAvatar flag in form data', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'ADMIN' } });
    prismaMock.user.findUnique.mockResolvedValue({ avatar: 'avatar-to-delete.png' });
    prismaMock.user.update.mockResolvedValue({
      id: 'u1',
      email: 'u1@example.com',
      firstName: 'A',
      lastName: 'B',
      role: 'ADMIN',
      inactive: false,
      avatar: null,
      timezone: null,
    });

    const formData = new FormData();
    formData.append('deleteAvatar', 'true');
    formData.append('firstName', 'A');

    const req = new NextRequest('http://localhost/api/users/u1', {
      method: 'PATCH',
      body: formData,
    });

    const res = await PATCH(req, { params: Promise.resolve({ id: 'u1' }) });

    expect(res.status).toBe(200);
    expect(unlinkMock).toHaveBeenCalled();
  });

  it('still succeeds when removing the old avatar file fails', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'ADMIN' } });
    prismaMock.user.findUnique.mockResolvedValue({ avatar: 'avatar-to-delete.png' });
    prismaMock.user.update.mockResolvedValue({
      id: 'u1',
      email: 'u1@example.com',
      firstName: 'A',
      lastName: 'B',
      role: 'ADMIN',
      inactive: false,
      avatar: null,
      timezone: null,
    });
    unlinkMock.mockRejectedValue(new Error('fs error'));

    const formData = new FormData();
    formData.append('deleteAvatar', 'true');
    formData.append('firstName', 'A');

    const req = new NextRequest('http://localhost/api/users/u1', {
      method: 'PATCH',
      body: formData,
    });

    const res = await PATCH(req, { params: Promise.resolve({ id: 'u1' }) });

    // The unlink rejection is swallowed by the .catch() handler.
    expect(res.status).toBe(200);
  });

  it('returns 403 when setting user inactive while in active course', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'ADMIN' } });
    prismaMock.user.findUnique.mockResolvedValue({ avatar: null });
    prismaMock.roster.findMany.mockResolvedValue([
      { course: { isArchived: false, isPublished: true } },
    ]);

    const req = new NextRequest('http://localhost/api/users/u1', {
      method: 'PATCH',
      body: JSON.stringify({ inactive: true }),
    });

    const res = await PATCH(req, { params: Promise.resolve({ id: 'u1' }) });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('Users in an active course cannot be inactive');
  });

  it('allows setting user inactive when not in active courses', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'ADMIN' } });
    prismaMock.user.findUnique.mockResolvedValue({ avatar: null });
    prismaMock.roster.findMany.mockResolvedValue([]);
    prismaMock.user.update.mockResolvedValue({
      id: 'u1',
      email: 'u1@example.com',
      firstName: 'A',
      lastName: 'B',
      role: 'ADMIN',
      inactive: true,
      avatar: null,
      timezone: null,
    });

    const req = new NextRequest('http://localhost/api/users/u1', {
      method: 'PATCH',
      body: JSON.stringify({ inactive: true }),
    });

    const res = await PATCH(req, { params: Promise.resolve({ id: 'u1' }) });

    expect(res.status).toBe(200);
  });

  /**
   * Switching an account off has to be one decision with automatic identity linking, or a
   * sign-in arriving at that moment attaches an identity to an account that is disabled by the
   * time the identity exists. The read of the identities is what makes the two conflict in
   * Postgres rather than both committing, so it is asserted here as well as in the DB test.
   */
  it('switches an account off in one serializable decision, reading its identities', async () => {
    authMock.mockResolvedValue({ user: { id: 'admin', role: 'ADMIN', isAdmin: true } });
    prismaMock.user.findUnique.mockResolvedValue({ avatar: null, isAdmin: false, inactive: false });
    prismaMock.roster.findMany.mockResolvedValue([]);
    prismaMock.user.update.mockResolvedValue({ id: 'u1', email: 'u1@example.com', inactive: true });

    const req = new NextRequest('http://localhost/api/users/u1', {
      method: 'PATCH',
      body: JSON.stringify({ inactive: true }),
    });

    const res = await PATCH(req, { params: Promise.resolve({ id: 'u1' }) });

    expect(res.status).toBe(200);
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    expect(prismaMock.$transaction.mock.calls[0][1]).toEqual({ isolationLevel: 'Serializable' });
    expect(prismaMock.linkedIdentity.count).toHaveBeenCalledWith({ where: { userId: 'u1' } });
  });

  it('records how many ways in the account had when it was switched off', async () => {
    authMock.mockResolvedValue({ user: { id: 'admin', role: 'ADMIN', isAdmin: true } });
    prismaMock.user.findUnique.mockResolvedValue({ avatar: null, isAdmin: false, inactive: false });
    prismaMock.roster.findMany.mockResolvedValue([]);
    prismaMock.user.update.mockResolvedValue({ id: 'u1', email: 'u1@example.com', inactive: true });
    prismaMock.linkedIdentity.count.mockResolvedValueOnce(2);

    const req = new NextRequest('http://localhost/api/users/u1', {
      method: 'PATCH',
      body: JSON.stringify({ inactive: true }),
    });

    await PATCH(req, { params: Promise.resolve({ id: 'u1' }) });

    const entry = activityLogMock.mock.calls.find(
      (call) => call[2]?.action === 'UPDATE_USER',
    )?.[2];
    expect(entry?.metadata).toMatchObject({ identitiesWhenDisabled: 2 });
  });

  /** An ordinary edit touches none of this, and should not pay for a transaction. */
  it('does not open a transaction for an edit that changes no account state', async () => {
    authMock.mockResolvedValue({ user: { id: 'admin', role: 'ADMIN', isAdmin: true } });
    prismaMock.user.findUnique.mockResolvedValue({ avatar: null, isAdmin: false, inactive: false });
    prismaMock.roster.findMany.mockResolvedValue([]);
    prismaMock.user.update.mockResolvedValue({ id: 'u1', email: 'u1@example.com' });

    const req = new NextRequest('http://localhost/api/users/u1', {
      method: 'PATCH',
      body: JSON.stringify({ firstName: 'Renamed' }),
    });

    await PATCH(req, { params: Promise.resolve({ id: 'u1' }) });

    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  /** Already off, so there is no transition for anything to race with. */
  it('does not coordinate when the account was already switched off', async () => {
    authMock.mockResolvedValue({ user: { id: 'admin', role: 'ADMIN', isAdmin: true } });
    prismaMock.user.findUnique.mockResolvedValue({ avatar: null, isAdmin: false, inactive: true });
    prismaMock.roster.findMany.mockResolvedValue([]);
    prismaMock.user.update.mockResolvedValue({ id: 'u1', email: 'u1@example.com', inactive: true });

    const req = new NextRequest('http://localhost/api/users/u1', {
      method: 'PATCH',
      body: JSON.stringify({ inactive: true }),
    });

    await PATCH(req, { params: Promise.resolve({ id: 'u1' }) });

    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it('allows setting user inactive when in archived courses', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'ADMIN' } });
    prismaMock.user.findUnique.mockResolvedValue({ avatar: null });
    prismaMock.roster.findMany.mockResolvedValue([
      { course: { isArchived: true, isPublished: true } },
    ]);
    prismaMock.user.update.mockResolvedValue({
      id: 'u1',
      email: 'u1@example.com',
      firstName: 'A',
      lastName: 'B',
      role: 'ADMIN',
      inactive: true,
      avatar: null,
      timezone: null,
    });

    const req = new NextRequest('http://localhost/api/users/u1', {
      method: 'PATCH',
      body: JSON.stringify({ inactive: true }),
    });

    const res = await PATCH(req, { params: Promise.resolve({ id: 'u1' }) });

    expect(res.status).toBe(200);
  });

  it('allows setting user inactive when in unpublished courses', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'ADMIN' } });
    prismaMock.user.findUnique.mockResolvedValue({ avatar: null });
    prismaMock.roster.findMany.mockResolvedValue([
      { course: { isArchived: false, isPublished: false } },
    ]);
    prismaMock.user.update.mockResolvedValue({
      id: 'u1',
      email: 'u1@example.com',
      firstName: 'A',
      lastName: 'B',
      role: 'ADMIN',
      inactive: true,
      avatar: null,
      timezone: null,
    });

    const req = new NextRequest('http://localhost/api/users/u1', {
      method: 'PATCH',
      body: JSON.stringify({ inactive: true }),
    });

    const res = await PATCH(req, { params: Promise.resolve({ id: 'u1' }) });

    expect(res.status).toBe(200);
  });

  it('updates user and logs activity', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'ADMIN' } });
    prismaMock.user.findUnique.mockResolvedValue({ avatar: null });
    prismaMock.user.update.mockResolvedValue({
      id: 'u1',
      email: 'u1@example.com',
      firstName: 'A',
      lastName: 'B',
      role: 'ADMIN',
      inactive: false,
      avatar: null,
      timezone: 'America/New_York',
    });

    const req = new NextRequest('http://localhost/api/users/u1', {
      method: 'PATCH',
      body: JSON.stringify({ firstName: 'A', lastName: 'B', timezone: 'America/New_York' }),
    });

    const res = await PATCH(req, { params: Promise.resolve({ id: 'u1' }) });

    expect(res.status).toBe(200);
    expect(prismaMock.user.update).toHaveBeenCalled();
    expect(activityLogMock).toHaveBeenCalled();
  });

  it('returns 500 when database update fails', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'ADMIN' } });
    prismaMock.user.findUnique.mockResolvedValue({ avatar: null });
    prismaMock.user.update.mockRejectedValue(new Error('Database error'));

    const req = new NextRequest('http://localhost/api/users/u1', {
      method: 'PATCH',
      body: JSON.stringify({ firstName: 'A' }),
    });

    const res = await PATCH(req, { params: Promise.resolve({ id: 'u1' }) });

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('Failed to update user');
  });

  it('returns 409 when demoting the last active admin', async () => {
    authMock.mockResolvedValue({ user: { id: 'admin', role: 'ADMIN', isAdmin: true } });
    prismaMock.user.findUnique.mockResolvedValue({
      avatar: null,
      firstName: 'A',
      lastName: 'B',
      isAdmin: true,
      inactive: false,
      timezone: null,
    });
    prismaMock.user.count.mockResolvedValue(0); // no other active admin

    const req = new NextRequest('http://localhost/api/users/admin', {
      method: 'PATCH',
      body: JSON.stringify({ isAdmin: false }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ id: 'admin' }) });

    expect(res.status).toBe(409);
    expect(prismaMock.user.update).not.toHaveBeenCalled();
  });

  it('returns 409 when deactivating the last active admin', async () => {
    authMock.mockResolvedValue({ user: { id: 'admin', role: 'ADMIN', isAdmin: true } });
    prismaMock.user.findUnique.mockResolvedValue({
      avatar: null,
      firstName: 'A',
      lastName: 'B',
      isAdmin: true,
      inactive: false,
      timezone: null,
    });
    prismaMock.user.count.mockResolvedValue(0);

    const req = new NextRequest('http://localhost/api/users/admin', {
      method: 'PATCH',
      body: JSON.stringify({ inactive: true }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ id: 'admin' }) });

    expect(res.status).toBe(409);
    expect(prismaMock.user.update).not.toHaveBeenCalled();
  });

  it('allows demoting an admin when another active admin remains', async () => {
    authMock.mockResolvedValue({ user: { id: 'admin', role: 'ADMIN', isAdmin: true } });
    prismaMock.user.findUnique.mockResolvedValue({
      avatar: null,
      firstName: 'A',
      lastName: 'B',
      isAdmin: true,
      inactive: false,
      timezone: null,
    });
    prismaMock.user.count.mockResolvedValue(1);
    prismaMock.user.update.mockResolvedValue({
      id: 'admin',
      email: 'a@example.com',
      firstName: 'A',
      lastName: 'B',
      isAdmin: false,
      inactive: false,
      avatar: null,
      timezone: null,
    });

    const req = new NextRequest('http://localhost/api/users/admin', {
      method: 'PATCH',
      body: JSON.stringify({ isAdmin: false }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ id: 'admin' }) });

    expect(res.status).toBe(200);
    expect(prismaMock.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ isAdmin: false }) }),
    );
  });

  it('lets an admin change a user email to an unused address', async () => {
    authMock.mockResolvedValue({ user: { id: 'admin', role: 'ADMIN', isAdmin: true } });
    prismaMock.user.findUnique.mockResolvedValue({ avatar: null, email: 'old@example.com' });
    prismaMock.user.findFirst.mockResolvedValue(null); // not taken
    prismaMock.user.update.mockResolvedValue({
      id: 'u1',
      email: 'new@example.com',
      firstName: 'A',
      lastName: 'B',
      isAdmin: false,
      inactive: false,
      avatar: null,
      timezone: null,
    });

    const req = new NextRequest('http://localhost/api/users/u1', {
      method: 'PATCH',
      body: JSON.stringify({ email: 'New@Example.com' }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ id: 'u1' }) });

    expect(res.status).toBe(200);
    // The schema lowercases the address before it reaches the DB.
    expect(prismaMock.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ email: 'new@example.com' }) }),
    );
  });

  it('returns 409 when the new email is already in use', async () => {
    authMock.mockResolvedValue({ user: { id: 'admin', role: 'ADMIN', isAdmin: true } });
    prismaMock.user.findUnique.mockResolvedValue({ avatar: null, email: 'old@example.com' });
    prismaMock.user.findFirst.mockResolvedValue({ id: 'someone-else' }); // taken

    const req = new NextRequest('http://localhost/api/users/u1', {
      method: 'PATCH',
      body: JSON.stringify({ email: 'taken@example.com' }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ id: 'u1' }) });

    expect(res.status).toBe(409);
    expect(prismaMock.user.update).not.toHaveBeenCalled();
  });

  it('ignores an email change from a non-admin editing their own account', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'STUDENT' } });
    prismaMock.user.findUnique.mockResolvedValue({ avatar: null, email: 'old@example.com' });
    prismaMock.user.update.mockResolvedValue({
      id: 'u1',
      email: 'old@example.com',
      firstName: 'A',
      lastName: 'B',
      isAdmin: false,
      inactive: false,
      avatar: null,
      timezone: null,
    });

    const req = new NextRequest('http://localhost/api/users/u1', {
      method: 'PATCH',
      body: JSON.stringify({ email: 'new@example.com' }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ id: 'u1' }) });

    expect(res.status).toBe(200);
    // No uniqueness check runs, and the email is not part of the write.
    expect(prismaMock.user.findFirst).not.toHaveBeenCalled();
    expect(prismaMock.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ email: undefined }) }),
    );
  });

  it('surfaces a unique-constraint race on email as a 409', async () => {
    authMock.mockResolvedValue({ user: { id: 'admin', role: 'ADMIN', isAdmin: true } });
    prismaMock.user.findUnique.mockResolvedValue({ avatar: null, email: 'old@example.com' });
    prismaMock.user.findFirst.mockResolvedValue(null); // passes the pre-check
    prismaMock.user.update.mockRejectedValue(Object.assign(new Error('unique'), { code: 'P2002' }));

    const req = new NextRequest('http://localhost/api/users/u1', {
      method: 'PATCH',
      body: JSON.stringify({ email: 'raced@example.com' }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ id: 'u1' }) });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('That email is already in use');
  });
});

describe('DELETE /api/users/[id]', () => {
  it('returns 403 when forbidden', async () => {
    authMock.mockResolvedValue(null);

    const req = new NextRequest('http://localhost/api/users/u1', { method: 'DELETE' });
    const res = await DELETE(req, { params: Promise.resolve({ id: 'u1' }) });

    expect(res.status).toBe(403);
  });

  it('returns 403 when user is STUDENT', async () => {
    authMock.mockResolvedValue({ user: { id: 'student', role: 'STUDENT' } });

    const req = new NextRequest('http://localhost/api/users/u1', { method: 'DELETE' });
    const res = await DELETE(req, { params: Promise.resolve({ id: 'u1' }) });

    expect(res.status).toBe(403);
  });

  it('returns 403 when an admin tries to delete their own account', async () => {
    authMock.mockResolvedValue({ user: { id: 'admin', role: 'ADMIN', isAdmin: true } });

    const req = new NextRequest('http://localhost/api/users/admin', { method: 'DELETE' });
    const res = await DELETE(req, { params: Promise.resolve({ id: 'admin' }) });

    expect(res.status).toBe(403);
    expect(prismaMock.user.delete).not.toHaveBeenCalled();
  });

  it('returns 403 when the acting admin is inactive', async () => {
    authMock.mockResolvedValue({
      user: { id: 'admin', role: 'ADMIN', isAdmin: true, inactive: true },
    });

    const req = new NextRequest('http://localhost/api/users/u1', { method: 'DELETE' });
    const res = await DELETE(req, { params: Promise.resolve({ id: 'u1' }) });

    expect(res.status).toBe(403);
    expect(prismaMock.user.delete).not.toHaveBeenCalled();
  });

  it('allows ADMIN to delete user', async () => {
    authMock.mockResolvedValue({ user: { id: 'admin', role: 'ADMIN', isAdmin: true } });
    prismaMock.user.findUnique.mockResolvedValue({ avatar: null });
    prismaMock.user.delete.mockResolvedValue({
      id: 'u1',
      email: 'u1@example.com',
      firstName: 'A',
      lastName: 'B',
      role: 'STUDENT',
      inactive: false,
      avatar: null,
      timezone: null,
      password: 'hashed',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const req = new NextRequest('http://localhost/api/users/u1', { method: 'DELETE' });
    const res = await DELETE(req, { params: Promise.resolve({ id: 'u1' }) });

    expect(res.status).toBe(200);
    expect(prismaMock.user.delete).toHaveBeenCalledWith({ where: { id: 'u1' } });
  });

  it('denies a non-admin FACULTY deleting a user', async () => {
    authMock.mockResolvedValue({ user: { id: 'faculty', role: 'FACULTY' } });

    const req = new NextRequest('http://localhost/api/users/u1', { method: 'DELETE' });
    const res = await DELETE(req, { params: Promise.resolve({ id: 'u1' }) });

    expect(res.status).toBe(403);
    expect(prismaMock.user.delete).not.toHaveBeenCalled();
  });

  it('denies a non-admin TA deleting a user', async () => {
    authMock.mockResolvedValue({ user: { id: 'ta', role: 'TA' } });

    const req = new NextRequest('http://localhost/api/users/u1', { method: 'DELETE' });
    const res = await DELETE(req, { params: Promise.resolve({ id: 'u1' }) });

    expect(res.status).toBe(403);
    expect(prismaMock.user.delete).not.toHaveBeenCalled();
  });

  it('deletes avatar file when user has avatar', async () => {
    authMock.mockResolvedValue({ user: { id: 'admin', role: 'ADMIN', isAdmin: true } });
    prismaMock.user.findUnique.mockResolvedValue({ avatar: 'user-avatar.png' });
    prismaMock.user.delete.mockResolvedValue({
      id: 'u1',
      email: 'u1@example.com',
      firstName: 'A',
      lastName: 'B',
      role: 'STUDENT',
      inactive: false,
      avatar: 'user-avatar.png',
      timezone: null,
      password: 'hashed',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const req = new NextRequest('http://localhost/api/users/u1', { method: 'DELETE' });
    const res = await DELETE(req, { params: Promise.resolve({ id: 'u1' }) });

    expect(res.status).toBe(200);
    expect(unlinkMock).toHaveBeenCalled();
  });

  it('still deletes the user when removing the avatar file fails', async () => {
    authMock.mockResolvedValue({ user: { id: 'admin', role: 'ADMIN', isAdmin: true } });
    prismaMock.user.findUnique.mockResolvedValue({ avatar: 'user-avatar.png' });
    prismaMock.user.delete.mockResolvedValue({
      id: 'u1',
      email: 'u1@example.com',
      firstName: 'A',
      lastName: 'B',
      role: 'STUDENT',
      inactive: false,
      avatar: 'user-avatar.png',
      timezone: null,
      password: 'hashed',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    unlinkMock.mockRejectedValue(new Error('fs error'));

    const req = new NextRequest('http://localhost/api/users/u1', { method: 'DELETE' });
    const res = await DELETE(req, { params: Promise.resolve({ id: 'u1' }) });

    // The unlink rejection is swallowed by the .catch() handler.
    expect(res.status).toBe(200);
    expect(prismaMock.user.delete).toHaveBeenCalled();
  });

  it('skips avatar deletion when user has no avatar', async () => {
    authMock.mockResolvedValue({ user: { id: 'admin', role: 'ADMIN', isAdmin: true } });
    prismaMock.user.findUnique.mockResolvedValue({ avatar: null });
    prismaMock.user.delete.mockResolvedValue({
      id: 'u1',
      email: 'u1@example.com',
      firstName: 'A',
      lastName: 'B',
      role: 'STUDENT',
      inactive: false,
      avatar: null,
      timezone: null,
      password: 'hashed',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const req = new NextRequest('http://localhost/api/users/u1', { method: 'DELETE' });
    const res = await DELETE(req, { params: Promise.resolve({ id: 'u1' }) });

    expect(res.status).toBe(200);
    expect(unlinkMock).not.toHaveBeenCalled();
  });

  it("preserves the deleted user's activity logs (audit trail)", async () => {
    authMock.mockResolvedValue({ user: { id: 'admin', role: 'ADMIN', isAdmin: true } });
    prismaMock.user.findUnique.mockResolvedValue({ avatar: null });
    prismaMock.user.delete.mockResolvedValue({
      id: 'u1',
      email: 'u1@example.com',
      firstName: 'A',
      lastName: 'B',
      role: 'STUDENT',
      inactive: false,
      avatar: null,
      timezone: null,
      password: 'hashed',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const req = new NextRequest('http://localhost/api/users/u1', { method: 'DELETE' });
    await DELETE(req, { params: Promise.resolve({ id: 'u1' }) });

    // The user's logs are intentionally NOT wiped: onDelete: SetNull keeps the
    // audit trail (userId nulled), so their history survives deletion.
    expect(prismaMock.activityLog.deleteMany).not.toHaveBeenCalled();
    expect(prismaMock.user.delete).toHaveBeenCalledWith({ where: { id: 'u1' } });
  });

  it('deletes user and logs activity', async () => {
    authMock.mockResolvedValue({ user: { id: 'admin', role: 'ADMIN', isAdmin: true } });
    prismaMock.user.findUnique.mockResolvedValue({ avatar: 'avatar.png' });
    prismaMock.user.delete.mockResolvedValue({
      id: 'u1',
      email: 'u1@example.com',
      firstName: 'A',
      lastName: 'B',
      role: 'STUDENT',
      inactive: false,
      avatar: 'avatar.png',
      timezone: null,
      password: 'hashed',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const req = new NextRequest('http://localhost/api/users/u1', { method: 'DELETE' });
    const res = await DELETE(req, { params: Promise.resolve({ id: 'u1' }) });

    expect(res.status).toBe(200);
    expect(prismaMock.user.delete).toHaveBeenCalled();
    expect(activityLogMock).toHaveBeenCalled();
  });

  it('returns 500 when deletion fails', async () => {
    authMock.mockResolvedValue({ user: { id: 'admin', role: 'ADMIN', isAdmin: true } });
    prismaMock.user.findUnique.mockResolvedValue({ avatar: null });
    prismaMock.user.delete.mockRejectedValue(new Error('Database error'));

    const req = new NextRequest('http://localhost/api/users/u1', { method: 'DELETE' });
    const res = await DELETE(req, { params: Promise.resolve({ id: 'u1' }) });

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('Failed to delete user');
  });

  it('returns 500 with "unknown error" when a non-Error value is thrown', async () => {
    authMock.mockResolvedValue({ user: { id: 'admin', role: 'ADMIN', isAdmin: true } });
    prismaMock.user.findUnique.mockResolvedValue({ avatar: null });
    prismaMock.user.delete.mockRejectedValue('a plain string');

    const req = new NextRequest('http://localhost/api/users/u1', { method: 'DELETE' });
    const res = await DELETE(req, { params: Promise.resolve({ id: 'u1' }) });

    expect(res.status).toBe(500);
    expect(activityLogMock).toHaveBeenCalledWith(
      prismaMock,
      req,
      expect.objectContaining({
        action: 'USER_DELETE_ERROR',
        metadata: expect.objectContaining({ error: 'unknown error' }),
      }),
    );
  });
});

describe('GET /api/users/[id]', () => {
  it('returns 405 for GET method', async () => {
    const res = await GET();

    expect(res.status).toBe(405);
    const body = await res.json();
    expect(body.error).toBe('Method not allowed');
  });
});

describe('POST /api/users/[id]', () => {
  it('returns 405 for POST method', async () => {
    const res = await POST();

    expect(res.status).toBe(405);
    const body = await res.json();
    expect(body.error).toBe('Method not allowed');
  });
});

/**
 * Ordering between the database and the file.
 *
 * The row is the live account; the avatar is a file it points at. Removing the file first meant
 * a failed delete left a working account whose photo had been deleted out from under it, with
 * nothing on screen to say why. An orphaned file is the cheaper failure.
 */
describe('deleting a user', () => {
  const asAdmin = () =>
    authMock.mockResolvedValue({ user: { id: 'admin', role: 'ADMIN', isAdmin: true } });

  const deleteRequest = () =>
    DELETE(new NextRequest('http://localhost/api/users/u2', { method: 'DELETE' }), {
      params: Promise.resolve({ id: 'u2' }),
    });

  beforeEach(() => {
    asAdmin();
    prismaMock.user.findUnique.mockResolvedValue({
      avatar: 'photo.png',
      email: 'gone@example.test',
      firstName: 'Gone',
      lastName: 'Away',
      isAdmin: false,
      inactive: false,
    });
    prismaMock.roster.findMany.mockResolvedValue([]);
  });

  it('keeps the avatar when the database delete fails', async () => {
    prismaMock.user.delete.mockRejectedValue(new Error('database is down'));

    const res = await deleteRequest();

    expect(res.status).toBe(500);
    // The account still exists, so its photo must still exist too.
    expect(unlinkMock).not.toHaveBeenCalled();
  });

  it('removes the avatar once the row is gone', async () => {
    prismaMock.user.delete.mockResolvedValue({ id: 'u2' });

    const res = await deleteRequest();

    expect(res.status).toBe(200);
    expect(unlinkMock).toHaveBeenCalled();
  });

  it('still reports the deletion when the avatar cannot be removed', async () => {
    // The account is already gone; failing here would report a deletion that did happen as
    // one that did not, and there is nothing for anybody to do about a stray file.
    prismaMock.user.delete.mockResolvedValue({ id: 'u2' });
    unlinkMock.mockRejectedValueOnce(new Error('permission denied'));

    expect((await deleteRequest()).status).toBe(200);
  });
});
