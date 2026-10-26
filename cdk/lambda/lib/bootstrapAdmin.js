/**
 * One-off bootstrap of the FIRST admin on a fresh deployment.
 *
 * Not exposed through API Gateway: an operator with lambda:InvokeFunction on
 * this function runs it directly, e.g.
 *
 *   aws lambda invoke --function-name <StackPrefix>-Api-bootstrapAdmin \
 *     --cli-binary-format raw-in-base64-out \
 *     --payload '{"email":"admin@example.com"}' out.json
 *
 * It refuses to run once any user holds the admin role, so it can't be used to
 * mint additional admins; after bootstrap, admins are managed in-app through
 * the audited /admin/elevate_admin and /admin/lower_admin endpoints. Every
 * promotion is written to role_audit_log in the same transaction as the role
 * change. Replaces the former Cognito 'admin' group bootstrap (f-c6bc8cfe).
 */
const { initializeConnection } = require("./lib.js");
const logger = require("./logger");

const { SM_DB_CREDENTIALS, RDS_PROXY_ENDPOINT } = process.env;
let sqlConnection = global.sqlConnection;

// Arbitrary constant key that serializes concurrent bootstrap invocations.
const BOOTSTRAP_LOCK_KEY = 72846301;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

exports.handler = async (event, context) => {
  logger.init(event, context);

  const email = typeof event?.email === "string" ? event.email.trim() : "";
  if (!EMAIL_RE.test(email)) {
    return { ok: false, error: "A valid 'email' is required in the payload." };
  }

  if (!sqlConnection) {
    await initializeConnection(SM_DB_CREDENTIALS, RDS_PROXY_ENDPOINT);
    sqlConnection = global.sqlConnection;
  }

  try {
    const result = await sqlConnection.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(${BOOTSTRAP_LOCK_KEY})`;

      const existingAdmins = await tx`
        SELECT 1 FROM "users" WHERE roles @> ARRAY['admin']::varchar[] LIMIT 1;
      `;
      if (existingAdmins.length > 0) {
        return {
          ok: false,
          error: "An admin already exists. Manage further admins in the app (Admin > Users).",
        };
      }

      const target = await tx`
        SELECT user_id, roles FROM "users" WHERE user_email = ${email};
      `;
      if (target.length === 0) {
        return {
          ok: false,
          error: "User not found. Sign up and log in through the app once, then retry.",
        };
      }

      const oldRoles = target[0].roles || [];
      const newRoles = [
        ...oldRoles.filter((r) => r !== "student" && r !== "instructor" && r !== "admin"),
        "admin",
      ];

      await tx`
        UPDATE "users" SET roles = ${newRoles} WHERE user_id = ${target[0].user_id};
      `;
      await tx`
        INSERT INTO "role_audit_log"
          (action, actor_user_id, actor_email, target_user_id, target_email, old_roles, new_roles)
        VALUES
          ('bootstrap_admin', NULL, 'bootstrap-admin-lambda', ${target[0].user_id}, ${email}, ${oldRoles}, ${newRoles});
      `;

      return { ok: true, oldRoles, newRoles };
    });

    if (result.ok) {
      logger.info("ROLE_CHANGE", {
        action: "bootstrap_admin",
        actorEmail: "bootstrap-admin-lambda",
        targetEmail: email,
        oldRoles: result.oldRoles,
        newRoles: result.newRoles,
      });
      return { ok: true, message: `${email} is now an admin.` };
    }

    logger.warn("Bootstrap admin refused", { email, reason: result.error });
    return result;
  } catch (err) {
    logger.error("Bootstrap admin failed", { error: err.message, stack: err.stack });
    return { ok: false, error: "Internal error; see the function's CloudWatch logs." };
  }
};
