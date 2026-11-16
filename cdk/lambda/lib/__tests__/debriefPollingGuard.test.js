"use strict";

/**
 * Regression test for security finding f-7ad37f17: get_debrief must not enter
 * its ~19s retry loop for chats that can never have a debrief. Source-level,
 * in the same style as concludedSessionTerminal.test.js.
 */

const fs = require("fs");
const path = require("path");

function handlerBlock(file, routeKey) {
  const source = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
  const start = source.indexOf(`case "${routeKey}":`);
  if (start === -1) throw new Error(`route not found: ${routeKey}`);
  const next = source.indexOf('\n      case "', start + 1);
  return source.slice(start, next === -1 ? undefined : next);
}

describe("GET /instructor/get_debrief", () => {
  const block = handlerBlock("instructorFunction.js", "GET /instructor/get_debrief");

  test("reads chats.status in the access check", () => {
    expect(block).toMatch(/SELECT c\.chat_id, c\.status\s+FROM "chats" c/);
  });

  test("returns not_concluded before the retry loop", () => {
    const guard = block.indexOf("accessCheck[0].status !== 'concluded'");
    const terminal = block.indexOf('status: "not_concluded"', guard);
    const loop = block.indexOf("for (let attempt = 0");
    expect(guard).toBeGreaterThan(-1);
    expect(terminal).toBeGreaterThan(guard);
    expect(loop).toBeGreaterThan(terminal);
  });
});

describe("GET /student/get_debrief", () => {
  const block = handlerBlock("studentFunction.js", "GET /student/get_debrief");

  test("returns no_transcript for a chat with no messages, before the loop and recovery", () => {
    const exists = block.indexOf('SELECT 1 FROM "messages" m WHERE m.chat_id = c.chat_id');
    const guard = block.indexOf("!chatRow[0]?.has_messages");
    const terminal = block.indexOf('status: "no_transcript"', guard);
    const loop = block.indexOf("for (let attempt = 0");
    const recovery = block.indexOf("invokeDebriefGeneration(");
    expect(exists).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(exists);
    expect(terminal).toBeGreaterThan(guard);
    expect(loop).toBeGreaterThan(terminal);
    expect(recovery).toBeGreaterThan(terminal);
  });
});
