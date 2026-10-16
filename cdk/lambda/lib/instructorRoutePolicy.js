"use strict";

/**
 * Object-level authorization policy for every /instructor/* route.
 *
 * instructorFunction.js gates on role (instructor/admin) first. This module adds
 * the second check: is the caller attached to the specific group, persona or
 * organization the request targets? It runs once, before the route switch, so a
 * new route cannot ship without a policy entry.
 *
 * Fail-closed rules:
 *   - A route missing from INSTRUCTOR_ROUTE_POLICY is rejected (403).
 *   - A required scoped parameter that is missing or not a string is rejected (400)
 *     before any handler code runs.
 *   - Any ownership helper error resolves to "not authorized" (see authz.js).
 *
 * Admins skip ownership checks, matching the existing admin bypass. Child IDs are
 * still resolved for admins so handlers can bind their SQL to the parent scope.
 */

const {
  verifyGroupOwnership,
  verifyPersonaOwnership,
  verifyOrganizationMembership,
  resolveParentId,
} = require("./authz.js");

// ── Check builders ────────────────────────────────────────────────────────────
// Each check names the object type, where the ID comes from, and whether the
// parameter is optional. `child` checks resolve a child record to its parent
// (group / persona / organization) and authorize the parent.

const group = (param = "simulation_group_id", opts = {}) => ({ type: "group", param, source: "query", ...opts });
const persona = (param = "persona_id", opts = {}) => ({ type: "persona", param, source: "query", ...opts });
const organization = (param = "organization_id", opts = {}) => ({ type: "organization", param, source: "query", ...opts });
const child = (kind, param) => ({ type: "child", kind, param, source: "query" });

/**
 * Child kinds → the parent type that owns them. Kinds must match resolveParentId.
 */
const CHILD_PARENT_TYPE = Object.freeze({
  student_interaction: "group",
  group_question: "group",
  group_dtp: "group",
  group_recommendation: "group",
  persona_media: "persona",
  question_bank_item: "organization",
  dtp_bank_item: "organization",
  recommendation_bank_item: "organization",
});

/** Scope key exposed to handlers for each parent type. */
const SCOPE_KEY = Object.freeze({
  group: "simulationGroupId",
  persona: "personaId",
  organization: "organizationId",
});

/**
 * Routes that act only on the caller's own identity (derived from the JWT email)
 * or on static content. No object-level check applies.
 */
const CALLER_SCOPED = Object.freeze([]);

/**
 * Every /instructor/* route and the checks it requires. Keys must match the
 * `case` labels in instructorFunction.js exactly.
 */
const INSTRUCTOR_ROUTE_POLICY = Object.freeze({
  // ── Caller-scoped / static ────────────────────────────────────────────────
  "GET /instructor/student_group": CALLER_SCOPED,
  "GET /instructor/groups": CALLER_SCOPED,
  "POST /instructor/create_simulation_group": CALLER_SCOPED,
  "GET /instructor/get_default_debrief_prompt": CALLER_SCOPED,
  "GET /instructor/get_default_system_prompt": CALLER_SCOPED,
  "GET /instructor/get_default_persona_prompt": CALLER_SCOPED,
  // Intentionally unscoped: the question bank list is global by product design
  // (see frontend/src/hooks/useInstructorQuestionBank.ts). Writes are scoped below.
  "GET /instructor/question_bank": CALLER_SCOPED,

  // ── Group-scoped ──────────────────────────────────────────────────────────
  "GET /instructor/analytics": [group()],
  "POST /instructor/create_patient": [group()],
  "PUT /instructor/prompt": [group()],
  "GET /instructor/view_students": [group()],
  "DELETE /instructor/delete_student": [group()],
  "GET /instructor/view_patients": [group()],
  "GET /instructor/get_prompt": [group()],
  "GET /instructor/get_debrief_prompt": [group()],
  "PUT /instructor/debrief_prompt": [group()],
  "GET /instructor/get_prompt_history": [group()],
  "GET /instructor/view_student_messages": [group()],
  "PUT /instructor/generate_access_code": [group()],
  "GET /instructor/get_access_code": [group()],
  "GET /instructor/previous_prompts": [group()],
  "GET /instructor/student_patients_messages": [group()],
  "GET /instructor/get_completion_status": [group()],
  "POST /instructor/update_voice_settings": [group()],
  "GET /instructor/key_question_coverage": [group()],
  "GET /instructor/get_debrief": [group()],
  "GET /instructor/completed_sessions": [group()],
  "GET /instructor/dtp_coverage": [group()],
  "GET /instructor/recommendation_coverage": [group()],
  // Reorders: the handler already binds each group_*_id to simulation_group_id.
  "PUT /instructor/simulation_group_dtps": [group()],
  "PUT /instructor/simulation_group_recommendations": [group()],

  // ── Group + persona (both must be owned) ──────────────────────────────────
  "PUT /instructor/edit_patient": [group(), persona()],
  "GET /instructor/ingestion_status": [group(), persona()],
  "GET /instructor/patient_key_question_analytics": [group(), persona()],
  "GET /instructor/student_progress": [group(), persona()],
  "GET /instructor/patient_dtp_analytics": [group(), persona()],
  "GET /instructor/patient_recommendation_analytics": [group(), persona()],
  "GET /instructor/simulation_group_questions": [group(), persona("persona_id", { optional: true })],
  "GET /instructor/question_interactions": [group(), persona("persona_id", { optional: true })],
  "GET /instructor/simulation_group_dtps": [group(), persona("persona_id", { optional: true })],
  "GET /instructor/simulation_group_recommendations": [group(), persona("persona_id", { optional: true })],
  // Bank bindings carry an optional persona_id in the body. The DTP and
  // recommendation handlers also call verifyBankItemsInGroupOrganization on the
  // body-supplied bank IDs (those banks are org-scoped). Question IDs are not
  // org-checked because the question bank is global (see GET above).
  "POST /instructor/simulation_group_questions": [group(), persona("persona_id", { source: "body", optional: true })],
  "POST /instructor/simulation_group_dtps": [group(), persona("persona_id", { source: "body", optional: true })],
  "POST /instructor/simulation_group_recommendations": [group(), persona("persona_id", { source: "body", optional: true })],

  // ── Persona-scoped ────────────────────────────────────────────────────────
  "PUT /instructor/update_metadata": [persona()],
  "PUT /instructor/reorder_patient": [persona()],
  "DELETE /instructor/delete_patient": [persona()],
  "PUT /instructor/toggle_llm_completion": [persona()],
  "GET /instructor/persona_media": [persona()],
  "POST /instructor/persona_media": [persona()],

  // ── Child records resolved to their parent ────────────────────────────────
  "PUT /instructor/toggle_completion": [child("student_interaction", "student_interaction_id")],
  "PUT /instructor/simulation_group_questions": [child("group_question", "group_question_id")],
  "DELETE /instructor/simulation_group_questions": [child("group_question", "group_question_id")],
  "DELETE /instructor/simulation_group_dtps": [child("group_dtp", "group_dtp_id")],
  "DELETE /instructor/simulation_group_recommendations": [child("group_recommendation", "group_recommendation_id")],
  "PUT /instructor/persona_media": [child("persona_media", "media_id")],
  "DELETE /instructor/persona_media": [child("persona_media", "media_id")],

  // ── Organization-scoped banks ─────────────────────────────────────────────
  "POST /instructor/question_bank": [organization()],
  "PUT /instructor/question_bank": [child("question_bank_item", "question_id")],
  "GET /instructor/dtp_bank": [organization()],
  "POST /instructor/dtp_bank": [organization()],
  "PUT /instructor/dtp_bank": [child("dtp_bank_item", "dtp_id")],
  "GET /instructor/recommendations_bank": [organization()],
  "POST /instructor/recommendations_bank": [organization()],
  "PUT /instructor/recommendations_bank": [child("recommendation_bank_item", "recommendation_id")],
});

const OWNERSHIP_VERIFIERS = Object.freeze({
  group: verifyGroupOwnership,
  persona: verifyPersonaOwnership,
  organization: verifyOrganizationMembership,
});

/** Parse a JSON request body for policy lookups; anything unparseable is treated as empty. */
function parseBodyForPolicy(rawBody) {
  if (!rawBody) return {};
  try {
    const parsed = JSON.parse(rawBody);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

const deny = (statusCode, error) => ({ allowed: false, statusCode, error });

/**
 * Authorize an /instructor/* request against INSTRUCTOR_ROUTE_POLICY.
 *
 * @param {object} params
 * @param {object} params.sqlConnection - postgres tagged template connection
 * @param {string} params.routeKey - `${httpMethod} ${resource}`
 * @param {object} [params.queryStringParameters] - API Gateway query parameters
 * @param {string} [params.body] - Raw request body
 * @param {string} params.userEmail - Authenticated email from the authorizer context
 * @param {boolean} params.isAdmin - Whether the caller holds the admin role
 * @returns {Promise<{allowed: true, scope: object} | {allowed: false, statusCode: number, error: string}>}
 *   `scope` holds the authorized simulationGroupId / personaId / organizationId so
 *   handlers can bind child-record SQL to the parent that was checked.
 */
async function authorizeInstructorRequest({
  sqlConnection,
  routeKey,
  queryStringParameters,
  body,
  userEmail,
  isAdmin,
}) {
  const checks = INSTRUCTOR_ROUTE_POLICY[routeKey];
  if (!checks) {
    return deny(403, "Forbidden: route has no authorization policy");
  }

  const sources = {
    query: queryStringParameters || {},
    body: checks.some((c) => c.source === "body") ? parseBodyForPolicy(body) : {},
  };
  const scope = {};

  try {
    for (const check of checks) {
      const value = sources[check.source][check.param];

      if (value === undefined || value === null || value === "") {
        if (check.optional) continue;
        return deny(400, `${check.param} is required`);
      }
      if (typeof value !== "string") {
        return deny(400, `${check.param} must be a string`);
      }

      let parentType = check.type;
      let parentId = value;

      if (check.type === "child") {
        parentType = CHILD_PARENT_TYPE[check.kind];
        if (!parentType) return deny(403, "Forbidden: you do not own this resource");
        parentId = await resolveParentId(sqlConnection, check.kind, value);
        if (!parentId) {
          // Admins fall through so the handler can return its own 404.
          if (isAdmin) {
            scope[SCOPE_KEY[parentType]] = null;
            continue;
          }
          return deny(403, "Forbidden: you do not own this resource");
        }
      }

      if (!isAdmin) {
        const verify = OWNERSHIP_VERIFIERS[parentType];
        const result = verify ? await verify(sqlConnection, parentId, userEmail) : { authorized: false };
        if (!result.authorized) {
          return deny(403, "Forbidden: you do not own this resource");
        }
      }

      scope[SCOPE_KEY[parentType]] = parentId;
    }
  } catch {
    return deny(403, "Forbidden: you do not own this resource");
  }

  return { allowed: true, scope };
}

module.exports = {
  INSTRUCTOR_ROUTE_POLICY,
  CHILD_PARENT_TYPE,
  authorizeInstructorRequest,
};
