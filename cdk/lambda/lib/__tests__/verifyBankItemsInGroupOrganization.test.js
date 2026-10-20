"use strict";

/**
 * Tests for authz.verifyBankItemsInGroupOrganization: body-supplied DTP and
 * recommendation bank IDs must belong to the target group's organization
 * before POST /instructor/simulation_group_{dtps,recommendations} inserts them.
 */

const { verifyBankItemsInGroupOrganization } = require("../authz.js");

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const GROUP_A = "11111111-1111-4111-8111-111111111111";
const GROUP_NO_ORG = "22222222-2222-4222-8222-222222222222";
const DTP_A = "d0000000-0000-4000-8000-00000000000a";
const DTP_A2 = "d0000000-0000-4000-8000-0000000000a2";
const DTP_B = "d0000000-0000-4000-8000-00000000000b";
const REC_A = "e0000000-0000-4000-8000-00000000000a";
const REC_B = "e0000000-0000-4000-8000-00000000000b";

/**
 * Minimal stand-in for the postgres.js tagged template. Answers the two bank
 * queries from fixtures (JOIN on organization_id, so NULL never matches) and
 * records every call so tests can assert values are passed as parameters.
 */
function makeSql({ fail = false } = {}) {
  const groups = { [GROUP_A]: ORG_A, [GROUP_NO_ORG]: null };
  const banks = {
    dtp_bank: { [DTP_A]: ORG_A, [DTP_A2]: ORG_A, [DTP_B]: ORG_B },
    recommendations_bank: { [REC_A]: ORG_A, [REC_B]: ORG_B },
  };
  const calls = [];
  const sql = async (strings, ...values) => {
    const text = strings.join("?");
    calls.push({ text, values });
    if (fail) throw new Error("db down");
    const table = text.includes("recommendations_bank") ? "recommendations_bank" : "dtp_bank";
    const [itemId, groupId] = values;
    const itemOrg = banks[table][itemId];
    const groupOrg = groups[groupId];
    return itemOrg && groupOrg && itemOrg === groupOrg ? [{ "?column?": 1 }] : [];
  };
  sql.calls = calls;
  return sql;
}

describe("verifyBankItemsInGroupOrganization", () => {
  test("allows DTPs from the group's organization", async () => {
    const sql = makeSql();
    await expect(verifyBankItemsInGroupOrganization(sql, "dtp", [DTP_A, DTP_A2], GROUP_A))
      .resolves.toEqual({ authorized: true });
  });

  test("allows recommendations from the group's organization", async () => {
    await expect(verifyBankItemsInGroupOrganization(makeSql(), "recommendation", [REC_A], GROUP_A))
      .resolves.toEqual({ authorized: true });
  });

  test.each([
    ["dtp", [DTP_B]],
    ["recommendation", [REC_B]],
  ])("denies a %s from another organization", async (kind, ids) => {
    await expect(verifyBankItemsInGroupOrganization(makeSql(), kind, ids, GROUP_A))
      .resolves.toEqual({ authorized: false });
  });

  test("denies the whole batch if any one item is foreign", async () => {
    await expect(verifyBankItemsInGroupOrganization(makeSql(), "dtp", [DTP_A, DTP_B, DTP_A2], GROUP_A))
      .resolves.toEqual({ authorized: false });
  });

  test("denies items that do not exist", async () => {
    const missing = "d0000000-0000-4000-8000-00000000ffff";
    await expect(verifyBankItemsInGroupOrganization(makeSql(), "dtp", [missing], GROUP_A))
      .resolves.toEqual({ authorized: false });
  });

  test("denies when the group has no organization", async () => {
    await expect(verifyBankItemsInGroupOrganization(makeSql(), "dtp", [DTP_A], GROUP_NO_ORG))
      .resolves.toEqual({ authorized: false });
  });

  test("does not cross banks: a DTP id is not accepted as a recommendation", async () => {
    await expect(verifyBankItemsInGroupOrganization(makeSql(), "recommendation", [DTP_A], GROUP_A))
      .resolves.toEqual({ authorized: false });
  });

  test.each([
    ["unknown kind", "question", [DTP_A]],
    ["empty list", "dtp", []],
    ["not an array", "dtp", DTP_A],
    ["non-string id", "dtp", [{ $ne: null }]],
    ["empty-string id", "dtp", [""]],
  ])("fails closed on %s without querying", async (_label, kind, ids) => {
    const sql = makeSql();
    await expect(verifyBankItemsInGroupOrganization(sql, kind, ids, GROUP_A))
      .resolves.toEqual({ authorized: false });
    expect(sql.calls).toHaveLength(0);
  });

  test("fails closed on database errors", async () => {
    await expect(verifyBankItemsInGroupOrganization(makeSql({ fail: true }), "dtp", [DTP_A], GROUP_A))
      .resolves.toEqual({ authorized: false });
  });

  test("passes ids as parameters, never in SQL text, and checks duplicates once", async () => {
    const sql = makeSql();
    await verifyBankItemsInGroupOrganization(sql, "dtp", [DTP_A, DTP_A], GROUP_A);
    expect(sql.calls).toHaveLength(1);
    expect(sql.calls[0].values).toEqual([DTP_A, GROUP_A]);
    expect(sql.calls[0].text).not.toContain(DTP_A);
    expect(sql.calls[0].text).not.toContain(GROUP_A);
  });
});
