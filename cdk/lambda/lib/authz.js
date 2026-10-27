"use strict";

/**
 * Centralized Authorization Module
 *
 * Provides helper functions to verify resource ownership before allowing access.
 * All functions follow a fail-closed pattern: any database error returns { authorized: false }.
 *
 * Every denial is logged as a structured AUTHZ_DENY line (see logDenial), so
 * ownership-check failures, the main signal of IDOR probing, can be searched
 * and alarmed on in CloudWatch. Database errors are logged at ERROR level so
 * an outage is not mistaken for ordinary 403s.
 */

const logger = require("./logger");

/**
 * Logs one authorization denial.
 *
 * @param {string} check - Name of the helper that denied (e.g. "verifySessionOwnership")
 * @param {"not_authorized"|"invalid_input"|"error"} reason
 * @param {object} details - Actor email and the target identifiers; never request content
 * @param {Error} [error] - Set when the denial is caused by a failure, not a missing grant
 */
function logDenial(check, reason, details, error) {
  const data = { check, reason, ...details };
  if (error) {
    // Message only: stacks and SQL text are not needed to triage and may carry values.
    logger.error("AUTHZ_DENY", { ...data, error: error.message });
  } else {
    logger.warn("AUTHZ_DENY", data);
  }
}

/**
 * Verify that the authenticated user owns the given chat session.
 * Joins chats → student_interactions → enrollments → users to confirm ownership.
 *
 * @param {object} sqlConnection - postgres tagged template connection
 * @param {string} sessionId - The chat_id to verify ownership of
 * @param {string} userEmail - The authenticated user's email
 * @returns {Promise<{authorized: boolean, userId?: string}>}
 */
async function verifySessionOwnership(sqlConnection, sessionId, userEmail) {
  try {
    const result = await sqlConnection`
      SELECT u.user_id
      FROM chats c
      JOIN student_interactions si ON si.student_interaction_id = c.student_interaction_id
      JOIN enrollments e ON e.enrollment_id = si.enrollment_id
      JOIN users u ON u.user_id = e.user_id
      WHERE c.chat_id = ${sessionId}
        AND u.user_email = ${userEmail};
    `;

    if (result.length > 0) {
      return { authorized: true, userId: result[0].user_id };
    }
    logDenial("verifySessionOwnership", "not_authorized", { userEmail, sessionId });
    return { authorized: false };
  } catch (error) {
    logDenial("verifySessionOwnership", "error", { userEmail, sessionId }, error);
    return { authorized: false };
  }
}

/**
 * Verify that the authenticated instructor owns or is assigned to the given simulation group.
 * Checks if the user either created the group (simulation_groups.created_by)
 * or is assigned via the group_instructors table.
 *
 * @param {object} sqlConnection - postgres tagged template connection
 * @param {string} simulationGroupId - The simulation_group_id to verify ownership of
 * @param {string} userEmail - The authenticated user's email
 * @returns {Promise<{authorized: boolean}>}
 */
async function verifyGroupOwnership(sqlConnection, simulationGroupId, userEmail) {
  try {
    const result = await sqlConnection`
      SELECT 1
      FROM users u
      WHERE u.user_email = ${userEmail}
        AND (
          EXISTS (
            SELECT 1 FROM simulation_groups sg
            WHERE sg.simulation_group_id = ${simulationGroupId}
              AND sg.created_by = u.user_id
          )
          OR EXISTS (
            SELECT 1 FROM group_instructors gi
            WHERE gi.simulation_group_id = ${simulationGroupId}
              AND gi.user_id = u.user_id
          )
          OR EXISTS (
            SELECT 1 FROM enrollments e
            WHERE e.simulation_group_id = ${simulationGroupId}
              AND e.user_id = u.user_id
              AND e.enrollment_type = 'instructor'
          )
        );
    `;

    if (result.length === 0) {
      logDenial("verifyGroupOwnership", "not_authorized", { userEmail, simulationGroupId });
    }
    return { authorized: result.length > 0 };
  } catch (error) {
    logDenial("verifyGroupOwnership", "error", { userEmail, simulationGroupId }, error);
    return { authorized: false };
  }
}

/**
 * Verify that the authenticated user has an active enrollment in the given simulation group.
 *
 * @param {object} sqlConnection - postgres tagged template connection
 * @param {string} simulationGroupId - The simulation_group_id to check enrollment for
 * @param {string} userEmail - The authenticated user's email
 * @returns {Promise<{authorized: boolean, enrollmentId?: string}>}
 */
async function verifyEnrollment(sqlConnection, simulationGroupId, userEmail) {
  try {
    const result = await sqlConnection`
      SELECT e.enrollment_id
      FROM enrollments e
      JOIN users u ON u.user_id = e.user_id
      WHERE e.simulation_group_id = ${simulationGroupId}
        AND u.user_email = ${userEmail};
    `;

    if (result.length > 0) {
      return { authorized: true, enrollmentId: result[0].enrollment_id };
    }
    logDenial("verifyEnrollment", "not_authorized", { userEmail, simulationGroupId });
    return { authorized: false };
  } catch (error) {
    logDenial("verifyEnrollment", "error", { userEmail, simulationGroupId }, error);
    return { authorized: false };
  }
}

/**
 * Verify that the authenticated user is enrolled (any enrollment type) in the
 * simulation group that owns the given persona. Used by /student routes that
 * receive only a persona_id, so the group is derived server-side and cannot be
 * mismatched by the caller.
 *
 * @param {object} sqlConnection - postgres tagged template connection
 * @param {string} personaId - The persona_id being accessed
 * @param {string} userEmail - The authenticated user's email
 * @returns {Promise<{authorized: boolean}>}
 */
async function verifyPersonaEnrollment(sqlConnection, personaId, userEmail) {
  try {
    const result = await sqlConnection`
      SELECT 1
      FROM personas p
      JOIN enrollments e ON e.simulation_group_id = p.simulation_group_id
      JOIN users u ON u.user_id = e.user_id
      WHERE p.persona_id = ${personaId}
        AND u.user_email = ${userEmail};
    `;

    if (result.length === 0) {
      logDenial("verifyPersonaEnrollment", "not_authorized", { userEmail, personaId });
    }
    return { authorized: result.length > 0 };
  } catch (error) {
    logDenial("verifyPersonaEnrollment", "error", { userEmail, personaId }, error);
    return { authorized: false };
  }
}

/**
 * Verify that the authenticated user owns the chat AND that the chat belongs to
 * the given persona and simulation group. Use this when a request carries all
 * three IDs, so a caller cannot pair their own chat with another group's
 * persona (or vice versa).
 *
 * @param {object} sqlConnection - postgres tagged template connection
 * @param {string} sessionId - The chat_id
 * @param {string} personaId - The persona_id the chat must belong to
 * @param {string} simulationGroupId - The simulation_group_id the chat must belong to
 * @param {string} userEmail - The authenticated user's email
 * @returns {Promise<{authorized: boolean}>}
 */
async function verifySessionScope(sqlConnection, sessionId, personaId, simulationGroupId, userEmail) {
  try {
    const result = await sqlConnection`
      SELECT 1
      FROM chats c
      JOIN student_interactions si ON si.student_interaction_id = c.student_interaction_id
      JOIN enrollments e ON e.enrollment_id = si.enrollment_id
      JOIN users u ON u.user_id = e.user_id
      WHERE c.chat_id = ${sessionId}
        AND si.persona_id = ${personaId}
        AND e.simulation_group_id = ${simulationGroupId}
        AND u.user_email = ${userEmail};
    `;

    if (result.length === 0) {
      logDenial("verifySessionScope", "not_authorized", { userEmail, sessionId, personaId, simulationGroupId });
    }
    return { authorized: result.length > 0 };
  } catch (error) {
    logDenial("verifySessionScope", "error", { userEmail, sessionId, personaId, simulationGroupId }, error);
    return { authorized: false };
  }
}

/**
 * Verify that the authenticated instructor owns or is assigned to the group
 * that the given persona belongs to.
 * Joins personas → simulation_groups and checks created_by or group_instructors.
 *
 * @param {object} sqlConnection - postgres tagged template connection
 * @param {string} personaId - The persona_id to verify ownership of
 * @param {string} userEmail - The authenticated user's email
 * @returns {Promise<{authorized: boolean}>}
 */
async function verifyPersonaOwnership(sqlConnection, personaId, userEmail) {
  try {
    const result = await sqlConnection`
      SELECT 1
      FROM users u
      WHERE u.user_email = ${userEmail}
        AND (
          EXISTS (
            SELECT 1 FROM personas p
            JOIN simulation_groups sg ON sg.simulation_group_id = p.simulation_group_id
            WHERE p.persona_id = ${personaId}
              AND sg.created_by = u.user_id
          )
          OR EXISTS (
            SELECT 1 FROM personas p
            JOIN group_instructors gi ON gi.simulation_group_id = p.simulation_group_id
            WHERE p.persona_id = ${personaId}
              AND gi.user_id = u.user_id
          )
          OR EXISTS (
            SELECT 1 FROM personas p
            JOIN enrollments e ON e.simulation_group_id = p.simulation_group_id
            WHERE p.persona_id = ${personaId}
              AND e.user_id = u.user_id
              AND e.enrollment_type = 'instructor'
          )
        );
    `;

    if (result.length === 0) {
      logDenial("verifyPersonaOwnership", "not_authorized", { userEmail, personaId });
    }
    return { authorized: result.length > 0 };
  } catch (error) {
    logDenial("verifyPersonaOwnership", "error", { userEmail, personaId }, error);
    return { authorized: false };
  }
}

/**
 * Verify that the authenticated user belongs to the given organization.
 *
 * A user belongs to an organization when either:
 *   - users.organization_id is that organization (assigned by an admin), or
 *   - they are attached as an instructor (created_by, group_instructors, or an
 *     instructor enrollment) to at least one simulation group in it.
 *
 * The second path mirrors how the instructor frontend resolves organizations:
 * it reads them off the caller's own simulation groups.
 *
 * @param {object} sqlConnection - postgres tagged template connection
 * @param {string} organizationId - The organization_id to verify membership of
 * @param {string} userEmail - The authenticated user's email
 * @returns {Promise<{authorized: boolean}>}
 */
async function verifyOrganizationMembership(sqlConnection, organizationId, userEmail) {
  try {
    const result = await sqlConnection`
      SELECT 1
      FROM users u
      WHERE u.user_email = ${userEmail}
        AND (
          u.organization_id = ${organizationId}
          OR EXISTS (
            SELECT 1 FROM simulation_groups sg
            WHERE sg.organization_id = ${organizationId}
              AND (
                sg.created_by = u.user_id
                OR EXISTS (
                  SELECT 1 FROM group_instructors gi
                  WHERE gi.simulation_group_id = sg.simulation_group_id
                    AND gi.user_id = u.user_id
                )
                OR EXISTS (
                  SELECT 1 FROM enrollments e
                  WHERE e.simulation_group_id = sg.simulation_group_id
                    AND e.user_id = u.user_id
                    AND e.enrollment_type = 'instructor'
                )
              )
          )
        );
    `;

    if (result.length === 0) {
      logDenial("verifyOrganizationMembership", "not_authorized", { userEmail, organizationId });
    }
    return { authorized: result.length > 0 };
  } catch (error) {
    logDenial("verifyOrganizationMembership", "error", { userEmail, organizationId }, error);
    return { authorized: false };
  }
}

/**
 * Resolve a child record to the ID of the parent object that owns it, so the
 * parent can be authorized with verifyGroupOwnership / verifyPersonaOwnership /
 * verifyOrganizationMembership.
 *
 * Each kind maps to a fixed query; no table or column names are built from input.
 *
 * | kind                      | child table                       | returns              |
 * |---------------------------|-----------------------------------|----------------------|
 * | student_interaction       | student_interactions → enrollments| simulation_group_id  |
 * | group_question            | simulation_group_questions        | simulation_group_id  |
 * | group_dtp                 | simulation_group_dtps             | simulation_group_id  |
 * | group_recommendation      | simulation_group_recommendations  | simulation_group_id  |
 * | persona_media             | persona_media                     | persona_id           |
 * | question_bank_item        | question_bank                     | organization_id      |
 * | dtp_bank_item             | dtp_bank                          | organization_id      |
 * | recommendation_bank_item  | recommendations_bank              | organization_id      |
 *
 * Fail-closed: an unknown kind, a missing row, or any database error returns null.
 *
 * @param {object} sqlConnection - postgres tagged template connection
 * @param {string} kind - One of the kinds in the table above
 * @param {string} childId - Primary key of the child record
 * @returns {Promise<string|null>} The parent ID, or null if it cannot be resolved
 */
async function resolveParentId(sqlConnection, kind, childId) {
  try {
    let rows;
    switch (kind) {
      case "student_interaction":
        rows = await sqlConnection`
          SELECT e.simulation_group_id AS parent_id
          FROM student_interactions si
          JOIN enrollments e ON e.enrollment_id = si.enrollment_id
          WHERE si.student_interaction_id = ${childId};
        `;
        break;
      case "group_question":
        rows = await sqlConnection`
          SELECT simulation_group_id AS parent_id
          FROM simulation_group_questions
          WHERE group_question_id = ${childId};
        `;
        break;
      case "group_dtp":
        rows = await sqlConnection`
          SELECT simulation_group_id AS parent_id
          FROM simulation_group_dtps
          WHERE group_dtp_id = ${childId};
        `;
        break;
      case "group_recommendation":
        rows = await sqlConnection`
          SELECT simulation_group_id AS parent_id
          FROM simulation_group_recommendations
          WHERE group_recommendation_id = ${childId};
        `;
        break;
      case "persona_media":
        rows = await sqlConnection`
          SELECT persona_id AS parent_id
          FROM persona_media
          WHERE media_id = ${childId};
        `;
        break;
      case "question_bank_item":
        rows = await sqlConnection`
          SELECT organization_id AS parent_id
          FROM question_bank
          WHERE question_id = ${childId};
        `;
        break;
      case "dtp_bank_item":
        rows = await sqlConnection`
          SELECT organization_id AS parent_id
          FROM dtp_bank
          WHERE dtp_id = ${childId};
        `;
        break;
      case "recommendation_bank_item":
        rows = await sqlConnection`
          SELECT organization_id AS parent_id
          FROM recommendations_bank
          WHERE recommendation_id = ${childId};
        `;
        break;
      default:
        logDenial("resolveParentId", "invalid_input", { kind, childId });
        return null;
    }
    // A missing row is not logged here: the caller decides whether it is a
    // denial (non-admins) or a 404 (admins), and logs accordingly.
    return rows.length > 0 && rows[0].parent_id ? rows[0].parent_id : null;
  } catch (error) {
    logDenial("resolveParentId", "error", { kind, childId }, error);
    return null;
  }
}

/**
 * Bank kinds that are tenant-scoped by organization, mapped to the fixed query
 * that returns how many of the given item IDs belong to the group's organization.
 * No table or column names are built from input.
 *
 * The question bank is absent because instructor-created simulation groups have
 * no organization, so it needs a membership fallback; see
 * verifyQuestionsAttachableToGroup.
 */
const ORG_SCOPED_BANK_QUERIES = Object.freeze({
  dtp: (sqlConnection, itemId, simulationGroupId) => sqlConnection`
    SELECT 1
    FROM dtp_bank b
    JOIN simulation_groups sg ON sg.organization_id = b.organization_id
    WHERE b.dtp_id = ${itemId}
      AND sg.simulation_group_id = ${simulationGroupId};
  `,
  recommendation: (sqlConnection, itemId, simulationGroupId) => sqlConnection`
    SELECT 1
    FROM recommendations_bank b
    JOIN simulation_groups sg ON sg.organization_id = b.organization_id
    WHERE b.recommendation_id = ${itemId}
      AND sg.simulation_group_id = ${simulationGroupId};
  `,
});

/**
 * Verify that every bank item ID belongs to the same organization as the
 * simulation group it is being attached to. Without this, an instructor could
 * attach another organization's DTP/recommendation to their own group and read
 * its text back through the group-scoped GET, which JOINs the bank table.
 *
 * Fail-closed: an unknown kind, a non-string or empty ID, a group or item with
 * no organization (NULL never matches), a missing row, or any database error
 * returns { authorized: false }.
 *
 * @param {object} sqlConnection - postgres tagged template connection
 * @param {"dtp"|"recommendation"} kind - Which bank the IDs come from
 * @param {string[]} itemIds - Bank item primary keys supplied by the caller
 * @param {string} simulationGroupId - The (already authorized) target group
 * @returns {Promise<{authorized: boolean}>}
 */
async function verifyBankItemsInGroupOrganization(sqlConnection, kind, itemIds, simulationGroupId) {
  const check = "verifyBankItemsInGroupOrganization";
  const query = ORG_SCOPED_BANK_QUERIES[kind];
  if (!query || !Array.isArray(itemIds) || itemIds.length === 0) {
    logDenial(check, "invalid_input", { kind, simulationGroupId });
    return { authorized: false };
  }
  if (!itemIds.every((id) => typeof id === "string" && id.length > 0)) {
    logDenial(check, "invalid_input", { kind, simulationGroupId });
    return { authorized: false };
  }
  try {
    for (const itemId of new Set(itemIds)) {
      const rows = await query(sqlConnection, itemId, simulationGroupId);
      if (rows.length === 0) {
        logDenial(check, "not_authorized", { kind, itemId, simulationGroupId });
        return { authorized: false };
      }
    }
    return { authorized: true };
  } catch (error) {
    logDenial(check, "error", { kind, simulationGroupId }, error);
    return { authorized: false };
  }
}

/**
 * Verify that every question bank ID may be attached to the given simulation
 * group. Without this, an instructor could attach another organization's
 * question to their own group and read its text and evaluation criteria back
 * through GET /instructor/simulation_group_questions, which JOINs question_bank.
 *
 * A question is attachable when:
 *   - the group has an organization and the question belongs to that same
 *     organization, or
 *   - the group has no organization (instructor-created groups are inserted
 *     without one) and the caller is an admin or a member of the question's
 *     organization (verifyOrganizationMembership).
 *
 * Fail-closed: a non-array, empty, or non-string ID list, a missing question
 * or group, or any database error returns { authorized: false }.
 *
 * @param {object} sqlConnection - postgres tagged template connection
 * @param {string[]} questionIds - question_bank primary keys supplied by the caller
 * @param {string} simulationGroupId - The (already authorized) target group
 * @param {string} userEmail - The authenticated user's email
 * @param {boolean} callerIsAdmin - Whether the caller holds the admin role
 * @returns {Promise<{authorized: boolean}>}
 */
async function verifyQuestionsAttachableToGroup(
  sqlConnection,
  questionIds,
  simulationGroupId,
  userEmail,
  callerIsAdmin
) {
  const check = "verifyQuestionsAttachableToGroup";
  if (!Array.isArray(questionIds) || questionIds.length === 0) {
    logDenial(check, "invalid_input", { userEmail, simulationGroupId });
    return { authorized: false };
  }
  if (!questionIds.every((id) => typeof id === "string" && id.length > 0)) {
    logDenial(check, "invalid_input", { userEmail, simulationGroupId });
    return { authorized: false };
  }
  const deny = (questionId) => {
    logDenial(check, "not_authorized", { userEmail, questionId, simulationGroupId });
    return { authorized: false };
  };
  try {
    // Organizations already confirmed for an org-less group, so a batch of
    // questions from the same organization costs one membership lookup.
    const memberOrgs = new Set();
    for (const questionId of new Set(questionIds)) {
      const rows = await sqlConnection`
        SELECT q.organization_id AS question_org, sg.organization_id AS group_org
        FROM question_bank q
        CROSS JOIN simulation_groups sg
        WHERE q.question_id = ${questionId}
          AND sg.simulation_group_id = ${simulationGroupId};
      `;
      if (rows.length === 0) return deny(questionId);

      const { question_org: questionOrg, group_org: groupOrg } = rows[0];
      if (!questionOrg) return deny(questionId);

      if (groupOrg) {
        if (groupOrg !== questionOrg) return deny(questionId);
        continue;
      }

      if (callerIsAdmin === true || memberOrgs.has(questionOrg)) continue;
      const membership = await verifyOrganizationMembership(sqlConnection, questionOrg, userEmail);
      if (!membership.authorized) return deny(questionId);
      memberOrgs.add(questionOrg);
    }
    return { authorized: true };
  } catch (error) {
    logDenial(check, "error", { userEmail, simulationGroupId }, error);
    return { authorized: false };
  }
}

/**
 * Check if the authenticated user has the 'admin' role.
 *
 * @param {object} sqlConnection - postgres tagged template connection
 * @param {string} userEmail - The authenticated user's email
 * @returns {Promise<boolean>}
 */
async function isAdmin(sqlConnection, userEmail) {
  try {
    const result = await sqlConnection`
      SELECT roles
      FROM users
      WHERE user_email = ${userEmail};
    `;

    if (result.length > 0 && Array.isArray(result[0].roles)) {
      return result[0].roles.includes("admin");
    }
    return false;
  } catch (error) {
    // A non-admin result is normal and not logged; only the failure is.
    logDenial("isAdmin", "error", { userEmail }, error);
    return false;
  }
}

module.exports = {
  verifySessionOwnership,
  verifyGroupOwnership,
  verifyEnrollment,
  verifyPersonaEnrollment,
  verifySessionScope,
  verifyPersonaOwnership,
  verifyOrganizationMembership,
  resolveParentId,
  verifyBankItemsInGroupOrganization,
  verifyQuestionsAttachableToGroup,
  isAdmin,
};
