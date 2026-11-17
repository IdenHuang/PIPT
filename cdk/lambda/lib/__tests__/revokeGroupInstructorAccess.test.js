"use strict";
/**
 * Tests for revokeGroupInstructorAccess (POST /admin/lower_instructor),
 * finding f-1494f973: demotion must clear all three group-instructor grants
 * (instructor enrollments, group_instructors rows, simulation_groups.created_by)
 * and audit each reassigned group.
 */
const {
  revokeGroupInstructorAccess,
} = require("../../adminFunction/revokeGroupInstructorAccess.js");

const ACTOR = { userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", email: "admin@example.edu" };
const TARGET = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const GROUP_A = "11111111-1111-4111-8111-111111111111";
const GROUP_B = "22222222-2222-4222-8222-222222222222";
const CHANGE = {
  actor: ACTOR,
  targetUserId: TARGET,
  targetEmail: "inst@example.edu",
  oldRoles: ["instructor"],
  newRoles: ["student"],
};

/** Stand-in for a postgres.js transaction that records every query. */
function makeTx({ ownedGroups = [GROUP_A, GROUP_B], failAudit = false } = {}) {
  const calls = [];
  const tx = async (strings, ...values) => {
    const text = strings.join("?");
    calls.push({ text, values });
    if (text.includes('DELETE FROM "enrollments"')) return [];
    if (text.includes('DELETE FROM "group_instructors"')) return [];
    if (text.includes('UPDATE "simulation_groups"')) {
      return ownedGroups.map((simulation_group_id) => ({ simulation_group_id }));
    }
    if (text.includes('INSERT INTO "role_audit_log"')) {
      if (failAudit) throw new Error("audit insert failed");
      return [];
    }
    throw new Error(`unexpected query: ${text}`);
  };
  tx.calls = calls;
  return tx;
}

const callsMatching = (tx, needle) => tx.calls.filter((c) => c.text.includes(needle));

describe("revokeGroupInstructorAccess", () => {
  test("deletes instructor enrollments for the target only", async () => {
    const tx = makeTx();
    await revokeGroupInstructorAccess(tx, CHANGE);
    const [del] = callsMatching(tx, 'DELETE FROM "enrollments"');
    expect(del.text).toMatch(/enrollment_type = 'instructor'/);
    expect(del.values).toEqual([TARGET]);
  });

  test("deletes every group_instructors row for the target", async () => {
    const tx = makeTx();
    await revokeGroupInstructorAccess(tx, CHANGE);
    const del = callsMatching(tx, 'DELETE FROM "group_instructors"');
    expect(del).toHaveLength(1);
    expect(del[0].text).toMatch(/WHERE user_id = \?/);
    expect(del[0].values).toEqual([TARGET]);
  });

  test("reassigns created_by from the target to the acting admin", async () => {
    const tx = makeTx();
    const result = await revokeGroupInstructorAccess(tx, CHANGE);
    const [upd] = callsMatching(tx, 'UPDATE "simulation_groups"');
    expect(upd.text).toMatch(/SET created_by = \?/);
    expect(upd.text).toMatch(/WHERE created_by = \?/);
    expect(upd.values).toEqual([ACTOR.userId, TARGET]);
    expect(result.reassignedGroupIds).toEqual([GROUP_A, GROUP_B]);
  });

  test("writes one lower_instructor audit row per reassigned group", async () => {
    const tx = makeTx();
    await revokeGroupInstructorAccess(tx, CHANGE);
    const audit = callsMatching(tx, 'INSERT INTO "role_audit_log"');
    expect(audit).toHaveLength(2);
    expect(audit[0].text).toContain("'lower_instructor'");
    expect(audit.map((c) => c.values)).toEqual([
      [ACTOR.userId, ACTOR.email, TARGET, "inst@example.edu", ["instructor"], ["student"], GROUP_A],
      [ACTOR.userId, ACTOR.email, TARGET, "inst@example.edu", ["instructor"], ["student"], GROUP_B],
    ]);
  });

  test("writes no per-group audit rows when the target owns no groups", async () => {
    const tx = makeTx({ ownedGroups: [] });
    const result = await revokeGroupInstructorAccess(tx, CHANGE);
    expect(result.reassignedGroupIds).toEqual([]);
    expect(callsMatching(tx, "role_audit_log")).toHaveLength(0);
    expect(callsMatching(tx, 'DELETE FROM "group_instructors"')).toHaveLength(1);
  });

  test("propagates an audit failure so the demotion transaction rolls back", async () => {
    const tx = makeTx({ failAudit: true });
    await expect(revokeGroupInstructorAccess(tx, CHANGE)).rejects.toThrow("audit insert failed");
  });
});
