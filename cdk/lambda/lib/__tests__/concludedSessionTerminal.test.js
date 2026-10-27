"use strict";

/**
 * Regression test for security finding f-7d966e0e: a concluded chat is
 * terminal server-side. Source-level, in the same style as
 * concludeInteractionAuthz.test.js.
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

describe("POST /student/conclude_interaction is one-way", () => {
  const block = handlerBlock("POST /student/conclude_interaction");

  test("the conclude UPDATE only matches chats that are not yet concluded", () => {
    expect(block).toMatch(
      /SET recommendation[\s\S]*?status = 'concluded'[\s\S]*?WHERE chat_id = \$\{sessionId\}\s+AND status IS DISTINCT FROM 'concluded'\s+RETURNING \*/
    );
  });

  test("a no-op update returns 409 before any further writes", () => {
    const update = block.indexOf("AND status IS DISTINCT FROM 'concluded'");
    const conflict = block.indexOf("response.statusCode = 409;", update);
    const interactionWrite = block.indexOf('UPDATE "student_interactions"');
    const debriefInvoke = block.indexOf('mode: "debrief"');
    expect(conflict).toBeGreaterThan(update);
    expect(conflict).toBeLessThan(interactionWrite);
    expect(conflict).toBeLessThan(debriefInvoke);
  });
});

describe("POST /student/create_message refuses concluded chats", () => {
  const block = handlerBlock("POST /student/create_message");

  test("reads chats.status and rejects 'concluded' with 409 before inserting", () => {
    const statusRead = block.indexOf("c.status AS chat_status");
    const check = block.indexOf("groupSettings[0].chat_status === 'concluded'");
    const conflict = block.indexOf("response.statusCode = 409;", check);
    const insert = block.indexOf('INSERT INTO "messages"');
    expect(statusRead).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(statusRead);
    expect(conflict).toBeGreaterThan(check);
    expect(conflict).toBeLessThan(insert);
  });
});
