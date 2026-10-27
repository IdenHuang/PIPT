const fs = require("fs");
const path = require("path");
const { initializeConnection } = require("./libadmin.js");
const { getCorsHeaders } = require("./cors.js");
const logger = require("./logger");
const { CognitoIdentityProviderClient, AdminGetUserCommand } = require("@aws-sdk/client-cognito-identity-provider");
const { S3Client, ListObjectsV2Command, DeleteObjectsCommand } = require("@aws-sdk/client-s3");

let { SM_DB_CREDENTIALS, RDS_PROXY_ENDPOINT, USER_POOL_ID, DATA_INGESTION_BUCKET, EMBEDDING_STORAGE_BUCKET } = process.env;

const s3Client = new S3Client();

const cognitoClient = new CognitoIdentityProviderClient();

const DEFAULT_DEBRIEF_PROMPT = fs.readFileSync(path.join(__dirname, "defaultDebriefPrompt.txt"), "utf8").trim();
const { seedPrompt } = require("./seedPrompt.js");
const DEFAULT_SYSTEM_PROMPT = fs.readFileSync(path.join(__dirname, "defaultSystemPrompt.txt"), "utf8").trim();

// SQL conneciton from global variable at libadmin.js
let sqlConnectionTableCreator = global.sqlConnectionTableCreator;

/**
 * Validates a threshold value for an organization configuration field.
 * @param {*} value - The value to validate
 * @param {string} fieldName - The name of the field (used in error messages)
 * @returns {number|null} - The validated number, or null if value is null/undefined
 * @throws {{status: number, message: string}} - If validation fails
 */
function validateThreshold(value, fieldName) {
  if (value === null || value === undefined) return null;
  const num = Number(value);
  if (isNaN(num) || typeof value === 'boolean') {
    throw { status: 400, message: `${fieldName} must be a number` };
  }
  if (num < 0.0 || num > 1.0) {
    throw { status: 400, message: `${fieldName} must be between 0.0 and 1.0` };
  }
  return num;
}

/**
 * Updates a user's roles and records the change in role_audit_log in one
 * transaction, so a role change never lands without its audit row. Also
 * emits a structured ROLE_CHANGE log line for CloudWatch.
 * @param {object} sql - postgres.js connection
 * @param {{action: string, actor: {userId: string|null, email: string},
 *   targetUserId: string|null, targetEmail: string,
 *   oldRoles: string[], newRoles: string[]}} change
 * @param {(tx: object) => Promise<void>} [extra] - further writes to run in the same transaction
 */
async function applyRoleChange(sql, change, extra) {
  const { action, actor, targetUserId, targetEmail, oldRoles, newRoles } = change;
  await sql.begin(async (tx) => {
    await tx`
      UPDATE "users"
      SET roles = ${newRoles}
      WHERE user_email = ${targetEmail};
    `;
    await tx`
      INSERT INTO "role_audit_log"
        (action, actor_user_id, actor_email, target_user_id, target_email, old_roles, new_roles)
      VALUES
        (${action}, ${actor.userId}, ${actor.email}, ${targetUserId}, ${targetEmail}, ${oldRoles}, ${newRoles});
    `;
    if (extra) await extra(tx);
  });
  logger.info("ROLE_CHANGE", {
    action,
    actorEmail: actor.email,
    targetEmail,
    oldRoles,
    newRoles,
  });
}

exports.handler = async (event, context) => {
  logger.init(event, context);
  // Log parameter names only; values can carry access codes and user data.
  logger.info("Admin handler invoked", {
    queryParamKeys: Object.keys(event.queryStringParameters || {}),
  });

  const response = {
    statusCode: 200,
    headers: getCorsHeaders(event),
    body: "",
  };

  // Initialize the database connection if not already initialized
  if (!sqlConnectionTableCreator) {
    logger.info("Initializing database connection");
    await initializeConnection(SM_DB_CREDENTIALS, RDS_PROXY_ENDPOINT);
    sqlConnectionTableCreator = global.sqlConnectionTableCreator;
    logger.info("Database connection initialized");
  }

  // --- Role-based authorization ---
  // users.roles in the database is the single source of truth for admin
  // access. Token claims (e.g. cognito:groups) are never consulted, so a
  // demotion through lower_admin takes effect on the caller's next request.
  // The first admin is created with the bootstrapAdmin Lambda (see
  // docs/DEPLOYMENT_GUIDE.md), not through Cognito groups.
  const adminEmail = event.requestContext.authorizer.email;
  const roleCheckResult = await sqlConnectionTableCreator`
    SELECT user_id, roles FROM "users" WHERE user_email = ${adminEmail};
  `;
  const userRoles = roleCheckResult[0]?.roles || [];
  const actor = { userId: roleCheckResult[0]?.user_id || null, email: adminEmail };
  if (!userRoles.includes("admin")) {
    logger.warn("AUTHZ_DENY", {
      check: "adminRole",
      reason: "not_authorized",
      adminEmail,
      userRoles,
    });
    return {
      statusCode: 403,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ error: "Forbidden: insufficient role" }),
    };
  }

  try {
    const pathData = event.httpMethod + " " + event.resource;
    switch (pathData) {
      case "GET /admin/instructors":
        {
          // Authentication is handled by the authorizer + role check above.
          // Previously required instructor_email query param; now uses authorizer context.
          // Fall back to query param for backwards compatibility.
          const instructor_email = adminEmail || (event.queryStringParameters && event.queryStringParameters.instructor_email);

          if (!instructor_email) {
            response.statusCode = 400;
            response.body = "instructor_email is required";
            logger.warn("Missing instructor_email parameter");
            break;
          }

          // SQL query to fetch all users who are instructors
          const instructors = await sqlConnectionTableCreator`
                SELECT user_id, user_email, first_name, last_name
                FROM "users"
                WHERE roles @> ARRAY['instructor']::varchar[]
                ORDER BY last_name ASC;
              `;

          response.body = JSON.stringify(instructors);
        }
        break;
      case "GET /admin/users":
        {
          const users = await sqlConnectionTableCreator`
            SELECT user_id, user_email, first_name, last_name, roles
            FROM "users"
            ORDER BY last_name ASC, first_name ASC
          `;
          response.body = JSON.stringify(users);
        }
        break;
      case "GET /admin/simulation_groups":
        try {
          const orgId = event.queryStringParameters?.organization_id || null;
          // Query simulation groups with student, instructor, and persona counts
          // Optionally filtered by organization_id
          const simulationGroups = await sqlConnectionTableCreator`
                    SELECT sg.*,
                      COALESCE(pc.persona_count, 0)::int AS persona_count,
                      COALESCE(sc.student_count, 0)::int AS student_count,
                      COALESCE(ic.instructor_count, 0)::int AS instructor_count
                    FROM "simulation_groups" sg
                    LEFT JOIN (
                      SELECT simulation_group_id, COUNT(*) AS persona_count
                      FROM "personas"
                      GROUP BY simulation_group_id
                    ) pc ON pc.simulation_group_id = sg.simulation_group_id
                    LEFT JOIN (
                      SELECT simulation_group_id, COUNT(*) AS student_count
                      FROM "enrollments"
                      WHERE enrollment_type = 'student'
                      GROUP BY simulation_group_id
                    ) sc ON sc.simulation_group_id = sg.simulation_group_id
                    LEFT JOIN (
                      SELECT simulation_group_id, COUNT(*) AS instructor_count
                      FROM "enrollments"
                      WHERE enrollment_type = 'instructor'
                      GROUP BY simulation_group_id
                    ) ic ON ic.simulation_group_id = sg.simulation_group_id
                    WHERE (${orgId}::uuid IS NULL OR sg.organization_id = ${orgId}::uuid);
                `;

          logger.info("Fetched simulation groups", { count: simulationGroups.length });
          response.body = JSON.stringify(simulationGroups);
        } catch (err) {
          response.statusCode = 500;
          logger.error("Failed to fetch simulation groups", { error: err.message, stack: err.stack });
          response.body = JSON.stringify({ error: "Internal server error" });
        }
        break;
      case "POST /admin/enroll_instructor":
        if (
          event.queryStringParameters != null &&
          event.queryStringParameters.simulation_group_id
        ) {
          try {
            const { simulation_group_id } = event.queryStringParameters;
            const body = event.body ? JSON.parse(event.body) : {};
            const instructor_email = body.instructor_email || event.queryStringParameters.instructor_email;

            if (!instructor_email) {
              response.statusCode = 400;
              response.body = "simulation_group_id and instructor_email are required";
              break;
            }

            // Retrieve user_id from users table based on the instructor email
            const userResult = await sqlConnectionTableCreator`
                  SELECT user_id
                  FROM "users"
                  WHERE user_email = ${instructor_email};
                `;

            const user_id = userResult[0]?.user_id;

            if (!user_id) {
              response.statusCode = 400;
              response.body = JSON.stringify({
                error: "Instructor email not found",
              });
              break;
            }

            // Insert enrollment into enrollments table with current timestamp for the 'instructor' role
            const enrollment = await sqlConnectionTableCreator`
                  INSERT INTO "enrollments" (enrollment_id, simulation_group_id, user_id, enrollment_type, time_enrolled)
                  VALUES (uuid_generate_v4(), ${simulation_group_id}, ${user_id}, 'instructor', CURRENT_TIMESTAMP)
                  ON CONFLICT (simulation_group_id, user_id) 
                  DO UPDATE SET 
                      enrollment_id = EXCLUDED.enrollment_id,
                      enrollment_type = EXCLUDED.enrollment_type,
                      time_enrolled = EXCLUDED.time_enrolled
                  RETURNING enrollment_id;
                `;

            const enrollment_id = enrollment[0]?.enrollment_id;

            if (enrollment_id) {
              // Retrieve all persona IDs associated with the simulation group
              const personasResult = await sqlConnectionTableCreator`
                    SELECT persona_id
                    FROM "personas"
                    WHERE simulation_group_id = ${simulation_group_id};
                  `;

              // Insert a record into student_interactions for each persona in the simulation group
              // ON CONFLICT handles the case where the user was previously enrolled (e.g. as student)
              const studentInteractionInsertions = personasResult.map(
                (persona) => {
                  return sqlConnectionTableCreator`
                      INSERT INTO "student_interactions" (student_interaction_id, persona_id, enrollment_id, persona_score, last_accessed, persona_context_embedding, is_completed)
                      VALUES (uuid_generate_v4(), ${persona.persona_id}, ${enrollment_id}, 0, CURRENT_TIMESTAMP, NULL, FALSE)
                      ON CONFLICT (persona_id, enrollment_id)
                      DO UPDATE SET last_accessed = CURRENT_TIMESTAMP;
                    `;
                }
              );

              // Execute all insertions
              await Promise.all(studentInteractionInsertions);
            }

            response.body = JSON.stringify({
              message: "Instructor enrolled and patients linked successfully.",
            });

            // Optionally insert into User Engagement Log (uncomment if needed)
            // await sqlConnectionTableCreator`
            //   INSERT INTO "user_engagement_log" (log_id, user_id, simulation_group_id, patient_id, enrolment_id, timestamp, engagement_type)
            //   VALUES (uuid_generate_v4(), ${user_id}, ${simulation_group_id}, null, ${enrolment_id}, CURRENT_TIMESTAMP, 'enrollment_created');
            // `;
          } catch (err) {
            response.statusCode = 500;
            logger.error("Operation failed", { error: err.message, stack: err.stack });
            response.body = JSON.stringify({ error: "Internal server error" });
          }
        } else {
          response.statusCode = 400;
          response.body =
            "simulation_group_id and instructor_email are required";
        }
        break;
      case "POST /admin/create_simulation_group":
        if (event.body) {
          try {
            const body = JSON.parse(event.body);
            const {
              group_name,
              group_description,
              group_student_access,
              system_prompt,
              organization_id,
              // admin_voice_enabled,      // uncomment after migration 005 runs
              // instructor_voice_enabled,  // uncomment after migration 005 runs
            } = body;

            if (!group_name || !group_description || group_student_access === undefined) {
              response.statusCode = 400;
              response.body = JSON.stringify({ error: "group_name, group_description, and group_student_access are required" });
              break;
            }

            logger.info("Simulation group creation start", { group_name, group_description });

            // Auto-generate access code server-side (XXXX-XXXX format)
            const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
            let group_access_code = "";
            for (let i = 0; i < 4; i++) group_access_code += chars.charAt(Math.floor(Math.random() * chars.length));
            group_access_code += "-";
            for (let i = 0; i < 4; i++) group_access_code += chars.charAt(Math.floor(Math.random() * chars.length));

            // Insert new simulation group into simulation_groups table
            // TODO: add admin_voice_enabled and instructor_voice_enabled after migration 005 runs
            const newSimulationGroup = await sqlConnectionTableCreator`
                  INSERT INTO "simulation_groups" (
                      simulation_group_id,
                      organization_id,
                      group_name,
                      group_description,
                      group_access_code,
                      group_student_access,
                      system_prompt,
                      debrief_prompt
                  )
                  VALUES (
                      uuid_generate_v4(),
                      ${organization_id || null},
                      ${group_name},
                      ${group_description},
                      ${group_access_code},
                      ${typeof group_student_access === "string" ? group_student_access.toLowerCase() === "true" : !!group_student_access},
                      ${seedPrompt(system_prompt, DEFAULT_SYSTEM_PROMPT)},
                      ${DEFAULT_DEBRIEF_PROMPT}
                  )
                  RETURNING *;
              `;

            response.body = JSON.stringify(newSimulationGroup[0]);
          } catch (err) {
            response.statusCode = 500;
            logger.error("Operation failed", { error: err.message, stack: err.stack });
            response.body = JSON.stringify({ error: "Internal server error" });
          }
        } else {
          response.statusCode = 400;
          response.body = "Missing required parameters";
        }
        break;
      case "GET /admin/groupInstructors":
        if (
          event.queryStringParameters != null &&
          event.queryStringParameters.simulation_group_id
        ) {
          const { simulation_group_id } = event.queryStringParameters;

          // SQL query to fetch all instructors for a given group
          const instructors = await sqlConnectionTableCreator`
              SELECT u.user_email, u.first_name, u.last_name
              FROM "enrollments" e
              JOIN "users" u ON e.user_id = u.user_id
              WHERE e.simulation_group_id = ${simulation_group_id} AND e.enrollment_type = 'instructor';
            `;

          response.body = JSON.stringify(instructors);
        } else {
          response.statusCode = 400;
          response.body = JSON.stringify({
            error: "simulation_group_id is required",
          });
        }
        break;
      case "GET /admin/instructorGroups":
        if (
          event.queryStringParameters != null &&
          (event.queryStringParameters.instructor_id || event.queryStringParameters.instructor_email)
        ) {
          const instructorId = event.queryStringParameters.instructor_id;
          const instructor_email = event.queryStringParameters.instructor_email;

          try {
            let groups;

            if (instructorId) {
              // Use user_id directly — skip email lookup
              groups = await sqlConnectionTableCreator`
                SELECT g.simulation_group_id, g.group_name, g.group_description
                FROM "enrollments" e
                JOIN "simulation_groups" g ON e.simulation_group_id = g.simulation_group_id
                WHERE e.user_id = ${instructorId} AND e.enrollment_type = 'instructor';
              `;
            } else {
              // Fall back to email lookup for backwards compatibility
              groups = await sqlConnectionTableCreator`
                SELECT g.simulation_group_id, g.group_name, g.group_description
                FROM "enrollments" e
                JOIN "simulation_groups" g ON e.simulation_group_id = g.simulation_group_id
                JOIN "users" u ON e.user_id = u.user_id
                WHERE u.user_email = ${instructor_email} AND e.enrollment_type = 'instructor';
              `;
            }

            response.body = JSON.stringify(groups);
          } catch (err) {
            response.statusCode = 500;
            logger.error("Operation failed", { error: err.message, stack: err.stack });
            response.body = JSON.stringify({ error: "Internal server error" });
          }
        } else {
          response.statusCode = 400;
          response.body = JSON.stringify({
            error: "instructor_id (or instructor_email) is required",
          });
        }
        break;
      case "POST /admin/updateGroupAccess":
        if (
          event.queryStringParameters != null &&
          event.queryStringParameters.simulation_group_id &&
          event.queryStringParameters.access
        ) {
          const { simulation_group_id, access } = event.queryStringParameters;
          // const { admin_voice_enabled, instructor_voice_enabled } = event.queryStringParameters; // uncomment after migration 005 runs
          const accessBool = access.toLowerCase() === "true";

          // SQL query to update group access
          // TODO: add admin_voice_enabled and instructor_voice_enabled after migration 005 runs
          await sqlConnectionTableCreator`
                    UPDATE "simulation_groups"
                    SET group_student_access = ${accessBool}
                    WHERE simulation_group_id = ${simulation_group_id};
                  `;

          response.body = JSON.stringify({
            message: "Group settings updated successfully.",
          });
        } else {
          response.statusCode = 400;
          response.body = JSON.stringify({
            error:
              "simulation_group_id and access query parameters are required",
          });
        }
        break;
      case "POST /admin/regenerate_access_code":
        if (
          event.queryStringParameters != null &&
          event.queryStringParameters.simulation_group_id
        ) {
          try {
            const { simulation_group_id } = event.queryStringParameters;

            // Generate a new random access code (8 chars, uppercase alphanumeric)
            const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
            let newCode = "";
            for (let i = 0; i < 4; i++) newCode += chars.charAt(Math.floor(Math.random() * chars.length));
            newCode += "-";
            for (let i = 0; i < 4; i++) newCode += chars.charAt(Math.floor(Math.random() * chars.length));

            const updated = await sqlConnectionTableCreator`
              UPDATE "simulation_groups"
              SET group_access_code = ${newCode}
              WHERE simulation_group_id = ${simulation_group_id}
              RETURNING group_access_code;
            `;

            if (updated.length === 0) {
              response.statusCode = 404;
              response.body = JSON.stringify({ error: "Simulation group not found" });
            } else {
              response.body = JSON.stringify({ access_code: updated[0].group_access_code });
            }
          } catch (err) {
            response.statusCode = 500;
            logger.error("Operation failed", { error: err.message, stack: err.stack });
            response.body = JSON.stringify({ error: "Internal server error" });
          }
        } else {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "simulation_group_id is required" });
        }
        break;
      case "DELETE /admin/delete_instructor_enrolments":
        {
          const body = event.body ? JSON.parse(event.body) : {};
          const instructor_email = body.instructor_email || (event.queryStringParameters && event.queryStringParameters.instructor_email);

          if (!instructor_email) {
            response.statusCode = 400;
            response.body = "instructor_email is required";
            break;
          }

          try {
            // Retrieve the user's ID
            const userResult = await sqlConnectionTableCreator`
                        SELECT user_id 
                        FROM "users"
                        WHERE user_email = ${instructor_email};
                    `;

            const userId = userResult[0]?.user_id;

            if (!userId) {
              response.statusCode = 404;
              response.body = JSON.stringify({ error: "Instructor not found" });
              break;
            }

            // Delete all enrollments for the instructor
            await sqlConnectionTableCreator`
                        DELETE FROM "enrollments"
                        WHERE user_id = ${userId} AND enrollment_type = 'instructor';
                    `;

            response.body = JSON.stringify({
              message: "Instructor enrolments deleted successfully.",
            });
          } catch (err) {
            response.statusCode = 500;
            logger.error("Operation failed", { error: err.message, stack: err.stack });
            response.body = JSON.stringify({ error: "Internal server error" });
          }
        }
        break;
      case "DELETE /admin/delete_group_instructor_enrolments":
        if (
          event.queryStringParameters != null &&
          event.queryStringParameters.simulation_group_id
        ) {
          try {
            const { simulation_group_id } = event.queryStringParameters;

            // Delete all enrollments for the group where enrollment_type is 'instructor'
            await sqlConnectionTableCreator`
                      DELETE FROM "enrollments"
                      WHERE simulation_group_id = ${simulation_group_id} AND enrollment_type = 'instructor';
                  `;

            response.body = JSON.stringify({
              message: "Group instructor enrolments deleted successfully.",
            });
          } catch (err) {
            response.statusCode = 500;
            logger.error("Operation failed", { error: err.message, stack: err.stack });
            response.body = JSON.stringify({ error: "Internal server error" });
          }
        } else {
          response.statusCode = 400;
          response.body = "simulation_group_id query parameter is required";
        }
        break;
      case "DELETE /admin/delete_group":
        if (
          event.queryStringParameters != null &&
          event.queryStringParameters.simulation_group_id
        ) {
          try {
            const { simulation_group_id } = event.queryStringParameters;

            // Clean up S3 objects for the entire simulation group
            if (DATA_INGESTION_BUCKET || EMBEDDING_STORAGE_BUCKET) {
              const bucketsToClean = [
                DATA_INGESTION_BUCKET,
                EMBEDDING_STORAGE_BUCKET,
              ].filter(Boolean);

              for (const bucket of bucketsToClean) {
                try {
                  const prefix = `${simulation_group_id}/`;
                  let continuationToken;
                  let totalDeleted = 0;

                  do {
                    const listParams = {
                      Bucket: bucket,
                      Prefix: prefix,
                      ...(continuationToken && { ContinuationToken: continuationToken }),
                    };

                    const listResponse = await s3Client.send(new ListObjectsV2Command(listParams));

                    if (listResponse.Contents && listResponse.Contents.length > 0) {
                      const objectsToDelete = listResponse.Contents.map((obj) => ({ Key: obj.Key }));

                      await s3Client.send(new DeleteObjectsCommand({
                        Bucket: bucket,
                        Delete: { Objects: objectsToDelete },
                      }));

                      totalDeleted += objectsToDelete.length;
                    }

                    continuationToken = listResponse.IsTruncated
                      ? listResponse.NextContinuationToken
                      : undefined;
                  } while (continuationToken);

                  logger.info("S3 cleanup completed", { bucket, simulation_group_id, totalDeleted });
                } catch (s3Err) {
                  // Log but don't fail the delete — DB cleanup is more critical
                  logger.error("S3 cleanup failed", { error: s3Err.message, bucket, simulation_group_id });
                }
              }
            }

            // Delete the group, related records will be automatically deleted due to cascading
            await sqlConnectionTableCreator`
                      DELETE FROM "simulation_groups"
                      WHERE simulation_group_id = ${simulation_group_id};
                  `;

            response.body = JSON.stringify({
              message: "Group and related records deleted successfully.",
            });
          } catch (err) {
            response.statusCode = 500;
            logger.error("Operation failed", { error: err.message, stack: err.stack });
            response.body = JSON.stringify({ error: "Internal server error" });
          }
        } else {
          response.statusCode = 400;
          response.body = "simulation_group_id query parameter is required";
        }
        break;
      case "POST /admin/elevate_instructor":
        {
          const body = event.body ? JSON.parse(event.body) : {};
          const instructorEmail = body.email || (event.queryStringParameters && event.queryStringParameters.email);

          if (!instructorEmail) {
            response.statusCode = 400;
            response.body = JSON.stringify({ error: "Email is required" });
            break;
          }

          try {
            // Verify the user exists in Cognito (i.e., they signed up through the proper channel)
            try {
              await cognitoClient.send(new AdminGetUserCommand({
                UserPoolId: USER_POOL_ID,
                Username: instructorEmail,
              }));
            } catch (cognitoErr) {
              if (cognitoErr.name === "UserNotFoundException") {
                response.statusCode = 400;
                response.body = JSON.stringify({
                  error: "User has not registered an account. Only registered users can be elevated to instructor.",
                });
                break;
              }
              throw cognitoErr;
            }

            // Check if the user exists in the DB
            const existingUser = await sqlConnectionTableCreator`
                          SELECT * FROM "users"
                          WHERE user_email = ${instructorEmail};
                      `;

            if (existingUser.length > 0) {
              const userRoles = existingUser[0].roles;

              // Check if the role is already 'instructor' or 'admin'
              if (
                userRoles.includes("instructor") ||
                userRoles.includes("admin")
              ) {
                response.statusCode = 200;
                response.body = JSON.stringify({
                  message:
                    "No changes made. User is already an instructor or admin.",
                });
                break;
              }

              // If the role is 'student', elevate to 'instructor'
              if (userRoles.includes("student")) {
                const newRoles = userRoles.map((role) =>
                  role === "student" ? "instructor" : role
                );

                await applyRoleChange(sqlConnectionTableCreator, {
                  action: "elevate_instructor",
                  actor,
                  targetUserId: existingUser[0].user_id,
                  targetEmail: instructorEmail,
                  oldRoles: userRoles,
                  newRoles,
                });

                response.statusCode = 200;
                response.body = JSON.stringify({
                  message: "User role updated to instructor.",
                });
                break;
              }
            } else {
              // User exists in Cognito but not in DB (edge case: post-confirmation trigger may not have fired yet)
              response.statusCode = 400;
              response.body = JSON.stringify({
                error: "User has registered but their account setup is not complete. Please ask them to sign in first.",
              });
            }
          } catch (err) {
            response.statusCode = 500;
            logger.error("Operation failed", { error: err.message, stack: err.stack });
            response.body = JSON.stringify({ error: "Internal server error" });
          }
        }
        break;
      case "POST /admin/lower_instructor":
        {
          const body = event.body ? JSON.parse(event.body) : {};
          const userEmail = body.email || (event.queryStringParameters && event.queryStringParameters.email);

          if (!userEmail) {
            response.statusCode = 400;
            response.body = JSON.stringify({
              error: "email is required",
            });
            break;
          }

          try {
            // Fetch the roles for the user
            const userRoleData = await sqlConnectionTableCreator`
                    SELECT roles, user_id
                    FROM "users"
                    WHERE user_email = ${userEmail};
                  `;

            const userRoles = userRoleData[0]?.roles;
            const userId = userRoleData[0]?.user_id;

            if (!userRoles || !userRoles.includes("instructor")) {
              response.statusCode = 400;
              response.body = JSON.stringify({
                error: "User is not an instructor or doesn't exist",
              });
              break;
            }

            // Replace 'instructor' with 'student'
            const updatedRoles = userRoles
              .filter((role) => role !== "instructor")
              .concat("student");

            // Update the roles, record the change, and delete all instructor
            // enrollments in one transaction.
            await applyRoleChange(sqlConnectionTableCreator, {
              action: "lower_instructor",
              actor,
              targetUserId: userId,
              targetEmail: userEmail,
              oldRoles: userRoles,
              newRoles: updatedRoles,
            }, async (tx) => {
              await tx`
                DELETE FROM "enrollments"
                WHERE user_id = ${userId} AND enrollment_type = 'instructor';
              `;
            });

            response.statusCode = 200;
            response.body = JSON.stringify({
              message: `User role updated to student for ${userEmail} and all instructor enrolments deleted.`,
            });
          } catch (err) {
            logger.error("Operation failed", { error: err.message, stack: err.stack });
            response.statusCode = 500;
            response.body = JSON.stringify({ error: "Internal server error" });
          }
        }
        break;
      case "POST /admin/elevate_admin":
        {
          const body = event.body ? JSON.parse(event.body) : {};
          const targetEmail = body.email || (event.queryStringParameters && event.queryStringParameters.email);

          if (!targetEmail) {
            response.statusCode = 400;
            response.body = JSON.stringify({ error: "Email is required" });
            break;
          }

          try {
            // Check if the user exists in the DB
            const existingUser = await sqlConnectionTableCreator`
              SELECT * FROM "users"
              WHERE user_email = ${targetEmail};
            `;

            if (existingUser.length === 0) {
              response.statusCode = 400;
              response.body = JSON.stringify({
                error: "User does not exist. Only registered users can be elevated to admin.",
              });
              break;
            }

            const userRoles = existingUser[0].roles;

            // Only promote instructors to admin (not students directly)
            if (userRoles.includes("admin")) {
              response.statusCode = 200;
              response.body = JSON.stringify({
                message: "No changes made. User is already an admin.",
              });
              break;
            }

            if (!userRoles.includes("instructor")) {
              response.statusCode = 400;
              response.body = JSON.stringify({
                error: "User must be an instructor before being elevated to admin.",
              });
              break;
            }

            // Replace 'instructor' with 'admin'
            const newRoles = userRoles.map((role) =>
              role === "instructor" ? "admin" : role
            );

            await applyRoleChange(sqlConnectionTableCreator, {
              action: "elevate_admin",
              actor,
              targetUserId: existingUser[0].user_id,
              targetEmail,
              oldRoles: userRoles,
              newRoles,
            });

            response.statusCode = 200;
            response.body = JSON.stringify({
              message: "User role updated to admin.",
            });
          } catch (err) {
            response.statusCode = 500;
            logger.error("Operation failed", { error: err.message, stack: err.stack });
            response.body = JSON.stringify({ error: "Internal server error" });
          }
        }
        break;
      case "POST /admin/lower_admin":
        {
          const body = event.body ? JSON.parse(event.body) : {};
          const targetEmail = body.email || (event.queryStringParameters && event.queryStringParameters.email);

          if (!targetEmail) {
            response.statusCode = 400;
            response.body = JSON.stringify({ error: "Email is required" });
            break;
          }

          // Prevent self-demotion
          if (targetEmail === adminEmail) {
            response.statusCode = 400;
            response.body = JSON.stringify({
              error: "You cannot demote yourself from admin.",
            });
            break;
          }

          try {
            const userRoleData = await sqlConnectionTableCreator`
              SELECT user_id, roles FROM "users"
              WHERE user_email = ${targetEmail};
            `;

            const userRoles = userRoleData[0]?.roles;

            if (!userRoles || !userRoles.includes("admin")) {
              response.statusCode = 400;
              response.body = JSON.stringify({
                error: "User is not an admin or doesn't exist.",
              });
              break;
            }

            // Replace 'admin' with 'instructor'
            const updatedRoles = userRoles.map((role) =>
              role === "admin" ? "instructor" : role
            );

            await applyRoleChange(sqlConnectionTableCreator, {
              action: "lower_admin",
              actor,
              targetUserId: userRoleData[0].user_id,
              targetEmail,
              oldRoles: userRoles,
              newRoles: updatedRoles,
            });

            response.statusCode = 200;
            response.body = JSON.stringify({
              message: `User role updated to instructor for ${targetEmail}.`,
            });
          } catch (err) {
            logger.error("Operation failed", { error: err.message, stack: err.stack });
            response.statusCode = 500;
            response.body = JSON.stringify({ error: "Internal server error" });
          }
        }
        break;
      case "GET /admin/system_prompts":
        try {
          // Get the latest system prompt from history table
          const latestPrompt = await sqlConnectionTableCreator`
            SELECT prompt_content, created_at
            FROM "system_prompt_history"
            ORDER BY created_at DESC
            LIMIT 1;
          `;

          // Get prompt history excluding the latest one
          const promptHistory = await sqlConnectionTableCreator`
            SELECT history_id, prompt_content, created_at
            FROM "system_prompt_history"
            ORDER BY created_at DESC
            OFFSET 1;
          `;

          response.body = JSON.stringify({
            current_prompt: latestPrompt[0]?.prompt_content || "",
            history: promptHistory,
          });
        } catch (err) {
          response.statusCode = 500;
          logger.error("Operation failed", { error: err.message, stack: err.stack });
          response.body = JSON.stringify({ error: "Internal server error" });
        }
        break;
      case "POST /admin/update_system_prompt":
        if (event.body) {
          try {
            const { prompt_content } = JSON.parse(event.body);
            if (!prompt_content || !prompt_content.trim()) {
              response.statusCode = 400;
              response.body = "prompt_content is required";
              break;
            }

            // Insert new prompt into history (created_by removed)
            await sqlConnectionTableCreator`
              INSERT INTO "system_prompt_history" (prompt_content)
              VALUES (${prompt_content});
            `;

            response.body = JSON.stringify({
              message: "System prompt updated successfully",
            });
          } catch (err) {
            response.statusCode = 500;
            logger.error("Operation failed", { error: err.message, stack: err.stack });
            response.body = JSON.stringify({ error: "Internal server error" });
          }
        } else {
          response.statusCode = 400;
          response.body = "prompt_content is required";
        }
        break;
      case "POST /admin/restore_system_prompt":
        try {
          // Prefer query param history_id; fallback to body with prompt_content for backward compatibility
          const historyId =
            event.queryStringParameters &&
            event.queryStringParameters.history_id
              ? event.queryStringParameters.history_id
              : null;

          if (historyId) {
            // Fetch the prompt_content for the given history_id and insert as new active prompt
            const rows = await sqlConnectionTableCreator`
              SELECT prompt_content
              FROM "system_prompt_history"
              WHERE history_id = ${historyId}
              LIMIT 1;
            `;

            const fromHistory = rows[0]?.prompt_content;
            if (!fromHistory) {
              response.statusCode = 404;
              response.body = JSON.stringify({
                error: "History entry not found",
              });
              break;
            }

            await sqlConnectionTableCreator`
              INSERT INTO "system_prompt_history" (prompt_content)
              VALUES (${fromHistory});
            `;

            response.body = JSON.stringify({
              message: "System prompt restored successfully",
            });
            break;
          }

          // Fallback: body-based restore (no created_by)
          if (event.body) {
            const { prompt_content } = JSON.parse(event.body);
            if (!prompt_content || !prompt_content.trim()) {
              response.statusCode = 400;
              response.body = "prompt_content is required";
              break;
            }

            await sqlConnectionTableCreator`
              INSERT INTO "system_prompt_history" (prompt_content)
              VALUES (${prompt_content});
            `;

            response.body = JSON.stringify({
              message: "System prompt restored successfully",
            });
          } else {
            response.statusCode = 400;
            response.body = "history_id or prompt_content is required";
          }
        } catch (err) {
          response.statusCode = 500;
          logger.error("Operation failed", { error: err.message, stack: err.stack });
          response.body = JSON.stringify({ error: "Internal server error" });
        }
        break;
      case "POST /admin/update_user_token_limit":
        if (event.body) {
          try {
            const { user_email, token_limit } = JSON.parse(event.body);
            if (!user_email || !token_limit || token_limit < 1000) {
              response.statusCode = 400;
              response.body =
                "user_email and token_limit (min 1000) are required";
              break;
            }

            await sqlConnectionTableCreator`
              UPDATE "users"
              SET token_limit = ${token_limit}
              WHERE user_email = ${user_email};
            `;

            response.body = JSON.stringify({
              message: "User token limit updated successfully",
            });
          } catch (err) {
            response.statusCode = 500;
            logger.error("Operation failed", { error: err.message, stack: err.stack });
            response.body = JSON.stringify({ error: "Internal server error" });
          }
        } else {
          response.statusCode = 400;
          response.body = "user_email and token_limit are required";
        }
        break;
      case "POST /admin/update_all_token_limits":
        if (event.body) {
          try {
            const { token_limit } = JSON.parse(event.body);
            if (!token_limit || token_limit < 1000) {
              response.statusCode = 400;
              response.body = "token_limit (min 1000) is required";
              break;
            }

            await sqlConnectionTableCreator`
              UPDATE "users"
              SET token_limit = ${token_limit};
            `;

            response.body = JSON.stringify({
              message: "All user token limits updated successfully",
            });
          } catch (err) {
            response.statusCode = 500;
            logger.error("Operation failed", { error: err.message, stack: err.stack });
            response.body = JSON.stringify({ error: "Internal server error" });
          }
        } else {
          response.statusCode = 400;
          response.body = "token_limit is required";
        }
        break;
      case "GET /admin/empathy_prompts":
        try {
          // Get the latest empathy prompt from history table
          const latestPrompt = await sqlConnectionTableCreator`
            SELECT prompt_content, created_at
            FROM "empathy_prompt_history"
            ORDER BY created_at DESC
            LIMIT 1;
          `;

          // Get prompt history excluding the latest one
          const promptHistory = await sqlConnectionTableCreator`
            SELECT history_id, prompt_content, created_at
            FROM "empathy_prompt_history"
            ORDER BY created_at DESC
            OFFSET 1;
          `;

          response.body = JSON.stringify({
            current_prompt: latestPrompt[0]?.prompt_content || "",
            history: promptHistory,
          });
        } catch (err) {
          response.statusCode = 500;
          logger.error("Operation failed", { error: err.message, stack: err.stack });
          response.body = JSON.stringify({ error: "Internal server error" });
        }
        break;
      case "POST /admin/update_empathy_prompt":
        if (event.body) {
          try {
            const { prompt_content } = JSON.parse(event.body);
            if (!prompt_content || !prompt_content.trim()) {
              response.statusCode = 400;
              response.body = "prompt_content is required";
              break;
            }

            // Insert new prompt into history
            await sqlConnectionTableCreator`
              INSERT INTO "empathy_prompt_history" (prompt_content)
              VALUES (${prompt_content});
            `;

            response.body = JSON.stringify({
              message: "Empathy prompt updated successfully",
            });
          } catch (err) {
            response.statusCode = 500;
            logger.error("Operation failed", { error: err.message, stack: err.stack });
            response.body = JSON.stringify({ error: "Internal server error" });
          }
        } else {
          response.statusCode = 400;
          response.body = "prompt_content is required";
        }
        break;
      case "POST /admin/restore_empathy_prompt":
        try {
          const historyId =
            event.queryStringParameters &&
            event.queryStringParameters.history_id
              ? event.queryStringParameters.history_id
              : null;

          if (historyId) {
            // Fetch the prompt_content for the given history_id and insert as new active prompt
            const rows = await sqlConnectionTableCreator`
              SELECT prompt_content
              FROM "empathy_prompt_history"
              WHERE history_id = ${historyId}
              LIMIT 1;
            `;

            const fromHistory = rows[0]?.prompt_content;
            if (!fromHistory) {
              response.statusCode = 404;
              response.body = JSON.stringify({
                error: "History entry not found",
              });
              break;
            }

            await sqlConnectionTableCreator`
              INSERT INTO "empathy_prompt_history" (prompt_content)
              VALUES (${fromHistory});
            `;

            response.body = JSON.stringify({
              message: "Empathy prompt restored successfully",
            });
            break;
          }

          // Fallback: body-based restore
          if (event.body) {
            const { prompt_content } = JSON.parse(event.body);
            if (!prompt_content || !prompt_content.trim()) {
              response.statusCode = 400;
              response.body = "prompt_content is required";
              break;
            }

            await sqlConnectionTableCreator`
              INSERT INTO "empathy_prompt_history" (prompt_content)
              VALUES (${prompt_content});
            `;

            response.body = JSON.stringify({
              message: "Empathy prompt restored successfully",
            });
          } else {
            response.statusCode = 400;
            response.body = "history_id or prompt_content is required";
          }
        } catch (err) {
          response.statusCode = 500;
          logger.error("Operation failed", { error: err.message, stack: err.stack });
          response.body = JSON.stringify({ error: "Internal server error" });
        }
        break;
      // ── Organization CRUD ──────────────────────────────────────────────
      case "GET /admin/organizations":
        try {
          const orgs = await sqlConnectionTableCreator`
            SELECT * FROM "organizations" ORDER BY created_at DESC;
          `;
          response.body = JSON.stringify(orgs);
        } catch (err) {
          response.statusCode = 500;
          logger.error("Operation failed", { error: err.message, stack: err.stack });
          response.body = JSON.stringify({ error: "Internal server error" });
        }
        break;
      case "GET /admin/organization":
        if (
          event.queryStringParameters != null &&
          event.queryStringParameters.organization_id
        ) {
          try {
            const { organization_id } = event.queryStringParameters;
            const org = await sqlConnectionTableCreator`
              SELECT * FROM "organizations"
              WHERE organization_id = ${organization_id};
            `;
            if (org.length === 0) {
              response.statusCode = 404;
              response.body = JSON.stringify({ error: "Organization not found" });
            } else {
              response.body = JSON.stringify(org[0]);
            }
          } catch (err) {
            response.statusCode = 500;
            logger.error("Operation failed", { error: err.message, stack: err.stack });
            response.body = JSON.stringify({ error: "Internal server error" });
          }
        } else {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "organization_id is required" });
        }
        break;
      case "POST /admin/create_organization":
        if (event.body) {
          try {
            const { name, description, type, ai_persona, user_role, icon_color, system_prompt } = JSON.parse(event.body);
            if (!name || !name.trim()) {
              response.statusCode = 400;
              response.body = JSON.stringify({ error: "name is required" });
              break;
            }
            const newOrg = await sqlConnectionTableCreator`
              INSERT INTO "organizations" (name, description, type, ai_persona, user_role, icon_color, system_prompt)
              VALUES (
                ${name},
                ${description || null},
                ${type || null},
                ${ai_persona || 'Patient'},
                ${user_role || 'Student'},
                ${icon_color || '#03045E'},
                ${system_prompt || null}
              )
              RETURNING *;
            `;
            response.statusCode = 201;
            response.body = JSON.stringify(newOrg[0]);
          } catch (err) {
            response.statusCode = 500;
            logger.error("Operation failed", { error: err.message, stack: err.stack });
            response.body = JSON.stringify({ error: "Internal server error" });
          }
        } else {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "Request body is required" });
        }
        break;
      case "PUT /admin/update_organization":
        if (
          event.queryStringParameters != null &&
          event.queryStringParameters.organization_id &&
          event.body
        ) {
          try {
            const { organization_id } = event.queryStringParameters;
            const { name, description, type, ai_persona, user_role, icon_color, system_prompt } = JSON.parse(event.body);

            const updated = await sqlConnectionTableCreator`
              UPDATE "organizations"
              SET
                name = COALESCE(${name || null}, name),
                description = COALESCE(${description || null}, description),
                type = COALESCE(${type || null}, type),
                ai_persona = COALESCE(${ai_persona || null}, ai_persona),
                user_role = COALESCE(${user_role || null}, user_role),
                icon_color = COALESCE(${icon_color || null}, icon_color),
                system_prompt = COALESCE(${system_prompt || null}, system_prompt)
              WHERE organization_id = ${organization_id}
              RETURNING *;
            `;

            if (updated.length === 0) {
              response.statusCode = 404;
              response.body = JSON.stringify({ error: "Organization not found" });
            } else {
              response.body = JSON.stringify(updated[0]);
            }
          } catch (err) {
            response.statusCode = 500;
            logger.error("Operation failed", { error: err.message, stack: err.stack });
            response.body = JSON.stringify({ error: "Internal server error" });
          }
        } else {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "organization_id and request body are required" });
        }
        break;
      case "DELETE /admin/delete_organization":
        if (
          event.queryStringParameters != null &&
          event.queryStringParameters.organization_id
        ) {
          try {
            const { organization_id } = event.queryStringParameters;
            await sqlConnectionTableCreator`
              DELETE FROM "organizations"
              WHERE organization_id = ${organization_id};
            `;
            response.body = JSON.stringify({ message: "Organization deleted successfully." });
          } catch (err) {
            response.statusCode = 500;
            logger.error("Operation failed", { error: err.message, stack: err.stack });
            response.body = JSON.stringify({ error: "Internal server error" });
          }
        } else {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "organization_id is required" });
        }
        break;
      // ── Organization Thresholds ────────────────────────────────────────
      case "GET /admin/organization_thresholds":
        if (
          event.queryStringParameters != null &&
          event.queryStringParameters.organization_id
        ) {
          try {
            const { organization_id } = event.queryStringParameters;
            const org = await sqlConnectionTableCreator`
              SELECT key_question_threshold, dtp_threshold, recommendation_threshold
              FROM "organizations"
              WHERE organization_id = ${organization_id};
            `;
            if (org.length === 0) {
              response.statusCode = 404;
              response.body = JSON.stringify({ error: "Organization not found" });
            } else {
              response.body = JSON.stringify({
                key_question_threshold: org[0].key_question_threshold,
                dtp_threshold: org[0].dtp_threshold,
                recommendation_threshold: org[0].recommendation_threshold,
              });
            }
          } catch (err) {
            response.statusCode = 500;
            logger.error("Failed to fetch organization thresholds", { error: err.message, stack: err.stack });
            response.body = JSON.stringify({ error: "Internal server error" });
          }
        } else {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "organization_id is required" });
        }
        break;
      case "PUT /admin/organization_thresholds":
        if (
          event.queryStringParameters != null &&
          event.queryStringParameters.organization_id
        ) {
          try {
            const { organization_id } = event.queryStringParameters;
            const body = JSON.parse(event.body);

            // Validate each provided field
            const updates = {};
            if ("key_question_threshold" in body) {
              updates.key_question_threshold = validateThreshold(body.key_question_threshold, "key_question_threshold");
            }
            if ("dtp_threshold" in body) {
              updates.dtp_threshold = validateThreshold(body.dtp_threshold, "dtp_threshold");
            }
            if ("recommendation_threshold" in body) {
              updates.recommendation_threshold = validateThreshold(body.recommendation_threshold, "recommendation_threshold");
            }

            // If no valid fields provided, return 400
            const fields = Object.keys(updates);
            if (fields.length === 0) {
              response.statusCode = 400;
              response.body = JSON.stringify({ error: "At least one threshold field must be provided" });
              break;
            }

            // Build dynamic UPDATE query with only provided fields
            const setClauses = fields.map(
              (field) => `${field} = ${updates[field] === null ? "NULL" : updates[field]}`
            );
            const updateResult = await sqlConnectionTableCreator`
              UPDATE "organizations"
              SET ${sqlConnectionTableCreator.unsafe(setClauses.join(", "))}
              WHERE organization_id = ${organization_id}
              RETURNING key_question_threshold, dtp_threshold, recommendation_threshold;
            `;

            if (updateResult.length === 0) {
              response.statusCode = 404;
              response.body = JSON.stringify({ error: "Organization not found" });
            } else {
              response.body = JSON.stringify({
                key_question_threshold: updateResult[0].key_question_threshold,
                dtp_threshold: updateResult[0].dtp_threshold,
                recommendation_threshold: updateResult[0].recommendation_threshold,
              });
            }
          } catch (err) {
            if (err.status && err.message) {
              response.statusCode = err.status;
              response.body = JSON.stringify({ error: err.message });
            } else {
              response.statusCode = 500;
              logger.error("Failed to update organization thresholds", { error: err.message, stack: err.stack });
              response.body = JSON.stringify({ error: "Internal server error" });
            }
          }
        } else {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "organization_id is required" });
        }
        break;
      // ── Question Bank CRUD ─────────────────────────────────────────────
      case "GET /admin/question_bank":
        if (
          event.queryStringParameters != null &&
          event.queryStringParameters.organization_id
        ) {
          try {
            const { organization_id } = event.queryStringParameters;
            const questions = await sqlConnectionTableCreator`
              SELECT * FROM "question_bank"
              WHERE organization_id = ${organization_id}
              ORDER BY created_at DESC;
            `;
            response.body = JSON.stringify(questions);
          } catch (err) {
            response.statusCode = 500;
            logger.error("Failed to fetch question bank", { error: err.message, stack: err.stack });
            response.body = JSON.stringify({ error: "Internal server error" });
          }
        } else {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "organization_id is required" });
        }
        break;
      case "POST /admin/question_bank":
        if (
          event.queryStringParameters != null &&
          event.queryStringParameters.organization_id &&
          event.body
        ) {
          try {
            const { organization_id } = event.queryStringParameters;
            // Resolve created_by: look up user_id from users table using the authenticated email
            const authEmail = event.requestContext?.authorizer?.email;
            if (!authEmail) {
              response.statusCode = 401;
              response.body = JSON.stringify({ error: "Unable to determine user identity" });
              break;
            }
            const userLookup = await sqlConnectionTableCreator`
              SELECT user_id FROM "users" WHERE user_email = ${authEmail} LIMIT 1;
            `;
            if (userLookup.length === 0) {
              response.statusCode = 400;
              response.body = JSON.stringify({ error: "Authenticated user not found in users table" });
              break;
            }
            const created_by = userLookup[0].user_id;
            const { title, question_text, evaluation_criteria, clinical_intent, category, difficulty_level, is_mandatory, weight, max_score, tags } = JSON.parse(event.body);

            if (!title || !question_text || !evaluation_criteria) {
              response.statusCode = 400;
              response.body = JSON.stringify({ error: "title, question_text, and evaluation_criteria are required" });
              break;
            }

            const safeTags = Array.isArray(tags) ? tags : [];

            const newQuestion = await sqlConnectionTableCreator`
              INSERT INTO "question_bank" (
                organization_id, created_by, title, question_text, evaluation_criteria,
                clinical_intent, category, difficulty_level, is_mandatory, weight, max_score, tags
              )
              VALUES (
                ${organization_id}, ${created_by}, ${title}, ${question_text}, ${evaluation_criteria},
                ${clinical_intent || null}, ${category || null}, ${difficulty_level || null},
                ${is_mandatory !== undefined ? is_mandatory : false},
                ${weight !== undefined ? weight : 1.0},
                ${max_score !== undefined ? max_score : 100},
                ${safeTags}
              )
              RETURNING *;
            `;

            response.statusCode = 201;
            response.body = JSON.stringify(newQuestion[0]);
          } catch (err) {
            response.statusCode = 500;
            logger.error("Failed to create question", { error: err.message, stack: err.stack });
            response.body = JSON.stringify({ error: "Internal server error" });
          }
        } else {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "organization_id and request body are required" });
        }
        break;
      case "PUT /admin/question_bank":
        if (
          event.queryStringParameters != null &&
          event.queryStringParameters.question_id &&
          event.queryStringParameters.organization_id &&
          event.body
        ) {
          try {
            // Scope the write to the named organization so a question id alone can
            // never touch another tenant's row (tenant isolation, f-edcbba0e).
            const { question_id, organization_id } = event.queryStringParameters;
            const { title, question_text, evaluation_criteria, clinical_intent, category, difficulty_level, is_mandatory, weight, max_score, tags } = JSON.parse(event.body);

            const updated = await sqlConnectionTableCreator`
              UPDATE "question_bank"
              SET
                title = COALESCE(${title || null}, title),
                question_text = COALESCE(${question_text || null}, question_text),
                evaluation_criteria = COALESCE(${evaluation_criteria || null}, evaluation_criteria),
                clinical_intent = COALESCE(${clinical_intent !== undefined ? clinical_intent : null}, clinical_intent),
                category = COALESCE(${category !== undefined ? category : null}, category),
                difficulty_level = COALESCE(${difficulty_level !== undefined ? difficulty_level : null}, difficulty_level),
                is_mandatory = COALESCE(${is_mandatory !== undefined ? is_mandatory : null}, is_mandatory),
                weight = COALESCE(${weight !== undefined ? weight : null}, weight),
                max_score = COALESCE(${max_score !== undefined ? max_score : null}, max_score),
                tags = COALESCE(${tags !== undefined ? tags : null}, tags)
              WHERE question_id = ${question_id}
                AND organization_id = ${organization_id}
              RETURNING *;
            `;

            if (updated.length === 0) {
              response.statusCode = 404;
              response.body = JSON.stringify({ error: "Question not found" });
            } else {
              response.body = JSON.stringify(updated[0]);
            }
          } catch (err) {
            response.statusCode = 500;
            logger.error("Failed to update question", { error: err.message, stack: err.stack });
            response.body = JSON.stringify({ error: "Internal server error" });
          }
        } else {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "question_id, organization_id, and request body are required" });
        }
        break;
      case "DELETE /admin/question_bank":
        if (
          event.queryStringParameters != null &&
          event.queryStringParameters.question_id &&
          event.queryStringParameters.organization_id
        ) {
          try {
            const { question_id, organization_id } = event.queryStringParameters;

            const updated = await sqlConnectionTableCreator`
              DELETE FROM "question_bank"
              WHERE question_id = ${question_id}
                AND organization_id = ${organization_id}
              RETURNING question_id;
            `;

            if (updated.length === 0) {
              response.statusCode = 404;
              response.body = JSON.stringify({ error: "Question not found" });
            } else {
              response.body = JSON.stringify({ message: "Question deleted successfully." });
            }
          } catch (err) {
            response.statusCode = 500;
            logger.error("Failed to delete question", { error: err.message, stack: err.stack });
            response.body = JSON.stringify({ error: "Internal server error" });
          }
        } else {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "question_id and organization_id are required" });
        }
        break;
      // ── Message Limit ────────────────────────────────────────────────
      case "POST /admin/update_group_message_limit":
        if (
          event.queryStringParameters != null &&
          event.queryStringParameters.simulation_group_id &&
          event.body
        ) {
          try {
            const { simulation_group_id } = event.queryStringParameters;
            let body = JSON.parse(event.body);
            // Handle double-stringified body from API Gateway
            if (typeof body === 'string') {
              body = JSON.parse(body);
            }
            let { max_messages_per_chat } = body;

            // Coerce string numbers to integers (e.g. "4" -> 4)
            if (typeof max_messages_per_chat === 'string') {
              const parsed = parseInt(max_messages_per_chat, 10);
              max_messages_per_chat = isNaN(parsed) ? max_messages_per_chat : parsed;
            }

            // null means unlimited; otherwise must be a positive integer
            if (max_messages_per_chat !== null && (!Number.isInteger(max_messages_per_chat) || max_messages_per_chat < 1)) {
              response.statusCode = 400;
              response.body = JSON.stringify({ error: "max_messages_per_chat must be a positive integer or null" });
              break;
            }

            const updated = await sqlConnectionTableCreator`
              UPDATE "simulation_groups"
              SET max_messages_per_chat = ${max_messages_per_chat}
              WHERE simulation_group_id = ${simulation_group_id}
              RETURNING simulation_group_id, max_messages_per_chat;
            `;

            if (updated.length === 0) {
              response.statusCode = 404;
              response.body = JSON.stringify({ error: "Simulation group not found" });
            } else {
              response.body = JSON.stringify({
                message: "Message limit updated successfully",
                max_messages_per_chat: updated[0].max_messages_per_chat,
              });
            }
          } catch (err) {
            response.statusCode = 500;
            logger.error("Operation failed", { error: err.message, stack: err.stack });
            response.body = JSON.stringify({ error: "Internal server error" });
          }
        } else {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "simulation_group_id and request body are required" });
        }
        break;
      // ── Issue Reports & Debrief Feedback ─────────────────────────────
      case "GET /admin/issue_reports":
        if (
          event.queryStringParameters != null &&
          event.queryStringParameters.simulation_group_id
        ) {
          try {
            const { simulation_group_id } = event.queryStringParameters;

            const reports = await sqlConnectionTableCreator`
              SELECT
                ir.report_id,
                ir.simulation_group_id,
                ir.persona_id,
                ir.chat_id,
                ir.user_id,
                ir.issue_categories,
                ir.details,
                ir.submitted_at,
                u.user_email AS student_email,
                u.first_name AS student_first_name,
                u.last_name AS student_last_name,
                p.persona_name AS patient_name
              FROM "issue_reports" ir
              LEFT JOIN "users" u ON ir.user_id = u.user_id
              LEFT JOIN "personas" p ON ir.persona_id = p.persona_id
              WHERE ir.simulation_group_id = ${simulation_group_id}
              ORDER BY ir.submitted_at DESC;
            `;

            response.body = JSON.stringify(reports);
          } catch (err) {
            response.statusCode = 500;
            logger.error("Failed to fetch issue reports", { error: err.message, stack: err.stack });
            response.body = JSON.stringify({ error: "Internal server error" });
          }
        } else {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "simulation_group_id is required" });
        }
        break;
      case "DELETE /admin/issue_report":
        if (
          event.queryStringParameters != null &&
          event.queryStringParameters.report_id
        ) {
          try {
            const { report_id } = event.queryStringParameters;

            const deleted = await sqlConnectionTableCreator`
              DELETE FROM "issue_reports"
              WHERE report_id = ${report_id}
              RETURNING report_id;
            `;

            if (deleted.length === 0) {
              response.statusCode = 404;
              response.body = JSON.stringify({ error: "Issue report not found" });
            } else {
              response.body = JSON.stringify({ message: "Issue report deleted successfully." });
            }
          } catch (err) {
            response.statusCode = 500;
            logger.error("Failed to delete issue report", { error: err.message, stack: err.stack });
            response.body = JSON.stringify({ error: "Internal server error" });
          }
        } else {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "report_id is required" });
        }
        break;
      case "GET /admin/debrief_feedback":
        if (
          event.queryStringParameters != null &&
          event.queryStringParameters.simulation_group_id
        ) {
          try {
            const { simulation_group_id } = event.queryStringParameters;

            const feedback = await sqlConnectionTableCreator`
              SELECT
                df.feedback_id,
                df.simulation_group_id,
                df.persona_id,
                df.chat_id,
                df.user_id,
                df.is_helpful,
                df.comment,
                df.submitted_at,
                u.user_email AS student_email,
                u.first_name AS student_first_name,
                u.last_name AS student_last_name,
                p.persona_name AS patient_name
              FROM "debrief_feedback" df
              LEFT JOIN "users" u ON df.user_id = u.user_id
              LEFT JOIN "personas" p ON df.persona_id = p.persona_id
              WHERE df.simulation_group_id = ${simulation_group_id}
              ORDER BY df.submitted_at DESC;
            `;

            response.body = JSON.stringify(feedback);
          } catch (err) {
            response.statusCode = 500;
            logger.error("Failed to fetch debrief feedback", { error: err.message, stack: err.stack });
            response.body = JSON.stringify({ error: "Internal server error" });
          }
        } else {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "simulation_group_id is required" });
        }
        break;
      case "DELETE /admin/debrief_feedback":
        if (
          event.queryStringParameters != null &&
          event.queryStringParameters.feedback_id
        ) {
          try {
            const { feedback_id } = event.queryStringParameters;

            const deleted = await sqlConnectionTableCreator`
              DELETE FROM "debrief_feedback"
              WHERE feedback_id = ${feedback_id}
              RETURNING feedback_id;
            `;

            if (deleted.length === 0) {
              response.statusCode = 404;
              response.body = JSON.stringify({ error: "Debrief feedback not found" });
            } else {
              response.body = JSON.stringify({ message: "Debrief feedback deleted successfully." });
            }
          } catch (err) {
            response.statusCode = 500;
            logger.error("Failed to delete debrief feedback", { error: err.message, stack: err.stack });
            response.body = JSON.stringify({ error: "Internal server error" });
          }
        } else {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "feedback_id is required" });
        }
        break;
      // ── DTP Bank CRUD ──────────────────────────────────────────────────
      case "GET /admin/dtp_bank":
        if (
          event.queryStringParameters != null &&
          event.queryStringParameters.organization_id
        ) {
          try {
            const { organization_id } = event.queryStringParameters;
            const dtpItems = await sqlConnectionTableCreator`
              SELECT * FROM "dtp_bank"
              WHERE organization_id = ${organization_id}
              ORDER BY created_at DESC;
            `;
            response.body = JSON.stringify(dtpItems);
          } catch (err) {
            response.statusCode = 500;
            logger.error("Failed to fetch DTP bank", { error: err.message, stack: err.stack });
            response.body = JSON.stringify({ error: "Internal server error" });
          }
        } else {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "organization_id is required" });
        }
        break;
      case "POST /admin/dtp_bank":
        if (
          event.queryStringParameters != null &&
          event.queryStringParameters.organization_id &&
          event.body
        ) {
          try {
            const { organization_id } = event.queryStringParameters;
            // Resolve created_by from authenticated email
            const authEmail = event.requestContext?.authorizer?.email;
            if (!authEmail) {
              response.statusCode = 401;
              response.body = JSON.stringify({ error: "Unable to determine user identity" });
              break;
            }
            const userLookup = await sqlConnectionTableCreator`
              SELECT user_id FROM "users" WHERE user_email = ${authEmail} LIMIT 1;
            `;
            if (userLookup.length === 0) {
              response.statusCode = 400;
              response.body = JSON.stringify({ error: "Authenticated user not found in users table" });
              break;
            }
            const created_by = userLookup[0].user_id;
            const { title, expected_dtp_text, clinical_intent, evaluation_criteria, tags, is_required } = JSON.parse(event.body);

            if (!title || !expected_dtp_text) {
              response.statusCode = 400;
              response.body = JSON.stringify({ error: "title and expected_dtp_text are required" });
              break;
            }

            const safeTags = Array.isArray(tags) ? tags : [];

            const newDtp = await sqlConnectionTableCreator`
              INSERT INTO "dtp_bank" (
                organization_id, created_by, title, expected_dtp_text,
                clinical_intent, evaluation_criteria, tags, is_required
              )
              VALUES (
                ${organization_id}, ${created_by}, ${title}, ${expected_dtp_text},
                ${clinical_intent || null}, ${evaluation_criteria || null},
                ${safeTags}, ${is_required !== undefined ? is_required : false}
              )
              RETURNING *;
            `;

            response.statusCode = 201;
            response.body = JSON.stringify(newDtp[0]);
          } catch (err) {
            response.statusCode = 500;
            logger.error("Failed to create DTP item", { error: err.message, stack: err.stack });
            response.body = JSON.stringify({ error: "Internal server error" });
          }
        } else {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "organization_id and request body are required" });
        }
        break;
      case "PUT /admin/dtp_bank":
        if (
          event.queryStringParameters != null &&
          event.queryStringParameters.dtp_id &&
          event.queryStringParameters.organization_id &&
          event.body
        ) {
          try {
            // Scoped to the named organization (tenant isolation, f-edcbba0e).
            const { dtp_id, organization_id } = event.queryStringParameters;
            const { title, expected_dtp_text, clinical_intent, evaluation_criteria, tags, is_required, is_active } = JSON.parse(event.body);

            const updated = await sqlConnectionTableCreator`
              UPDATE "dtp_bank"
              SET
                title = COALESCE(${title || null}, title),
                expected_dtp_text = COALESCE(${expected_dtp_text || null}, expected_dtp_text),
                clinical_intent = COALESCE(${clinical_intent !== undefined ? clinical_intent : null}, clinical_intent),
                evaluation_criteria = COALESCE(${evaluation_criteria !== undefined ? evaluation_criteria : null}, evaluation_criteria),
                tags = COALESCE(${tags !== undefined ? tags : null}, tags),
                is_required = COALESCE(${is_required !== undefined ? is_required : null}, is_required),
                is_active = COALESCE(${is_active !== undefined ? is_active : null}, is_active)
              WHERE dtp_id = ${dtp_id}
                AND organization_id = ${organization_id}
              RETURNING *;
            `;

            if (updated.length === 0) {
              response.statusCode = 404;
              response.body = JSON.stringify({ error: "DTP item not found" });
            } else {
              response.body = JSON.stringify(updated[0]);
            }
          } catch (err) {
            response.statusCode = 500;
            logger.error("Failed to update DTP item", { error: err.message, stack: err.stack });
            response.body = JSON.stringify({ error: "Internal server error" });
          }
        } else {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "dtp_id, organization_id, and request body are required" });
        }
        break;
      case "DELETE /admin/dtp_bank":
        if (
          event.queryStringParameters != null &&
          event.queryStringParameters.dtp_id &&
          event.queryStringParameters.organization_id
        ) {
          try {
            const { dtp_id, organization_id } = event.queryStringParameters;

            const deleted = await sqlConnectionTableCreator`
              DELETE FROM "dtp_bank"
              WHERE dtp_id = ${dtp_id}
                AND organization_id = ${organization_id}
              RETURNING dtp_id;
            `;

            if (deleted.length === 0) {
              response.statusCode = 404;
              response.body = JSON.stringify({ error: "DTP item not found" });
            } else {
              response.body = JSON.stringify({ message: "DTP item deleted successfully." });
            }
          } catch (err) {
            response.statusCode = 500;
            logger.error("Failed to delete DTP item", { error: err.message, stack: err.stack });
            response.body = JSON.stringify({ error: "Internal server error" });
          }
        } else {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "dtp_id and organization_id are required" });
        }
        break;
      // ── Recommendations Bank CRUD ─────────────────────────────────────────
      case "GET /admin/recommendations_bank":
        if (
          event.queryStringParameters != null &&
          event.queryStringParameters.organization_id
        ) {
          try {
            const { organization_id } = event.queryStringParameters;
            const recItems = await sqlConnectionTableCreator`
              SELECT * FROM "recommendations_bank"
              WHERE organization_id = ${organization_id}
              ORDER BY created_at DESC;
            `;
            response.body = JSON.stringify(recItems);
          } catch (err) {
            response.statusCode = 500;
            logger.error("Failed to fetch recommendations bank", { error: err.message, stack: err.stack });
            response.body = JSON.stringify({ error: "Internal server error" });
          }
        } else {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "organization_id is required" });
        }
        break;
      case "POST /admin/recommendations_bank":
        if (
          event.queryStringParameters != null &&
          event.queryStringParameters.organization_id &&
          event.body
        ) {
          try {
            const { organization_id } = event.queryStringParameters;
            // Resolve created_by from authenticated email
            const authEmail = event.requestContext?.authorizer?.email;
            if (!authEmail) {
              response.statusCode = 401;
              response.body = JSON.stringify({ error: "Unable to determine user identity" });
              break;
            }
            const userLookup = await sqlConnectionTableCreator`
              SELECT user_id FROM "users" WHERE user_email = ${authEmail} LIMIT 1;
            `;
            if (userLookup.length === 0) {
              response.statusCode = 400;
              response.body = JSON.stringify({ error: "Authenticated user not found in users table" });
              break;
            }
            const created_by = userLookup[0].user_id;
            const { title, recommendation_text, evaluation_criteria, rationale } = JSON.parse(event.body);

            if (!title || !recommendation_text) {
              response.statusCode = 400;
              response.body = JSON.stringify({ error: "title and recommendation_text are required" });
              break;
            }

            const safeTags = Array.isArray(JSON.parse(event.body).tags) ? JSON.parse(event.body).tags : [];

            const newRec = await sqlConnectionTableCreator`
              INSERT INTO "recommendations_bank" (
                organization_id, created_by, title, recommendation_text,
                evaluation_criteria, rationale, tags
              )
              VALUES (
                ${organization_id}, ${created_by}, ${title}, ${recommendation_text},
                ${evaluation_criteria || null}, ${rationale || null}, ${safeTags}
              )
              RETURNING *;
            `;

            response.statusCode = 201;
            response.body = JSON.stringify(newRec[0]);
          } catch (err) {
            response.statusCode = 500;
            logger.error("Failed to create recommendation item", { error: err.message, stack: err.stack });
            response.body = JSON.stringify({ error: "Internal server error" });
          }
        } else {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "organization_id and request body are required" });
        }
        break;
      case "PUT /admin/recommendations_bank":
        if (
          event.queryStringParameters != null &&
          event.queryStringParameters.recommendation_id &&
          event.queryStringParameters.organization_id &&
          event.body
        ) {
          try {
            // Scoped to the named organization (tenant isolation, f-edcbba0e).
            const { recommendation_id, organization_id } = event.queryStringParameters;
            const { title, recommendation_text, evaluation_criteria, rationale, tags, is_active } = JSON.parse(event.body);

            const updated = await sqlConnectionTableCreator`
              UPDATE "recommendations_bank"
              SET
                title = COALESCE(${title || null}, title),
                recommendation_text = COALESCE(${recommendation_text || null}, recommendation_text),
                evaluation_criteria = COALESCE(${evaluation_criteria !== undefined ? evaluation_criteria : null}, evaluation_criteria),
                rationale = COALESCE(${rationale !== undefined ? rationale : null}, rationale),
                tags = COALESCE(${tags !== undefined ? tags : null}, tags),
                is_active = COALESCE(${is_active !== undefined ? is_active : null}, is_active)
              WHERE recommendation_id = ${recommendation_id}
                AND organization_id = ${organization_id}
              RETURNING *;
            `;

            if (updated.length === 0) {
              response.statusCode = 404;
              response.body = JSON.stringify({ error: "Recommendation item not found" });
            } else {
              response.body = JSON.stringify(updated[0]);
            }
          } catch (err) {
            response.statusCode = 500;
            logger.error("Failed to update recommendation item", { error: err.message, stack: err.stack });
            response.body = JSON.stringify({ error: "Internal server error" });
          }
        } else {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "recommendation_id, organization_id, and request body are required" });
        }
        break;
      case "DELETE /admin/recommendations_bank":
        if (
          event.queryStringParameters != null &&
          event.queryStringParameters.recommendation_id &&
          event.queryStringParameters.organization_id
        ) {
          try {
            const { recommendation_id, organization_id } = event.queryStringParameters;

            const deleted = await sqlConnectionTableCreator`
              DELETE FROM "recommendations_bank"
              WHERE recommendation_id = ${recommendation_id}
                AND organization_id = ${organization_id}
              RETURNING recommendation_id;
            `;

            if (deleted.length === 0) {
              response.statusCode = 404;
              response.body = JSON.stringify({ error: "Recommendation item not found" });
            } else {
              response.body = JSON.stringify({ message: "Recommendation item deleted successfully." });
            }
          } catch (err) {
            response.statusCode = 500;
            logger.error("Failed to delete recommendation item", { error: err.message, stack: err.stack });
            response.body = JSON.stringify({ error: "Internal server error" });
          }
        } else {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "recommendation_id and organization_id are required" });
        }
        break;
      default:
        throw new Error(`Unsupported route: "${pathData}"`);
    }
  } catch (error) {
    response.statusCode = 400;
    logger.error("Unhandled route error", { error: error.message, stack: error.stack });
    response.body = JSON.stringify(error.message);
  }
  logger.logResponse(response);
  // Role changes also get a ROLE_CHANGE line and a role_audit_log row
  // (applyRoleChange); this records every admin mutation, including failures.
  logger.audit(event, { actorEmail: adminEmail, statusCode: response.statusCode });
  return response;
};