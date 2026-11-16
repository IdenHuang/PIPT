"use strict";
/**
 * Tests for enrollInstructor (POST /admin/enroll_instructor), finding
 * f-0f827c5e: target must hold the instructor role, a student enrollment is
 * never promoted, and every grant writes a role_audit_log row in the same
 * transaction.
 */
const { enrollInstructor } = require("../../adminFunction/enrollInstructor.js");

const GROUP = "11111111-1111-4111-8111-111111111111";
const ACTOR = { userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", email: "admin@example.edu" };
const USERS = {
  "inst@example.edu": { user_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", roles: ["student", "instructor"] },
  "stud@example.edu": { user_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", roles: ["student"] },
};

/**
 * Stand-in for postgres.js with sql.begin. `existing` is the enrollment_type
 * already on (GROUP, user), or null. The upsert mimics the guarded
 * ON CONFLICT ... DO UPDATE ... WHERE enrollment_type <> 'student'.
 */
function makeSql({ existing = null, personas = ["p1", "p2"], failAudit = false } = {}) {
  const calls = [];
  const state = { committed: false };
  const tx = async (strings, ...values) => {
    const text = strings.join("?");
    calls.push({ text, values });
    if (text.includes('FROM "users"')) {
      const u = USERS[values[0]];
      return u ? [u] : [];
    }
    if (text.includes('INSERT INTO "enrollments"')) {
      expect(text).toMatch(/WHERE "enrollments"\.enrollment_type <> 'student'/);
      if (existing === "student") return [];
      return [{ enrollment_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" }];
    }
    if (text.includes('FROM "personas"')) return personas.map((persona_id) => ({ persona_id }));
    if (text.includes('INSERT INTO "student_interactions"')) return [];
    if (text.includes('INSERT INTO "role_audit_log"')) {
      if (failAudit) throw new Error("audit insert failed");
      return [];
    }
    throw new Error(`unexpected query: ${text}`);
  };
  const sql = {
    calls,
    state,
    begin: async (fn) => {
      const result = await fn(tx);
      state.committed = true;
      return result;
    },
  };
  return sql;
}

const run = (sql, instructorEmail) =>
  enrollInstructor(sql, { actor: ACTOR, simulationGroupId: GROUP, instructorEmail });
const auditCalls = (sql) => sql.calls.filter((c) => c.text.includes("role_audit_log"));
const enrollCalls = (sql) => sql.calls.filter((c) => c.text.includes('INSERT INTO "enrollments"'));

describe("enrollInstructor", () => {
  test("enrolls an instructor and writes the audit row", async () => {
    const sql = makeSql();
    const result = await run(sql, "inst@example.edu");
    expect(result.statusCode).toBe(200);
    expect(sql.calls.filter((c) => c.text.includes("student_interactions"))).toHaveLength(2);
    const audit = auditCalls(sql);
    expect(audit).toHaveLength(1);
    expect(audit[0].text).toContain("'enroll_instructor'");
    expect(audit[0].values).toEqual([
      ACTOR.userId,
      ACTOR.email,
      USERS["inst@example.edu"].user_id,
      "inst@example.edu",
      USERS["inst@example.edu"].roles,
      USERS["inst@example.edu"].roles,
      GROUP,
    ]);
  });

  test("rejects a target without the instructor role and writes nothing", async () => {
    const sql = makeSql();
    const result = await run(sql, "stud@example.edu");
    expect(result.statusCode).toBe(400);
    expect(result.body.error).toMatch(/instructor role/);
    expect(enrollCalls(sql)).toHaveLength(0);
    expect(auditCalls(sql)).toHaveLength(0);
  });

  test("rejects an unknown email", async () => {
    const sql = makeSql();
    const result = await run(sql, "nobody@example.edu");
    expect(result.statusCode).toBe(400);
    expect(enrollCalls(sql)).toHaveLength(0);
  });

  test("does not promote an existing student enrollment", async () => {
    const sql = makeSql({ existing: "student" });
    const result = await run(sql, "inst@example.edu");
    expect(result.statusCode).toBe(409);
    expect(sql.calls.filter((c) => c.text.includes("student_interactions"))).toHaveLength(0);
    expect(auditCalls(sql)).toHaveLength(0);
  });

  test("converts a preview enrollment for an instructor", async () => {
    const sql = makeSql({ existing: "preview" });
    const result = await run(sql, "inst@example.edu");
    expect(result.statusCode).toBe(200);
    expect(auditCalls(sql)).toHaveLength(1);
  });

  test("runs every write inside the transaction, so an audit failure aborts the grant", async () => {
    const sql = makeSql({ failAudit: true });
    await expect(run(sql, "inst@example.edu")).rejects.toThrow("audit insert failed");
    expect(sql.state.committed).toBe(false);
  });
});
