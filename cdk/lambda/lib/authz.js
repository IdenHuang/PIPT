"use strict";

/**
 * Centralized Authorization Module
 *
 * Provides helper functions to verify resource ownership before allowing access.
 * All functions follow a fail-closed pattern: any database error returns { authorized: false }.
 */

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
    return { authorized: false };
  } catch (error) {
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

    return { authorized: result.length > 0 };
  } catch (error) {
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
    return { authorized: false };
  } catch (error) {
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

    return { authorized: result.length > 0 };
  } catch (error) {
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

    return { authorized: result.length > 0 };
  } catch (error) {
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
        return null;
    }
    return rows.length > 0 && rows[0].parent_id ? rows[0].parent_id : null;
  } catch (error) {
    return null;
  }
}

/**
 * Bank kinds that are tenant-scoped by organization, mapped to the fixed query
 * that returns how many of the given item IDs belong to the group's organization.
 * No table or column names are built from input.
 *
 * The question bank is intentionally absent: it is global by product design
 * (GET /instructor/question_bank lists every organization's questions).
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
  const query = ORG_SCOPED_BANK_QUERIES[kind];
  if (!query || !Array.isArray(itemIds) || itemIds.length === 0) {
    return { authorized: false };
  }
  if (!itemIds.every((id) => typeof id === "string" && id.length > 0)) {
    return { authorized: false };
  }
  try {
    for (const itemId of new Set(itemIds)) {
      const rows = await query(sqlConnection, itemId, simulationGroupId);
      if (rows.length === 0) return { authorized: false };
    }
    return { authorized: true };
  } catch (error) {
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
    return false;
  }
}

module.exports = {
  verifySessionOwnership,
  verifyGroupOwnership,
  verifyEnrollment,
  verifyPersonaOwnership,
  verifyOrganizationMembership,
  resolveParentId,
  verifyBankItemsInGroupOrganization,
  isAdmin,
};
