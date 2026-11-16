/**
 * Assigns an instructor to a simulation group (POST /admin/enroll_instructor).
 *
 * An enrollments row with enrollment_type = 'instructor' is treated as group
 * ownership by verifyGroupOwnership (lib/authz.js), getFilesFunction (answer
 * keys) and text_generation authz (test_debrief / test_system_prompt), so this
 * is a privilege grant and is enforced server-side (finding f-0f827c5e):
 *   - the target's users.roles must include 'instructor' (the SPA filter in
 *     AddInstructorDialog is not a control);
 *   - an existing 'student' enrollment in the group is never promoted;
 *   - the grant is written to role_audit_log in the same transaction.
 *
 * @param {object} sql - postgres.js connection
 * @param {{actor: {userId: string|null, email: string},
 *   simulationGroupId: string, instructorEmail: string}} request
 * @returns {Promise<{statusCode: number, body: object,
 *   audit?: {targetEmail: string, roles: string[]}}>}
 */
async function enrollInstructor(sql, { actor, simulationGroupId, instructorEmail }) {
  return sql.begin(async (tx) => {
    // FOR SHARE blocks a concurrent lower_instructor until this commits.
    const userResult = await tx`
      SELECT user_id, roles
      FROM "users"
      WHERE user_email = ${instructorEmail}
      FOR SHARE;
    `;
    const user = userResult[0];
    if (!user) {
      return { statusCode: 400, body: { error: "Instructor email not found" } };
    }
    const roles = user.roles || [];
    if (!roles.includes("instructor")) {
      return { statusCode: 400, body: { error: "User does not have the instructor role" } };
    }

    // The WHERE on DO UPDATE leaves a 'student' row untouched, so RETURNING is
    // empty for that case. 'preview' rows (only ever created for instructors
    // and admins, see studentFunction.js) are still converted.
    const enrollment = await tx`
      INSERT INTO "enrollments" (enrollment_id, simulation_group_id, user_id, enrollment_type, time_enrolled)
      VALUES (uuid_generate_v4(), ${simulationGroupId}, ${user.user_id}, 'instructor', CURRENT_TIMESTAMP)
      ON CONFLICT (simulation_group_id, user_id)
      DO UPDATE SET
          enrollment_type = EXCLUDED.enrollment_type,
          time_enrolled = EXCLUDED.time_enrolled
      WHERE "enrollments".enrollment_type <> 'student'
      RETURNING enrollment_id;
    `;
    const enrollmentId = enrollment[0]?.enrollment_id;
    if (!enrollmentId) {
      return {
        statusCode: 409,
        body: { error: "User is enrolled as a student in this simulation group" },
      };
    }

    const personas = await tx`
      SELECT persona_id
      FROM "personas"
      WHERE simulation_group_id = ${simulationGroupId};
    `;
    // Sequential: a transaction runs on a single connection.
    for (const persona of personas) {
      await tx`
        INSERT INTO "student_interactions" (student_interaction_id, persona_id, enrollment_id, persona_score, last_accessed, persona_context_embedding, is_completed)
        VALUES (uuid_generate_v4(), ${persona.persona_id}, ${enrollmentId}, 0, CURRENT_TIMESTAMP, NULL, FALSE)
        ON CONFLICT (persona_id, enrollment_id)
        DO UPDATE SET last_accessed = CURRENT_TIMESTAMP;
      `;
    }

    // users.roles is unchanged by this action; old_roles = new_roles records
    // the target's roles at grant time.
    await tx`
      INSERT INTO "role_audit_log"
        (action, actor_user_id, actor_email, target_user_id, target_email, old_roles, new_roles, simulation_group_id)
      VALUES
        ('enroll_instructor', ${actor.userId}, ${actor.email}, ${user.user_id}, ${instructorEmail}, ${roles}, ${roles}, ${simulationGroupId});
    `;

    return {
      statusCode: 200,
      body: { message: "Instructor enrolled and patients linked successfully." },
      audit: { targetEmail: instructorEmail, roles },
    };
  });
}

module.exports = { enrollInstructor };
