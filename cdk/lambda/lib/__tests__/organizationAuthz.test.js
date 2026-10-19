"use strict";

/**
 * Tests for the organization (tenant) helpers in authz.js:
 *   - verifyOrganizationMembership: gate for every organization_id route
 *   - verifyQuestionsAttachableToGroup: gate for body-supplied question IDs in
 *     POST /instructor/simulation_group_questions
 */

const { verifyOrganizationMembership, verifyQuestionsAttachableToGroup } = require("../authz.js");

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const GROUP_A = "11111111-1111-4111-8111-111111111111";
const GROUP_B = "33333333-3333-4333-8333-333333333333";
const GROUP_NO_ORG = "22222222-2222-4222-8222-222222222222";
const Q_A = "f0000000-0000-4000-8000-00000000000a";
const Q_A2 = "f0000000-0000-4000-8000-0000000000a2";
const Q_B = "f0000000-0000-4000-8000-00000000000b";
const MEMBER_A = "instructor-a@example.edu";

/**
 * Stand-in for the postgres.js tagged template. Answers the membership query
 * and the question/group lookup from fixtures, and records every call.
 */
function makeSql({ fail = false, members = { [MEMBER_A]: [ORG_A] } } = {}) {
  const groups = { [GROUP_A]: ORG_A, [GROUP_B]: ORG_B, [GROUP_NO_ORG]: null };
  const questions = { [Q_A]: ORG_A, [Q_A2]: ORG_A, [Q_B]: ORG_B };
  const calls = [];
  const sql = async (strings, ...values) => {
    const text = strings.join("?");
    calls.push({ text, values });
    if (fail) throw new Error("db down");

    if (text.includes("FROM question_bank q")) {
      const [questionId, groupId] = values;
      if (!(questionId in questions) || !(groupId in groups)) return [];
      return [{ question_org: questions[questionId], group_org: groups[groupId] }];
    }
    if (text.includes("FROM users u")) {
      const [email, orgId] = values;
      return (members[email] || []).includes(orgId) ? [{ "?column?": 1 }] : [];
    }
    throw new Error(`unexpected query: ${text}`);
  };
  sql.calls = calls;
  return sql;
}

describe("verifyOrganizationMembership", () => {
  test("authorizes a member", async () => {
    await expect(verifyOrganizationMembership(makeSql(), ORG_A, MEMBER_A)).resolves.toEqual({ authorized: true });
  });

  test("denies another tenant's organization", async () => {
    await expect(verifyOrganizationMembership(makeSql(), ORG_B, MEMBER_A)).resolves.toEqual({ authorized: false });
  });

  test("denies an unknown user", async () => {
    await expect(verifyOrganizationMembership(makeSql(), ORG_A, "nobody@example.edu"))
      .resolves.toEqual({ authorized: false });
  });

  test("fails closed on database errors", async () => {
    await expect(verifyOrganizationMembership(makeSql({ fail: true }), ORG_A, MEMBER_A))
      .resolves.toEqual({ authorized: false });
  });

  test("checks direct assignment and all three group-instructor paths", async () => {
    const sql = makeSql();
    await verifyOrganizationMembership(sql, ORG_A, MEMBER_A);
    const { text } = sql.calls[0];
    expect(text).toMatch(/u\.organization_id = \?/);
    expect(text).toMatch(/sg\.organization_id = \?/);
    expect(text).toMatch(/sg\.created_by = u\.user_id/);
    expect(text).toMatch(/FROM group_instructors gi/);
    expect(text).toMatch(/e\.enrollment_type = 'instructor'/);
  });

  test("passes the org id and email as parameters, never in SQL text", async () => {
    const sql = makeSql();
    await verifyOrganizationMembership(sql, ORG_A, MEMBER_A);
    expect(sql.calls[0].values).toEqual([MEMBER_A, ORG_A, ORG_A]);
    expect(sql.calls[0].text).not.toContain(ORG_A);
    expect(sql.calls[0].text).not.toContain(MEMBER_A);
  });
});

describe("verifyQuestionsAttachableToGroup", () => {
  describe("group with an organization", () => {
    test("allows questions from the group's organization", async () => {
      await expect(verifyQuestionsAttachableToGroup(makeSql(), [Q_A, Q_A2], GROUP_A, MEMBER_A, false))
        .resolves.toEqual({ authorized: true });
    });

    test("denies a question from another organization", async () => {
      await expect(verifyQuestionsAttachableToGroup(makeSql(), [Q_B], GROUP_A, MEMBER_A, false))
        .resolves.toEqual({ authorized: false });
    });

    test("denies the whole batch if any one question is foreign", async () => {
      await expect(verifyQuestionsAttachableToGroup(makeSql(), [Q_A, Q_B, Q_A2], GROUP_A, MEMBER_A, false))
        .resolves.toEqual({ authorized: false });
    });

    test("applies to admins too: a question cannot cross into another org's group", async () => {
      await expect(verifyQuestionsAttachableToGroup(makeSql(), [Q_B], GROUP_A, MEMBER_A, true))
        .resolves.toEqual({ authorized: false });
    });

    test("does not consult membership when the group has an organization", async () => {
      const sql = makeSql();
      await verifyQuestionsAttachableToGroup(sql, [Q_A], GROUP_A, MEMBER_A, false);
      expect(sql.calls.some((c) => c.text.includes("FROM users u"))).toBe(false);
    });
  });

  describe("group without an organization", () => {
    test("allows a question from an organization the caller belongs to", async () => {
      await expect(verifyQuestionsAttachableToGroup(makeSql(), [Q_A], GROUP_NO_ORG, MEMBER_A, false))
        .resolves.toEqual({ authorized: true });
    });

    test("denies a question from an organization the caller does not belong to", async () => {
      await expect(verifyQuestionsAttachableToGroup(makeSql(), [Q_B], GROUP_NO_ORG, MEMBER_A, false))
        .resolves.toEqual({ authorized: false });
    });

    test("allows admins without a membership lookup", async () => {
      const sql = makeSql();
      await expect(verifyQuestionsAttachableToGroup(sql, [Q_B], GROUP_NO_ORG, MEMBER_A, true))
        .resolves.toEqual({ authorized: true });
      expect(sql.calls.some((c) => c.text.includes("FROM users u"))).toBe(false);
    });

    test("looks up membership once per organization", async () => {
      const sql = makeSql();
      await verifyQuestionsAttachableToGroup(sql, [Q_A, Q_A2], GROUP_NO_ORG, MEMBER_A, false);
      expect(sql.calls.filter((c) => c.text.includes("FROM users u"))).toHaveLength(1);
    });

    test("only a strict boolean true counts as admin", async () => {
      await expect(verifyQuestionsAttachableToGroup(makeSql(), [Q_B], GROUP_NO_ORG, MEMBER_A, "true"))
        .resolves.toEqual({ authorized: false });
    });
  });

  test("denies unknown questions and unknown groups", async () => {
    const missing = "f0000000-0000-4000-8000-00000000ffff";
    await expect(verifyQuestionsAttachableToGroup(makeSql(), [missing], GROUP_A, MEMBER_A, false))
      .resolves.toEqual({ authorized: false });
    await expect(verifyQuestionsAttachableToGroup(makeSql(), [Q_A], "no-such-group", MEMBER_A, false))
      .resolves.toEqual({ authorized: false });
  });

  test.each([
    ["empty list", []],
    ["not an array", Q_A],
    ["non-string id", [{ $ne: null }]],
    ["empty-string id", [""]],
  ])("fails closed on %s without querying", async (_label, ids) => {
    const sql = makeSql();
    await expect(verifyQuestionsAttachableToGroup(sql, ids, GROUP_A, MEMBER_A, false))
      .resolves.toEqual({ authorized: false });
    expect(sql.calls).toHaveLength(0);
  });

  test("fails closed on database errors", async () => {
    await expect(verifyQuestionsAttachableToGroup(makeSql({ fail: true }), [Q_A], GROUP_A, MEMBER_A, false))
      .resolves.toEqual({ authorized: false });
  });

  test("passes ids as parameters and checks duplicates once", async () => {
    const sql = makeSql();
    await verifyQuestionsAttachableToGroup(sql, [Q_A, Q_A], GROUP_A, MEMBER_A, false);
    expect(sql.calls).toHaveLength(1);
    expect(sql.calls[0].values).toEqual([Q_A, GROUP_A]);
    expect(sql.calls[0].text).not.toContain(Q_A);
    expect(sql.calls[0].text).not.toContain(GROUP_A);
  });
});
