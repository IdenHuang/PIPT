"use strict";

/**
 * Tenant-isolation tests for the organization-scoped bank routes in
 * instructorRoutePolicy.js (question_bank, dtp_bank, recommendations_bank).
 *
 * The ownership helpers in authz.js are mocked so each test states exactly
 * which organizations the caller belongs to and which org an item resolves to.
 * Scenario: the caller is an instructor in ORG_A; ORG_B is another tenant.
 */

jest.mock("../authz.js", () => ({
  verifyGroupOwnership: jest.fn(),
  verifyPersonaOwnership: jest.fn(),
  verifyOrganizationMembership: jest.fn(),
  resolveParentId: jest.fn(),
}));

const authz = require("../authz.js");
const { authorizeInstructorRequest, INSTRUCTOR_ROUTE_POLICY } = require("../instructorRoutePolicy.js");

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ITEM_A = "c0000000-0000-4000-8000-00000000000a";
const ITEM_B = "c0000000-0000-4000-8000-00000000000b";
const MISSING_ITEM = "c0000000-0000-4000-8000-00000000ffff";
const EMAIL = "instructor-a@example.edu";
const sql = {};

const ITEM_ORG = { [ITEM_A]: ORG_A, [ITEM_B]: ORG_B };

beforeEach(() => {
  jest.resetAllMocks();
  authz.verifyOrganizationMembership.mockImplementation(async (_sql, orgId, email) => ({
    authorized: email === EMAIL && orgId === ORG_A,
  }));
  authz.resolveParentId.mockImplementation(async (_sql, _kind, childId) => ITEM_ORG[childId] || null);
});

function authorize(routeKey, queryStringParameters, { isAdmin = false } = {}) {
  return authorizeInstructorRequest({
    sqlConnection: sql,
    routeKey,
    queryStringParameters,
    body: "{}",
    userEmail: EMAIL,
    isAdmin,
  });
}

const ORG_PARAM_ROUTES = [
  "POST /instructor/question_bank",
  "GET /instructor/dtp_bank",
  "POST /instructor/dtp_bank",
  "GET /instructor/recommendations_bank",
  "POST /instructor/recommendations_bank",
];

const ITEM_ROUTES = [
  ["PUT /instructor/question_bank", "question_id", "question_bank_item"],
  ["PUT /instructor/dtp_bank", "dtp_id", "dtp_bank_item"],
  ["PUT /instructor/recommendations_bank", "recommendation_id", "recommendation_bank_item"],
];

describe("organization_id routes", () => {
  test.each(ORG_PARAM_ROUTES)("%s allows a member and exposes the org in scope", async (route) => {
    const result = await authorize(route, { organization_id: ORG_A });
    expect(result).toEqual({ allowed: true, scope: { organizationId: ORG_A } });
    expect(authz.verifyOrganizationMembership).toHaveBeenCalledWith(sql, ORG_A, EMAIL);
  });

  test.each(ORG_PARAM_ROUTES)("%s denies another tenant's organization_id with 403", async (route) => {
    const result = await authorize(route, { organization_id: ORG_B });
    expect(result).toEqual({ allowed: false, statusCode: 403, error: expect.stringMatching(/^Forbidden/) });
  });

  test.each(ORG_PARAM_ROUTES)("%s requires organization_id (400)", async (route) => {
    const result = await authorize(route, {});
    expect(result).toMatchObject({ allowed: false, statusCode: 400 });
    expect(authz.verifyOrganizationMembership).not.toHaveBeenCalled();
  });

  test.each(ORG_PARAM_ROUTES)("%s rejects a non-string organization_id (400)", async (route) => {
    const result = await authorize(route, { organization_id: [ORG_A, ORG_B] });
    expect(result).toMatchObject({ allowed: false, statusCode: 400 });
  });

  test.each(ORG_PARAM_ROUTES)("%s lets admins through without a membership lookup", async (route) => {
    const result = await authorize(route, { organization_id: ORG_B }, { isAdmin: true });
    expect(result).toEqual({ allowed: true, scope: { organizationId: ORG_B } });
    expect(authz.verifyOrganizationMembership).not.toHaveBeenCalled();
  });

  test.each(ORG_PARAM_ROUTES)("%s fails closed when the membership check throws", async (route) => {
    authz.verifyOrganizationMembership.mockRejectedValue(new Error("db down"));
    const result = await authorize(route, { organization_id: ORG_A });
    expect(result).toMatchObject({ allowed: false, statusCode: 403 });
  });
});

describe("item update routes", () => {
  test.each(ITEM_ROUTES)("%s resolves the item to its org and allows a member", async (route, param, kind) => {
    const result = await authorize(route, { [param]: ITEM_A });
    expect(authz.resolveParentId).toHaveBeenCalledWith(sql, kind, ITEM_A);
    expect(authz.verifyOrganizationMembership).toHaveBeenCalledWith(sql, ORG_A, EMAIL);
    expect(result).toEqual({ allowed: true, scope: { organizationId: ORG_A } });
  });

  test.each(ITEM_ROUTES)("%s denies an item owned by another tenant", async (route, param) => {
    const result = await authorize(route, { [param]: ITEM_B });
    expect(result).toMatchObject({ allowed: false, statusCode: 403 });
  });

  test.each(ITEM_ROUTES)("%s denies an unknown item to non-admins (no existence oracle)", async (route, param) => {
    const missing = await authorize(route, { [param]: MISSING_ITEM });
    const foreign = await authorize(route, { [param]: ITEM_B });
    expect(missing).toEqual(foreign);
  });

  test.each(ITEM_ROUTES)("%s gives admins a null org scope for unknown items", async (route, param) => {
    const result = await authorize(route, { [param]: MISSING_ITEM }, { isAdmin: true });
    expect(result).toEqual({ allowed: true, scope: { organizationId: null } });
  });

  test.each(ITEM_ROUTES)("%s requires the item id (400)", async (route, param) => {
    const result = await authorize(route, {});
    expect(result).toMatchObject({ allowed: false, statusCode: 400, error: `${param} is required` });
    expect(authz.resolveParentId).not.toHaveBeenCalled();
  });
});

describe("GET /instructor/question_bank", () => {
  const route = "GET /instructor/question_bank";

  test("is no longer caller-scoped: it carries an optional organization check", () => {
    expect(INSTRUCTOR_ROUTE_POLICY[route]).toEqual([
      expect.objectContaining({ type: "organization", param: "organization_id", optional: true }),
    ]);
  });

  test("without organization_id, allows the request with no org in scope", async () => {
    const result = await authorize(route, null);
    expect(result).toEqual({ allowed: true, scope: {} });
    expect(authz.verifyOrganizationMembership).not.toHaveBeenCalled();
  });

  test("with the caller's organization_id, scopes the request to it", async () => {
    const result = await authorize(route, { organization_id: ORG_A });
    expect(result).toEqual({ allowed: true, scope: { organizationId: ORG_A } });
  });

  test("with another tenant's organization_id, denies with 403", async () => {
    const result = await authorize(route, { organization_id: ORG_B });
    expect(result).toMatchObject({ allowed: false, statusCode: 403 });
  });
});

test("every bank route has a policy entry", () => {
  const bankRoutes = [...ORG_PARAM_ROUTES, ...ITEM_ROUTES.map(([r]) => r), "GET /instructor/question_bank"];
  for (const route of bankRoutes) {
    expect(INSTRUCTOR_ROUTE_POLICY[route]).toBeDefined();
    expect(INSTRUCTOR_ROUTE_POLICY[route].length).toBeGreaterThan(0);
  }
});
