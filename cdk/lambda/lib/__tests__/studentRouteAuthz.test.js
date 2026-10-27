"use strict";

/**
 * Object-level authorization for the /student routes that previously trusted
 * caller-supplied persona / group / chat IDs:
 *   - verifyPersonaEnrollment and verifySessionScope (authz.js), with a fake
 *     postgres tagged template
 *   - source-level checks that each route runs its check before it reads or
 *     writes, in the style of concludeInteractionAuthz.test.js
 */

const fs = require("fs");
const path = require("path");
const { verifyPersonaEnrollment, verifySessionScope } = require("../authz.js");

const GROUP_A = "11111111-1111-4111-8111-111111111111";
const GROUP_B = "22222222-2222-4222-8222-222222222222";
const PERSONA_A = "33333333-3333-4333-8333-333333333333";
const PERSONA_B = "44444444-4444-4444-8444-444444444444";
const CHAT_MINE = "55555555-5555-4555-8555-555555555555";
const CHAT_OTHER = "66666666-6666-4666-8666-666666666666";
const STUDENT = "student@example.edu";
const OTHER_STUDENT = "other@example.edu";

/** Fake postgres.js tagged template answering the two helper queries from fixtures. */
function makeSql({ fail = false } = {}) {
  const personas = { [PERSONA_A]: GROUP_A, [PERSONA_B]: GROUP_B };
  const enrollments = new Set([`${STUDENT}|${GROUP_A}`, `${OTHER_STUDENT}|${GROUP_A}`]);
  // chat_id -> [persona_id, group_id, owner]
  const chats = {
    [CHAT_MINE]: [PERSONA_A, GROUP_A, STUDENT],
    [CHAT_OTHER]: [PERSONA_A, GROUP_A, OTHER_STUDENT],
  };
  const calls = [];
  const sql = async (strings, ...values) => {
    const text = strings.join("?");
    calls.push({ text, values });
    if (fail) throw new Error("db down");
    if (text.includes("FROM chats c")) {
      const [chatId, personaId, groupId, email] = values;
      const chat = chats[chatId];
      return chat && chat[0] === personaId && chat[1] === groupId && chat[2] === email ? [{}] : [];
    }
    if (text.includes("FROM personas p")) {
      const [personaId, email] = values;
      const group = personas[personaId];
      return group && enrollments.has(`${email}|${group}`) ? [{}] : [];
    }
    throw new Error(`unexpected query: ${text}`);
  };
  sql.calls = calls;
  return sql;
}

describe("verifyPersonaEnrollment", () => {
  test("allows a student enrolled in the persona's group", async () => {
    await expect(verifyPersonaEnrollment(makeSql(), PERSONA_A, STUDENT)).resolves.toEqual({ authorized: true });
  });

  test("denies a persona from a group the student is not enrolled in", async () => {
    await expect(verifyPersonaEnrollment(makeSql(), PERSONA_B, STUDENT)).resolves.toEqual({ authorized: false });
  });

  test("denies an unknown persona", async () => {
    await expect(verifyPersonaEnrollment(makeSql(), "nope", STUDENT)).resolves.toEqual({ authorized: false });
  });

  test("fails closed on database errors", async () => {
    await expect(verifyPersonaEnrollment(makeSql({ fail: true }), PERSONA_A, STUDENT))
      .resolves.toEqual({ authorized: false });
  });

  test("derives the group from the persona and passes values as parameters", async () => {
    const sql = makeSql();
    await verifyPersonaEnrollment(sql, PERSONA_A, STUDENT);
    const { text, values } = sql.calls[0];
    expect(text).toMatch(/JOIN enrollments e ON e\.simulation_group_id = p\.simulation_group_id/);
    expect(values).toEqual([PERSONA_A, STUDENT]);
  });
});

describe("verifySessionScope", () => {
  test("allows the owner when chat, persona and group all match", async () => {
    await expect(verifySessionScope(makeSql(), CHAT_MINE, PERSONA_A, GROUP_A, STUDENT))
      .resolves.toEqual({ authorized: true });
  });

  test("denies another student's chat", async () => {
    await expect(verifySessionScope(makeSql(), CHAT_OTHER, PERSONA_A, GROUP_A, STUDENT))
      .resolves.toEqual({ authorized: false });
  });

  test.each([
    ["foreign persona", PERSONA_B, GROUP_A],
    ["foreign group", PERSONA_A, GROUP_B],
  ])("denies own chat paired with a %s", async (_label, personaId, groupId) => {
    await expect(verifySessionScope(makeSql(), CHAT_MINE, personaId, groupId, STUDENT))
      .resolves.toEqual({ authorized: false });
  });

  test("fails closed on database errors", async () => {
    await expect(verifySessionScope(makeSql({ fail: true }), CHAT_MINE, PERSONA_A, GROUP_A, STUDENT))
      .resolves.toEqual({ authorized: false });
  });
});

// ── Route wiring (source level) ─────────────────────────────────────────────

const source = fs.readFileSync(path.join(__dirname, "..", "studentFunction.js"), "utf8");

function handlerBlock(routeKey) {
  const start = source.indexOf(`case "${routeKey}":`);
  if (start === -1) throw new Error(`route not found: ${routeKey}`);
  const next = source.indexOf('\n      case "', start + 1);
  const end = next === -1 ? source.indexOf("\n      default:", start) : next;
  return source.slice(start, end);
}

/** Index of the check must precede the first data query/write in the block. */
function expectCheckBefore(block, check, firstDataAccess) {
  const checkAt = block.indexOf(check);
  const dataAt = block.indexOf(firstDataAccess);
  expect(checkAt).toBeGreaterThan(-1);
  expect(dataAt).toBeGreaterThan(-1);
  expect(checkAt).toBeLessThan(dataAt);
}

const FORBIDDEN = /response\.statusCode = 403;\s+response\.body = JSON\.stringify\(\{ error: "Forbidden" \}\);\s+break;/;

describe("student route wiring", () => {
  test.each([
    ["GET /student/persona_media", "verifyPersonaEnrollment(sqlConnection, persona_id, userEmailAttribute)", 'FROM "persona_media"'],
    ["GET /student/patient_voice_id", "verifyPersonaEnrollment(sqlConnection, patientId, userEmailAttribute)", "SELECT voice_id"],
    ["GET /student/voice_enabled", "verifyEnrollment(sqlConnection, simulation_group_id, userEmailAttribute)", "SELECT admin_voice_enabled"],
  ])("%s checks access (admin bypass) before reading", (route, check, firstRead) => {
    const block = handlerBlock(route);
    expectCheckBefore(block, "isAdmin(sqlConnection, userEmailAttribute)", firstRead);
    expectCheckBefore(block, check, firstRead);
    expect(block).toMatch(FORBIDDEN);
  });

  test.each(["POST /student/debrief_feedback", "POST /student/issue_report"])(
    "%s binds the body chat/persona/group to the caller before inserting",
    (route) => {
      const block = handlerBlock(route);
      const checkAt = block.search(
        /verifySessionScope\(\s*sqlConnection, chat_id, persona_id, simulation_group_id, userEmailAttribute\s*\)/
      );
      expect(checkAt).toBeGreaterThan(-1);
      expect(checkAt).toBeLessThan(block.indexOf("INSERT INTO"));
      expect(block).toMatch(FORBIDDEN);
    }
  );

  test("GET /student/patient_context reads the persona only within the authorized group", () => {
    const block = handlerBlock("GET /student/patient_context");
    expect(block).toMatch(
      /FROM "personas"\s+WHERE persona_id = \$\{patient_id\}\s+AND simulation_group_id = \$\{simulation_group_id\}/
    );
    expectCheckBefore(block, "verifyEnrollment(sqlConnection, simulation_group_id, userEmailAttribute)", 'FROM "personas"');
  });

  describe("POST /student/enroll_student enrollment_type", () => {
    const block = handlerBlock("POST /student/enroll_student");

    test("never assigns the query-string enrollment_type directly", () => {
      expect(block).not.toMatch(/\?\s*event\.queryStringParameters\.enrollment_type/);
      expect(block).not.toMatch(/=\s*event\.queryStringParameters\.enrollment_type\s*[;:]/);
    });

    test("checks the authenticated caller's DB roles before granting preview", () => {
      expectCheckBefore(
        block,
        'SELECT roles FROM "users" WHERE user_email = ${userEmailAttribute}',
        "enrollment_type = 'preview';"
      );
      expect(block).toMatch(/!callerRoles\.includes\('instructor'\) && !callerRoles\.includes\('admin'\)/);
      expect(block).toMatch(FORBIDDEN);
    });

    test("decides the type before any enrollment write", () => {
      expectCheckBefore(block, "enrollment_type = 'preview';", 'INSERT INTO "enrollments"');
    });
  });

  test("the unreachable, unauthenticated GET /session/messages route is removed", () => {
    expect(source).not.toContain('case "GET /session/messages"');
  });
});
