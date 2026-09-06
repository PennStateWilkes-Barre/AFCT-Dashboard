import { beforeEach, describe, expect, it, vi } from 'vitest';
import { overridesForStudentWhere } from '@/lib/assignment-visibility';

const prismaMock = vi.hoisted(() => ({
  assignment: { findFirst: vi.fn() },
  assignmentOverride: { findMany: vi.fn() },
}));

vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }));

import { resolveStudentContentGate } from './assignment-student-gate';

const NOW = new Date('2026-07-20T12:00:00.000Z');
const base = {
  unlockAt: null as Date | null,
  dueDate: new Date('2026-08-01T23:59:00.000Z'),
  allowLateSubmissions: false,
  lateCutoff: null as Date | null,
};

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.assignmentOverride.findMany.mockResolvedValue([]);
});

describe('resolveStudentContentGate', () => {
  it('reports not assigned when the membership-filtered lookup finds nothing', async () => {
    prismaMock.assignment.findFirst.mockResolvedValue(null);

    const gate = await resolveStudentContentGate('a1', 'stu-1', NOW);

    expect(gate).toEqual({ assigned: false, locked: true, unlockAt: null });
    // The lookup must carry the membership filter, not just the id.
    const where = prismaMock.assignment.findFirst.mock.calls[0][0].where;
    expect(where.id).toBe('a1');
    expect(where.OR).toEqual([
      { assignedToEveryone: true },
      { assignees: { some: { userId: 'stu-1' } } },
      { assignees: { some: { studentGroup: { memberships: { some: { userId: 'stu-1' } } } } } },
    ]);
  });

  it('is assigned and unlocked when there is no unlock date', async () => {
    prismaMock.assignment.findFirst.mockResolvedValue(base);

    const gate = await resolveStudentContentGate('a1', 'stu-1', NOW);

    expect(gate).toEqual({ assigned: true, locked: false, unlockAt: null });
  });

  it('locks while the base unlock date is still in the future', async () => {
    const unlockAt = new Date('2026-07-25T00:00:00.000Z');
    prismaMock.assignment.findFirst.mockResolvedValue({ ...base, unlockAt });

    const gate = await resolveStudentContentGate('a1', 'stu-1', NOW);

    expect(gate.assigned).toBe(true);
    expect(gate.locked).toBe(true);
    expect(gate.unlockAt).toEqual(unlockAt);
  });

  it('unlocks early when the student has an override that already opened', async () => {
    prismaMock.assignment.findFirst.mockResolvedValue({
      ...base,
      unlockAt: new Date('2026-07-25T00:00:00.000Z'),
    });
    prismaMock.assignmentOverride.findMany.mockResolvedValue([
      {
        targetType: 'STUDENT',
        userId: 'stu-1',
        groupId: null,
        unlockAt: new Date('2026-07-01T00:00:00.000Z'),
        dueDate: null,
        lateCutoff: null,
        allowLateSubmissions: null,
      },
    ]);

    const gate = await resolveStudentContentGate('a1', 'stu-1', NOW);

    expect(gate.locked).toBe(false);
  });

  it('honors a group override, deriving the group id from the scoped rows', async () => {
    prismaMock.assignment.findFirst.mockResolvedValue(base);
    prismaMock.assignmentOverride.findMany.mockResolvedValue([
      {
        targetType: 'GROUP',
        userId: null,
        groupId: 'g1',
        unlockAt: new Date('2026-07-30T00:00:00.000Z'),
        dueDate: null,
        lateCutoff: null,
        allowLateSubmissions: null,
      },
    ]);

    const gate = await resolveStudentContentGate('a1', 'stu-1', NOW);

    expect(gate.locked).toBe(true);
    expect(gate.unlockAt).toEqual(new Date('2026-07-30T00:00:00.000Z'));
  });
});

/**
 * Whose exceptions the gate reads.
 *
 * Whether an assignment is open for a student depends on the date exceptions that apply to
 * them, so this read has to name both the assignment and the student (their own row or their
 * group's, via the shared helper). The prisma mock returns its fixture whatever the `where`
 * says: without the `assignmentId` a later deadline granted on other work would unlock this
 * one, and without the student clause anybody's extension would unlock it for everybody.
 */
describe('whose exceptions the content gate reads', () => {
  it('asks for this assignment, and for this student or their group', async () => {
    prismaMock.assignment.findFirst.mockResolvedValue({
      id: 'a1',
      assignedToEveryone: true,
      unlockAt: null,
      dueDate: null,
      allowLateSubmissions: false,
      lateCutoff: null,
    });

    await resolveStudentContentGate('a1', 'stu-1', NOW);

    expect(prismaMock.assignmentOverride.findMany.mock.calls[0][0]).toMatchObject({
      where: { assignmentId: 'a1', ...overridesForStudentWhere('stu-1') },
    });
  });
});
