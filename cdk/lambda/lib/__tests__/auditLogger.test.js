"use strict";
/**
 * logger.audit(): AUDIT records identify the actor by Cognito sub (actorId),
 * never by email, and every API handler emits one on its way out.
 */
const fs = require("fs");
const path = require("path");
const logger = require("../logger.js");

const SUB = "0b1c2d3e-4f50-4617-8899-aabbccddeeff";
const EMAIL = "student@example.edu";

function mutatingEvent(overrides = {}) {
  return {
    httpMethod: "DELETE",
    resource: "/student/delete_session",
    queryStringParameters: { session_id: "s-1", email: EMAIL, group_access_code: "secret" },
    requestContext: {
      requestId: "api-req-1",
      identity: { sourceIp: "203.0.113.7" },
      authorizer: { userId: SUB, email: EMAIL },
    },
    ...overrides,
  };
}

/** Runs fn and returns the parsed JSON lines it wrote through console.log. */
function captureLogs(fn) {
  const spy = jest.spyOn(console, "log").mockImplementation(() => {});
  try {
    fn();
    return spy.mock.calls.map(([line]) => JSON.parse(line));
  } finally {
    spy.mockRestore();
  }
}

describe("logger.audit", () => {
  test("records the actor by Cognito sub and never by email", () => {
    const event = mutatingEvent();
    const [entry] = captureLogs(() => {
      logger.init(event, { awsRequestId: "lambda-req-1" });
      logger.audit(event, { actorId: SUB, statusCode: 200 });
    });
    expect(entry).toMatchObject({
      message: "AUDIT",
      action: "DELETE /student/delete_session",
      actorId: SUB,
      sourceIp: "203.0.113.7",
      targetIds: { session_id: "s-1" },
      statusCode: 200,
      outcome: "success",
    });
    expect(entry).not.toHaveProperty("actorEmail");
    expect(JSON.stringify(entry)).not.toContain(EMAIL);
    expect(JSON.stringify(entry)).not.toContain("secret");
  });

  test("marks 4xx and 5xx responses as failures", () => {
    const event = mutatingEvent();
    const [entry] = captureLogs(() => logger.audit(event, { actorId: SUB, statusCode: 403 }));
    expect(entry.outcome).toBe("failure");
  });

  test("ignores read-only requests", () => {
    const event = mutatingEvent({ httpMethod: "GET" });
    expect(captureLogs(() => logger.audit(event, { actorId: SUB, statusCode: 200 }))).toEqual([]);
  });
});

describe("handlers emit AUDIT records keyed by actorId", () => {
  const handlers = {
    student: "../studentFunction.js",
    instructor: "../instructorFunction.js",
    admin: "../../adminFunction/adminFunction.js",
  };
  for (const [name, rel] of Object.entries(handlers)) {
    test(`${name} handler calls logger.audit with actorId`, () => {
      const src = fs.readFileSync(path.join(__dirname, rel), "utf8");
      expect(src).toMatch(/logger\.audit\(event,\s*\{\s*actorId:/);
      expect(src).not.toMatch(/logger\.audit\([^)]*actorEmail/);
    });
  }

  test("admin logger copy is identical to the shared logger", () => {
    const shared = fs.readFileSync(path.join(__dirname, "../logger.js"));
    const admin = fs.readFileSync(path.join(__dirname, "../../adminFunction/logger.js"));
    expect(admin.equals(shared)).toBe(true);
  });
});
