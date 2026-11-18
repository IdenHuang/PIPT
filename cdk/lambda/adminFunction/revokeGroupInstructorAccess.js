/**
 * Removes every group-instructor grant a user holds. Called inside the
 * POST /admin/lower_instructor transaction (finding f-1494f973).
 *
 * A user counts as a group's instructor if any of these hold (see
 * verifyGroupOwnership in lib/authz.js, getFilesFunction, getProfilePictures
 * and text_generation helpers/authz.py):
 *   - simulation_groups.created_by is the user;
 *   - a group_instructors row exists for the user;
 *   - an enrollments row with enrollment_type = 'instructor' exists.
 * The /student/* routes do not check users.roles, so all three must be
 * cleared or a demoted user keeps answer-key access and instructor LLM modes.
 *
 * created_by is reassigned to the acting admin rather than set to NULL, so
 * every group keeps an owner. Each reassigned group gets its own
 * 'lower_instructor' role_audit_log row with simulation_group_id set; the
 * main demotion row (written by applyRoleChange) has simulation_group_id NULL.
 *
 * @param {object} tx - postgres.js transaction
 * @param {{actor: {userId: string|null, email: string},
 *   targetUserId: string, targetEmail: string,
 *   oldRoles: string[], newRoles: string[]}} change
 * @returns {Promise<{reassignedGroupIds: string[]}>}
 */
async function revokeGroupInstructorAccess(tx, change) {
  const { actor, targetUserId, targetEmail, oldRoles, newRoles } = change;

  await tx`
    DELETE FROM "enrollments"
    WHERE user_id = ${targetUserId} AND enrollment_type = 'instructor';
  `;

  await tx`
    DELETE FROM "group_instructors"
    WHERE user_id = ${targetUserId};
  `;

  const reassigned = await tx`
    UPDATE "simulation_groups"
    SET created_by = ${actor.userId}
    WHERE created_by = ${targetUserId}
    RETURNING simulation_group_id;
  `;
  const reassignedGroupIds = reassigned.map((row) => row.simulation_group_id);

  // Sequential: a transaction runs on a single connection.
  for (const groupId of reassignedGroupIds) {
    await tx`
      INSERT INTO "role_audit_log"
        (action, actor_user_id, actor_email, target_user_id, target_email, old_roles, new_roles, simulation_group_id)
      VALUES
        ('lower_instructor', ${actor.userId}, ${actor.email}, ${targetUserId}, ${targetEmail}, ${oldRoles}, ${newRoles}, ${groupId});
    `;
  }

  return { reassignedGroupIds };
}

module.exports = { revokeGroupInstructorAccess };
