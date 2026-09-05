import { beforeEach, describe, expect, it, vi } from 'vitest';

const prismaMock = vi.hoisted(() => ({
  roster: { findFirst: vi.fn() },
  course: { findUnique: vi.fn() },
  groupMembership: { findFirst: vi.fn() },
}));
vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }));

import {
  isAdmin,
  getCourseRole,
  canAccessCourse,
  canManageCourse,
  isCourseArchived,
  isCourseStaffAnywhere,
  staffManagesStudent,
  isMemberOfGroup,
  canViewStudentData,
} from './permissions';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('isAdmin', () => {
  it('is true only when the flag is set', () => {
    expect(isAdmin({ id: 'u', isAdmin: true })).toBe(true);
    expect(isAdmin({ id: 'u', isAdmin: false })).toBe(false);
    expect(isAdmin({ id: 'u' })).toBe(false);
    expect(isAdmin(null)).toBe(false);
    expect(isAdmin(undefined)).toBe(false);
  });
});

describe('getCourseRole', () => {
  it('returns the roster role for the course', async () => {
    prismaMock.roster.findFirst.mockResolvedValue({ role: 'FACULTY' });
    await expect(getCourseRole('u', 'c')).resolves.toBe('FACULTY');
  });

  it('returns null when the user is not on the roster', async () => {
    prismaMock.roster.findFirst.mockResolvedValue(null);
    await expect(getCourseRole('u', 'c')).resolves.toBeNull();
  });

  it('returns the role for an ENROLLED student', async () => {
    prismaMock.roster.findFirst.mockResolvedValue({ role: 'STUDENT', status: 'ENROLLED' });
    await expect(getCourseRole('u', 'c')).resolves.toBe('STUDENT');
  });

  it('returns null for a DROPPED student (treated as a non-member)', async () => {
    prismaMock.roster.findFirst.mockResolvedValue({ role: 'STUDENT', status: 'DROPPED' });
    await expect(getCourseRole('u', 'c')).resolves.toBeNull();
  });

  it('short-circuits (no DB call) when an id is missing', async () => {
    await expect(getCourseRole(null, 'c')).resolves.toBeNull();
    await expect(getCourseRole('u', undefined)).resolves.toBeNull();
    expect(prismaMock.roster.findFirst).not.toHaveBeenCalled();
  });
});

describe('canAccessCourse', () => {
  it('admins may access any live course without a roster lookup', async () => {
    await expect(canAccessCourse({ id: 'a', isAdmin: true }, 'c')).resolves.toBe(true);
    expect(prismaMock.roster.findFirst).not.toHaveBeenCalled();
  });

  it('denies even an admin on a soft-deleted course', async () => {
    prismaMock.course.findUnique.mockResolvedValue({ deletedAt: new Date() });
    await expect(canAccessCourse({ id: 'a', isAdmin: true }, 'c')).resolves.toBe(false);
  });

  it('falls open (allows the admin) when the soft-delete lookup errors', async () => {
    prismaMock.course.findUnique.mockRejectedValue(new Error('db down'));
    await expect(canAccessCourse({ id: 'a', isAdmin: true }, 'c')).resolves.toBe(true);
  });

  it('an ENROLLED student may access an enrolled PUBLISHED course', async () => {
    prismaMock.roster.findFirst.mockResolvedValue({
      role: 'STUDENT',
      status: 'ENROLLED',
      course: { isPublished: true, deletedAt: null },
    });
    await expect(canAccessCourse({ id: 'u', isAdmin: false }, 'c')).resolves.toBe(true);
  });

  it('a student may NOT access an enrolled UNPUBLISHED course', async () => {
    prismaMock.roster.findFirst.mockResolvedValue({
      role: 'STUDENT',
      status: 'ENROLLED',
      course: { isPublished: false, deletedAt: null },
    });
    await expect(canAccessCourse({ id: 'u', isAdmin: false }, 'c')).resolves.toBe(false);
  });

  it('a DROPPED student may NOT access even a published course', async () => {
    prismaMock.roster.findFirst.mockResolvedValue({
      role: 'STUDENT',
      status: 'DROPPED',
      course: { isPublished: true, deletedAt: null },
    });
    await expect(canAccessCourse({ id: 'u', isAdmin: false }, 'c')).resolves.toBe(false);
  });

  it('a student may NOT access a published course that has not started yet', async () => {
    prismaMock.roster.findFirst.mockResolvedValue({
      role: 'STUDENT',
      status: 'ENROLLED',
      course: { isPublished: true, deletedAt: null, startDate: new Date('2099-01-01') },
    });
    await expect(canAccessCourse({ id: 'u', isAdmin: false }, 'c')).resolves.toBe(false);
  });

  it('a student may access it once the start date has passed', async () => {
    prismaMock.roster.findFirst.mockResolvedValue({
      role: 'STUDENT',
      status: 'ENROLLED',
      course: { isPublished: true, deletedAt: null, startDate: new Date('2000-01-01') },
    });
    await expect(canAccessCourse({ id: 'u', isAdmin: false }, 'c')).resolves.toBe(true);
  });

  it('staff may build a course before it opens', async () => {
    prismaMock.roster.findFirst.mockResolvedValue({
      role: 'FACULTY',
      course: { isPublished: true, deletedAt: null, startDate: new Date('2099-01-01') },
    });
    await expect(canAccessCourse({ id: 'u' }, 'c')).resolves.toBe(true);
  });

  it('staff (FACULTY/TA) may access their course even while unpublished', async () => {
    prismaMock.roster.findFirst.mockResolvedValue({
      role: 'FACULTY',
      course: { isPublished: false, deletedAt: null },
    });
    await expect(canAccessCourse({ id: 'u' }, 'c')).resolves.toBe(true);

    prismaMock.roster.findFirst.mockResolvedValue({
      role: 'TA',
      course: { isPublished: false, deletedAt: null },
    });
    await expect(canAccessCourse({ id: 'u' }, 'c')).resolves.toBe(true);
  });

  it('non-enrolled non-admins may not', async () => {
    prismaMock.roster.findFirst.mockResolvedValue(null);
    await expect(canAccessCourse({ id: 'u' }, 'c')).resolves.toBe(false);
  });

  it('a non-admin may NOT access a soft-deleted course, even as staff', async () => {
    prismaMock.roster.findFirst.mockResolvedValue({
      role: 'FACULTY',
      course: { isPublished: true, deletedAt: new Date() },
    });
    await expect(canAccessCourse({ id: 'u' }, 'c')).resolves.toBe(false);
  });

  it('anonymous callers may not', async () => {
    await expect(canAccessCourse(null, 'c')).resolves.toBe(false);
  });
});

describe('canManageCourse', () => {
  it('admins may manage any live course', async () => {
    await expect(canManageCourse({ id: 'a', isAdmin: true }, 'c')).resolves.toBe(true);
    expect(prismaMock.roster.findFirst).not.toHaveBeenCalled();
  });

  it('denies even an admin on a soft-deleted course', async () => {
    prismaMock.course.findUnique.mockResolvedValue({ deletedAt: new Date() });
    await expect(canManageCourse({ id: 'a', isAdmin: true }, 'c')).resolves.toBe(false);
  });

  it('faculty and TAs may manage by default', async () => {
    prismaMock.roster.findFirst.mockResolvedValue({ role: 'TA', course: { deletedAt: null } });
    await expect(canManageCourse({ id: 'u' }, 'c')).resolves.toBe(true);
  });

  it('students may not manage', async () => {
    prismaMock.roster.findFirst.mockResolvedValue({ role: 'STUDENT', course: { deletedAt: null } });
    await expect(canManageCourse({ id: 'u' }, 'c')).resolves.toBe(false);
  });

  it('respects a narrower role set (FACULTY only excludes TAs)', async () => {
    prismaMock.roster.findFirst.mockResolvedValue({ role: 'TA', course: { deletedAt: null } });
    await expect(canManageCourse({ id: 'u' }, 'c', ['FACULTY'])).resolves.toBe(false);
  });

  it('a non-admin staff member may NOT manage a soft-deleted course', async () => {
    prismaMock.roster.findFirst.mockResolvedValue({
      role: 'FACULTY',
      course: { deletedAt: new Date() },
    });
    await expect(canManageCourse({ id: 'u' }, 'c')).resolves.toBe(false);
  });
});

describe('isCourseArchived', () => {
  it('is true when the course row is archived', async () => {
    prismaMock.course.findUnique.mockResolvedValue({ isArchived: true });
    await expect(isCourseArchived('c')).resolves.toBe(true);
  });

  it('is false when not archived or the course is missing', async () => {
    prismaMock.course.findUnique.mockResolvedValue({ isArchived: false });
    await expect(isCourseArchived('c')).resolves.toBe(false);
    prismaMock.course.findUnique.mockResolvedValue(null);
    await expect(isCourseArchived('c')).resolves.toBe(false);
  });
});

describe('isCourseStaffAnywhere', () => {
  it('is true for an admin without asking the database', async () => {
    await expect(isCourseStaffAnywhere({ id: 'a', isAdmin: true })).resolves.toBe(true);
    expect(prismaMock.roster.findFirst).not.toHaveBeenCalled();
  });

  it('is true for somebody with a staff role in a live course', async () => {
    prismaMock.roster.findFirst.mockResolvedValue({ id: 'r1' });
    await expect(isCourseStaffAnywhere({ id: 'f1' })).resolves.toBe(true);
    expect(prismaMock.roster.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId: 'f1',
          role: { in: ['FACULTY', 'TA'] },
          course: { deletedAt: null },
        },
      }),
    );
  });

  it('is false for a student, and for nobody at all', async () => {
    prismaMock.roster.findFirst.mockResolvedValue(null);
    await expect(isCourseStaffAnywhere({ id: 's1' })).resolves.toBe(false);
    await expect(isCourseStaffAnywhere(null)).resolves.toBe(false);
  });
});

describe('staffManagesStudent', () => {
  it('admins manage any account without a lookup', async () => {
    await expect(staffManagesStudent({ id: 'a', isAdmin: true }, 't')).resolves.toBe(true);
    expect(prismaMock.roster.findFirst).not.toHaveBeenCalled();
  });

  it('is true when the target is a STUDENT in a course the caller staffs', async () => {
    prismaMock.roster.findFirst.mockResolvedValue({ id: 'r1' });
    await expect(staffManagesStudent({ id: 's' }, 't')).resolves.toBe(true);
    // The query pins the target to a STUDENT roster whose course rosters the caller as staff.
    expect(prismaMock.roster.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: 't', role: 'STUDENT' }),
      }),
    );
  });

  it('is false when no such relationship exists', async () => {
    prismaMock.roster.findFirst.mockResolvedValue(null);
    await expect(staffManagesStudent({ id: 's' }, 't')).resolves.toBe(false);
  });

  it('anonymous callers manage no one', async () => {
    await expect(staffManagesStudent(null, 't')).resolves.toBe(false);
    expect(prismaMock.roster.findFirst).not.toHaveBeenCalled();
  });
});

describe('isMemberOfGroup', () => {
  it('is true when the user holds a membership in that group', async () => {
    prismaMock.groupMembership.findFirst.mockResolvedValue({ id: 'gm1' });
    await expect(isMemberOfGroup('g1', 'u')).resolves.toBe(true);
    // Scoped to the specific group id, not "any group in the course".
    expect(prismaMock.groupMembership.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { groupId: 'g1', userId: 'u' } }),
    );
  });

  it('is false with no membership or a missing id', async () => {
    prismaMock.groupMembership.findFirst.mockResolvedValue(null);
    await expect(isMemberOfGroup('g1', 'u')).resolves.toBe(false);
    await expect(isMemberOfGroup(null, 'u')).resolves.toBe(false);
    await expect(isMemberOfGroup('g1', null)).resolves.toBe(false);
  });
});

describe('canViewStudentData', () => {
  it('admins and staff may view anyone', async () => {
    await expect(canViewStudentData({ id: 'a', isAdmin: true }, 'c', 't')).resolves.toBe(true);
    prismaMock.roster.findFirst.mockResolvedValue({ role: 'FACULTY' }); // canManageCourse → true
    await expect(canViewStudentData({ id: 's' }, 'c', 't')).resolves.toBe(true);
  });

  it('a student may view their own data', async () => {
    await expect(canViewStudentData({ id: 'u' }, 'c', 'u')).resolves.toBe(true);
  });

  it('a non-staff student may not view another student on an individual assignment', async () => {
    prismaMock.roster.findFirst.mockResolvedValue({ role: 'STUDENT' }); // not staff
    await expect(canViewStudentData({ id: 'u' }, 'c', 'other')).resolves.toBe(false);
  });

  it('a member of the owning group may view that group submission', async () => {
    prismaMock.roster.findFirst.mockResolvedValue({ role: 'STUDENT' }); // not staff
    prismaMock.groupMembership.findFirst.mockResolvedValue({ id: 'gm1' }); // in that group
    await expect(
      canViewStudentData({ id: 'u' }, 'c', 'mate', { studentGroupId: 'g1' }),
    ).resolves.toBe(true);
  });

  it('a non-member is denied even if they share some other group in the course', async () => {
    prismaMock.roster.findFirst.mockResolvedValue({ role: 'STUDENT' }); // not staff
    // Not a member of the submission's owning group → denied, regardless of any other
    // group they might co-inhabit with the owner (cross-group-set leak guard).
    prismaMock.groupMembership.findFirst.mockResolvedValue(null);
    await expect(
      canViewStudentData({ id: 'u' }, 'c', 'mate', { studentGroupId: 'g1' }),
    ).resolves.toBe(false);
  });

  it('an individual submission (no owning group) is never cross-visible', async () => {
    prismaMock.roster.findFirst.mockResolvedValue({ role: 'STUDENT' }); // not staff
    await expect(
      canViewStudentData({ id: 'u' }, 'c', 'other', { studentGroupId: null }),
    ).resolves.toBe(false);
  });
});
