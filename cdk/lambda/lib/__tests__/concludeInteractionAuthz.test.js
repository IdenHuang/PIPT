"use strict";

/**
 * Regression test for POST /student/conclude_interaction authorization
 * Source-level, in the same style as
 * cdk/test/instructorFunction.*.test.ts: the handler must verify session
 * ownership (admin bypass) and bind the chat to the query's patient/group
 * before it reads assignments or writes to chats / student_interactions.
 */

const fs = require("fs");
const path = require("path");

const source = fs.readFileSync(path.join(__dirname, "..", "studentFunction.js"), "utf8");

function handlerBlock(routeKey) {
  const start = source.indexOf(`case "${routeKey}":`);
  if (start === -1) throw new Error(`route not found: ${routeKey}`);
  const next = source.indexOf('\n      case "', start + 1);
  return source.slice(start, next === -1 ? undefined : next);
}

describe("POST /student/conclude_interaction authorization", () => {
  const block = handlerBlock("POST /student/conclude_interaction");
  const firstWrite = block.indexOf('UPDATE "chats"');
  const firstAssignmentRead = block.indexOf("FROM simulation_group_dtps");

  test("handler still writes to chats (sanity check for the slice)", () => {
    expect(firstWrite).toBeGreaterThan(-1);
    expect(firstAssignmentRead).toBeGreaterThan(-1);
  });

  test("verifies session ownership with the admin bypass before any read or write", () => {
    const adminCheck = block.indexOf("isAdmin(sqlConnection, userEmailAttribute)");
    const ownership = block.indexOf("verifySessionOwnership(sqlConnection, sessionId, userEmailAttribute)");
    expect(adminCheck).toBeGreaterThan(-1);
    expect(ownership).toBeGreaterThan(adminCheck);
    expect(ownership).toBeLessThan(firstAssignmentRead);
    expect(ownership).toBeLessThan(firstWrite);
  });

  test("binds the chat to the query's patient and group before any read or write", () => {
    const binding = block.search(
      /WHERE c\.chat_id = \$\{sessionId\}\s+AND si\.persona_id = \$\{patientId\}\s+AND e\.simulation_group_id = \$\{simulationGroupId\}/
    );
    expect(binding).toBeGreaterThan(-1);
    expect(binding).toBeLessThan(firstAssignmentRead);
    expect(binding).toBeLessThan(firstWrite);
  });

  test("denials return 403 and stop the handler", () => {
    const authSection = block.slice(0, firstAssignmentRead);
    const denials = authSection.match(/response\.statusCode = 403;\s+response\.body = JSON\.stringify\(\{ error: "Forbidden" \}\);\s+break;/g) || [];
    expect(denials).toHaveLength(2);
  });
});
