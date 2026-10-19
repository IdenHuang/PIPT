"use strict";

/**
 * Authorization gate for socket events that act on a chat session
 * (start-nova-sonic, text-generation).
 *
 * Kept free of DB/AWS dependencies so it can be unit tested; the scope check
 * is injected (session-auth.js verifySessionScope in production).
 *
 * Fail-closed rules:
 *   - No authenticated email on the socket → deny. A token without an email
 *     claim must not skip the ownership check.
 *   - session_id, patient_id and simulation_group_id are all required. Omitting
 *     session_id must not skip the check or fall back to a shared history key.
 *   - The caller must own the chat, and the chat must belong to that patient
 *     and group.
 *   - Any error from the scope check → deny.
 */

const REQUIRED_FIELDS = ["sessionId", "patientId", "simulationGroupId"];

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * @param {object} params
 * @param {string} [params.userEmail] - Email from the verified socket token
 * @param {string} [params.sessionId] - Client-supplied chat_id
 * @param {string} [params.patientId] - Client-supplied persona_id
 * @param {string} [params.simulationGroupId] - Client-supplied simulation_group_id
 * @param {(sessionId: string, personaId: string, groupId: string, email: string) => Promise<{authorized: boolean}>} verifyScope
 * @returns {Promise<{allowed: true} | {allowed: false, error: string}>}
 */
async function authorizeSessionRequest(params, verifyScope) {
  const { userEmail, sessionId, patientId, simulationGroupId } = params || {};

  if (!isNonEmptyString(userEmail)) {
    return { allowed: false, error: "Access denied: missing user identity" };
  }
  for (const field of REQUIRED_FIELDS) {
    if (!isNonEmptyString(params[field])) {
      return { allowed: false, error: "Access denied: session_id, patient_id and simulation_group_id are required" };
    }
  }

  try {
    const result = await verifyScope(sessionId, patientId, simulationGroupId, userEmail);
    if (result && result.authorized === true) {
      return { allowed: true };
    }
  } catch {
    // fall through to deny
  }
  return { allowed: false, error: "Access denied: you do not own this session" };
}

module.exports = { authorizeSessionRequest };
