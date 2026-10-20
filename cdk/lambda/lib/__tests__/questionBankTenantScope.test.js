"use strict";

/**
 * Source-level regression tests for tenant isolation of the instructor bank
 * handlers, in the style of concludeInteractionAuthz.test.js. The route policy
 * (instructorRoutePolicy.js) authorizes the organization; these tests pin the
 * handler SQL to that authorized scope so a refactor cannot silently drop it.
 */

const fs = require("fs");
const path = require("path");

const source = fs.readFileSync(path.join(__dirname, "..", "instructorFunction.js"), "utf8");

function handlerBlock(routeKey) {
  const start = source.indexOf(`case "${routeKey}":`);
  if (start === -1) throw new Error(`route not found: ${routeKey}`);
  const next = source.indexOf('\n      case "', start + 1);
  return source.slice(start, next === -1 ? undefined : next);
}

describe("GET /instructor/question_bank", () => {
  const block = handlerBlock("GET /instructor/question_bank");
  const selects = block.match(/SELECT[\s\S]*?;\s*`/g) || [];

  test("has the three scoped query branches", () => {
    expect(selects).toHaveLength(3);
  });

  test("filters on the policy-authorized organization when one is supplied", () => {
    expect(block).toContain("const requestedOrgId = authorizedScope.organizationId;");
    expect(block).toMatch(/WHERE organization_id = \$\{requestedOrgId\}/);
  });

  test("an unfiltered SELECT only runs for admins", () => {
    const unfiltered = selects.filter((q) => !/WHERE/.test(q));
    expect(unfiltered).toHaveLength(1);
    const adminBranch = block.indexOf('} else if (userRoles.includes("admin")) {');
    expect(adminBranch).toBeGreaterThan(-1);
    expect(block.indexOf(unfiltered[0])).toBeGreaterThan(adminBranch);
  });

  test("non-admin default is limited to the caller's organizations", () => {
    const callerScoped = selects.find((q) => q.includes("qb.organization_id IN ("));
    expect(callerScoped).toBeDefined();
    expect(callerScoped).toContain("u.user_email = ${userEmailAttribute}");
    expect(callerScoped).toContain("sg.created_by = u.user_id");
    expect(callerScoped).toContain('FROM "group_instructors" gi');
    expect(callerScoped).toContain("e.enrollment_type = 'instructor'");
  });
});

describe("bank updates are bound to the authorized organization", () => {
  test.each([
    ["PUT /instructor/question_bank", /WHERE question_id = \$\{question_id\}\s+AND organization_id = \$\{authorizedScope\.organizationId\}/],
    ["PUT /instructor/dtp_bank", /WHERE dtp_id = \$\{dtp_id\}\s+AND organization_id = \$\{authorizedScope\.organizationId\}/],
    ["PUT /instructor/recommendations_bank", /WHERE recommendation_id = \$\{recommendation_id\}\s+AND organization_id = \$\{authorizedScope\.organizationId\}/],
  ])("%s", (route, pattern) => {
    expect(handlerBlock(route)).toMatch(pattern);
  });
});

describe("bank bindings are org-checked before insert", () => {
  test.each([
    ["POST /instructor/simulation_group_questions", "verifyQuestionsAttachableToGroup(", 'INSERT INTO "simulation_group_questions"'],
    ["POST /instructor/simulation_group_dtps", "verifyBankItemsInGroupOrganization(", 'INSERT INTO "simulation_group_dtps"'],
    ["POST /instructor/simulation_group_recommendations", "verifyBankItemsInGroupOrganization(", 'INSERT INTO "simulation_group_recommendations"'],
  ])("%s", (route, check, insert) => {
    const block = handlerBlock(route);
    const checkAt = block.indexOf(check);
    const insertAt = block.indexOf(insert);
    expect(checkAt).toBeGreaterThan(-1);
    expect(insertAt).toBeGreaterThan(-1);
    expect(checkAt).toBeLessThan(insertAt);
  });

  test("the question check denies with 403 and stops the handler", () => {
    const block = handlerBlock("POST /instructor/simulation_group_questions");
    expect(block).toMatch(
      /if \(!questionOrgCheck\.authorized\) \{\s+response\.statusCode = 403;[\s\S]*?break;\s+\}/
    );
  });
});
