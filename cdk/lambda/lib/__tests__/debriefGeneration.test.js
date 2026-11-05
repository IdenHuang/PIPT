"use strict";

/**
 * Debrief async invoke (security finding f-9a43bb3a): the payload names its
 * trigger so the text generation Lambda can fail the invoke for Lambda's
 * retries, and carries no JWT or body, since failed events are kept in the
 * debrief failure queue.
 */

const fs = require("fs");
const path = require("path");
const {
  DEBRIEF_TRIGGER,
  getPatientMode,
  buildDebriefPayload,
  buildInvokeInput,
} = require("../debriefGeneration.js");

const params = {
  sessionId: "55555555-5555-4555-8555-555555555555",
  simulationGroupId: "group-1",
  patientId: "persona-1",
  patientMode: "full_assessment",
  trigger: DEBRIEF_TRIGGER.CONCLUDE,
  authorizer: { email: "s@example.com", userId: "u-1", jwt: "secret" },
};

describe("buildDebriefPayload", () => {
  const payload = buildDebriefPayload(params);

  test("sets the debrief query parameters and the trigger", () => {
    expect(payload.queryStringParameters).toEqual({
      simulation_group_id: "group-1",
      session_id: params.sessionId,
      patient_id: "persona-1",
      mode: "debrief",
      patient_mode: "full_assessment",
      debrief_trigger: "conclude",
    });
  });

  test("carries only the authorizer email and userId, no headers or body", () => {
    expect(payload.requestContext).toEqual({
      authorizer: { email: "s@example.com", userId: "u-1" },
    });
    expect(payload).not.toHaveProperty("headers");
    expect(payload).not.toHaveProperty("body");
  });
});

test("the invoke is an async Event invoke of the given function", () => {
  const input = buildInvokeInput(params, "text-gen");
  expect(input.FunctionName).toBe("text-gen");
  expect(input.InvocationType).toBe("Event");
  expect(JSON.parse(input.Payload)).toEqual(buildDebriefPayload(params));
});

describe("getPatientMode", () => {
  function sqlReturning(dtp, rec, ques) {
    const counts = [dtp, rec, ques];
    return async () => [{ count: counts.shift() }];
  }

  test.each([
    [0, 0, 0, "conversation_only"],
    [0, 0, 3, "interview_practice"],
    [1, 0, 0, "full_assessment"],
    [0, 2, 5, "full_assessment"],
  ])("dtp=%i rec=%i ques=%i -> %s", async (dtp, rec, ques, mode) => {
    expect(await getPatientMode(sqlReturning(dtp, rec, ques), "g", "p")).toBe(mode);
  });
});

describe("studentFunction debrief triggers", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "studentFunction.js"), "utf8");

  function handlerBlock(routeKey) {
    const start = source.indexOf(`case "${routeKey}":`);
    const next = source.indexOf('\n      case "', start + 1);
    return source.slice(start, next === -1 ? undefined : next);
  }

  test("conclude_interaction invokes with the conclude trigger", () => {
    const block = handlerBlock("POST /student/conclude_interaction");
    expect(block).toMatch(/invokeDebriefGeneration\([\s\S]*?trigger: DEBRIEF_TRIGGER\.CONCLUDE/);
    expect(block).not.toMatch(/headers: event\.headers/);
  });

  test("get_debrief requests recovery only for chats concluded over 5 minutes ago", () => {
    const block = handlerBlock("GET /student/get_debrief");
    const ownership = block.indexOf("e.user_id = ${userId}");
    const recovery = block.indexOf("trigger: DEBRIEF_TRIGGER.RECOVERY");
    expect(ownership).toBeGreaterThan(-1);
    expect(recovery).toBeGreaterThan(ownership);
    expect(block).toMatch(/AND c\.status = 'concluded'\s+AND c\.ended_at < NOW\(\) - INTERVAL '5 minutes'/);
  });
});
