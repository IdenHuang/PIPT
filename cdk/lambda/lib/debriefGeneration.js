"use strict";

/**
 * Starts debrief generation in the text generation Lambda.
 *
 * Both callers invoke it asynchronously (InvocationType "Event"):
 *   - conclude_interaction, trigger "conclude". The text generation Lambda
 *     fails the invocation on errors and on claim contention, so Lambda's
 *     async retries run, and an event that still fails lands in the debrief
 *     failure queue (api-service-stack.ts).
 *   - get_debrief, trigger "recovery", for a concluded chat that still has no
 *     debrief well after it ended. The text generation Lambda allows one
 *     recovery run per chat per 5 minutes.
 * https://docs.aws.amazon.com/lambda/latest/dg/invocation-async-error-handling.html
 */

const DEBRIEF_TRIGGER = Object.freeze({
  CONCLUDE: "conclude",
  RECOVERY: "recovery",
});

/**
 * Patient mode for a persona in a group, from its DTP / recommendation /
 * question assignments. Must match the mode computed by
 * GET /student/simulation_group_page and GET /instructor/view_patients.
 *   - conversation_only: nothing assigned; the student only chats.
 *   - interview_practice: no DTPs or recommendations; key question feedback only.
 *   - full_assessment: any DTP or recommendation; submissions are matched
 *     against the instructor's expected items during the debrief.
 */
async function getPatientMode(sql, simulationGroupId, patientId) {
  const [dtpCount] = await sql`
    SELECT COUNT(*)::int AS count FROM simulation_group_dtps
    WHERE simulation_group_id = ${simulationGroupId}
      AND (persona_id = ${patientId} OR persona_id IS NULL);
  `;
  const [recCount] = await sql`
    SELECT COUNT(*)::int AS count FROM simulation_group_recommendations
    WHERE simulation_group_id = ${simulationGroupId}
      AND (persona_id = ${patientId} OR persona_id IS NULL);
  `;
  const [quesCount] = await sql`
    SELECT COUNT(*)::int AS count FROM simulation_group_questions
    WHERE simulation_group_id = ${simulationGroupId}
      AND (persona_id = ${patientId} OR persona_id IS NULL);
  `;
  if (quesCount.count === 0 && dtpCount.count === 0 && recCount.count === 0) {
    return "conversation_only";
  }
  if (dtpCount.count === 0 && recCount.count === 0) {
    return "interview_practice";
  }
  return "full_assessment";
}

/**
 * Event payload for a debrief run. It carries only what main.py reads: the
 * query parameters and the authorizer identity it authorizes on. The caller's
 * headers (which hold the Cognito JWT) and request body are left out, because
 * a failed event is kept in the failure queue.
 */
function buildDebriefPayload({
  sessionId,
  simulationGroupId,
  patientId,
  patientMode,
  trigger,
  authorizer,
}) {
  return {
    queryStringParameters: {
      simulation_group_id: simulationGroupId,
      session_id: sessionId,
      patient_id: patientId,
      mode: "debrief",
      patient_mode: patientMode,
      debrief_trigger: trigger,
    },
    requestContext: {
      authorizer: {
        email: authorizer?.email,
        userId: authorizer?.userId,
      },
    },
  };
}

/** Input for the Lambda InvokeCommand: an async ("Event") debrief run. */
function buildInvokeInput(params, functionName) {
  return {
    FunctionName: functionName,
    InvocationType: "Event",
    Payload: JSON.stringify(buildDebriefPayload(params)),
  };
}

/**
 * Invoke the text generation Lambda asynchronously. Throws if the invoke
 * itself fails; the caller decides whether that fails its request.
 * The SDK is required lazily: the Node.js Lambda runtime provides it.
 */
async function invokeDebriefGeneration(params, { functionName } = {}) {
  const { LambdaClient, InvokeCommand } = require("@aws-sdk/client-lambda");
  await new LambdaClient().send(new InvokeCommand(buildInvokeInput(params, functionName)));
}

module.exports = {
  DEBRIEF_TRIGGER,
  getPatientMode,
  buildDebriefPayload,
  buildInvokeInput,
  invokeDebriefGeneration,
};
