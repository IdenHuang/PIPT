"use strict";

/**
 * Session Authorization Module for Socket Server
 *
 * Provides session ownership verification to prevent IDOR attacks.
 * Uses the same ownership chain as the Lambda authz module:
 * chats → student_interactions → enrollments → users.
 *
 * Follows a fail-closed pattern: any error returns { authorized: false }.
 */

const postgres = require("postgres");
const { SecretsManagerClient, GetSecretValueCommand } = require("@aws-sdk/client-secrets-manager");
const logger = require("./logger");

const secretsManager = new SecretsManagerClient({
  region: process.env.AWS_REGION || "ca-central-1",
});

let sqlConnection = null;
// Single-flight guards: ensure only ONE connection build / refresh runs at a
// time even when many sessions hit a stale (rotated) connection concurrently.
// Without these, a rotation triggers a stampede of Secrets Manager reads and
// leaked connection pools.
let connectingPromise = null;
let refreshingPromise = null;

/**
 * Detect a database authentication failure (wrong/rotated password).
 *
 * The app_rw password is rotated by the db_setup Lambda on every run, while
 * this process caches its connection for its whole lifetime. After a rotation
 * the cached password is stale and the DB (or RDS Proxy) rejects it. Postgres
 * reports this as SQLSTATE 28P01 (invalid_password) / 28000; RDS Proxy surfaces
 * it as a message like "The password that was provided for the role X is wrong."
 *
 * @param {any} error
 * @returns {boolean}
 */
function isAuthError(error) {
  if (!error) return false;
  const code = error.code || error.routine;
  if (code === "28P01" || code === "28000") return true;
  const msg = (error.message || "").toLowerCase();
  return msg.includes("password") && (msg.includes("wrong") || msg.includes("authentication failed"));
}

/**
 * Build a fresh postgres connection from the latest secret value.
 * @returns {Promise<object>}
 */
async function createConnection() {
  const secretName = process.env.SM_DB_CREDENTIALS;
  const rdsProxyEndpoint = process.env.RDS_PROXY_ENDPOINT;

  if (!secretName || !rdsProxyEndpoint) {
    throw new Error("SM_DB_CREDENTIALS or RDS_PROXY_ENDPOINT not configured");
  }

  let credentials;
  try {
    const { SecretString } = await secretsManager.send(
      new GetSecretValueCommand({ SecretId: secretName })
    );
    credentials = JSON.parse(SecretString);
  } catch (error) {
    logger.error("Failed to read DB credentials from Secrets Manager", {
      component: "session-auth",
      operation: "createConnection",
      secretName,
      error: error.message,
    });
    throw error;
  }

  const connection = postgres({
    host: rdsProxyEndpoint,
    port: credentials.port,
    username: credentials.username,
    password: credentials.password,
    database: credentials.dbname,
    ssl: { rejectUnauthorized: true },
    max: 5,
    idle_timeout: 60,
  });

  logger.info("Socket server DB connection initialized", {
    component: "session-auth",
    operation: "createConnection",
    username: credentials.username,
    database: credentials.dbname,
  });
  return connection;
}

/**
 * Lazily initialize the database connection using SM_DB_CREDENTIALS and RDS_PROXY_ENDPOINT.
 * Reuses the connection once established.
 * @returns {Promise<object>} postgres tagged template connection
 */
async function getDbConnection() {
  if (sqlConnection) return sqlConnection;
  // Single-flight: concurrent cold-start callers await the same build.
  if (!connectingPromise) {
    connectingPromise = createConnection()
      .then((conn) => {
        sqlConnection = conn;
        return conn;
      })
      .finally(() => {
        connectingPromise = null;
      });
  }
  return connectingPromise;
}

/**
 * Discard the cached connection and rebuild it by re-reading the secret.
 * Used to self-heal after the app_rw password is rotated out from under a
 * long-lived process. The old connection is closed best-effort in the
 * background so we don't block on draining it.
 *
 * Single-flight + stale-guard: if many queries fail auth at once (the usual
 * case right after a rotation), only the first triggers an actual rebuild;
 * the rest either join the in-flight refresh or, if the cached connection was
 * already replaced, return the new one without re-reading the secret.
 *
 * @param {object} [staleConn] - the connection the caller saw fail, used to
 *   detect whether another caller already refreshed.
 * @returns {Promise<object>} a fresh connection
 */
async function refreshDbConnection(staleConn) {
  // Another caller already rebuilt the connection since this one failed — reuse it.
  if (staleConn && sqlConnection && sqlConnection !== staleConn) {
    return sqlConnection;
  }
  // A refresh is already underway — join it instead of starting a second one.
  if (refreshingPromise) return refreshingPromise;

  refreshingPromise = (async () => {
    const stale = sqlConnection;
    sqlConnection = null;
    if (stale) {
      // Fire-and-forget close; a stale-auth pool may never drain cleanly.
      Promise.resolve(stale.end({ timeout: 5 })).catch(() => {});
    }
    logger.warn("Refreshing socket server DB connection (app_rw credential rotation suspected)", {
      component: "session-auth",
      operation: "refreshDbConnection",
    });
    const fresh = await createConnection();
    sqlConnection = fresh;
    logger.info("Socket server DB connection refreshed after credential rotation", {
      component: "session-auth",
      operation: "refreshDbConnection",
    });
    return fresh;
  })().finally(() => {
    refreshingPromise = null;
  });

  return refreshingPromise;
}

/**
 * Run a query and self-heal on a wrong/rotated app_rw password.
 *
 * Executes `queryFn(connection)` against the cached connection. If the DB (or
 * RDS Proxy) rejects it with an authentication error — i.e. the cached app_rw
 * password is stale after a db_setup rotation — the connection is rebuilt from
 * the latest secret and the query is retried exactly once. Any non-auth error,
 * or a second auth failure, is re-thrown to the caller.
 *
 * Use this for every DB query in the socket server so credential rotation is
 * always auto-fixed, not just in one call site.
 *
 * @template T
 * @param {(sql: object) => Promise<T>} queryFn
 * @param {string} [context] - short label for logs (e.g. "ownership check")
 * @returns {Promise<T>}
 */
async function runWithAuthRetry(queryFn, context = "query") {
  const conn = await getDbConnection();
  try {
    return await queryFn(conn);
  } catch (error) {
    if (!isAuthError(error)) throw error;
    // Password likely rotated (db_setup) since this connection was cached.
    // Rebuild from the latest secret and retry once before surfacing the error.
    // Passing `conn` lets refreshDbConnection dedupe concurrent auth failures.
    logger.warn("DB auth failed; app_rw password appears rotated — refreshing credentials and retrying once", {
      component: "session-auth",
      operation: "runWithAuthRetry",
      context,
      errorCode: error.code || error.routine,
      error: error.message,
    });
    const fresh = await refreshDbConnection(conn);
    return await queryFn(fresh);
  }
}

/**
 * Verify that the authenticated user owns the given chat session.
 * Joins chats → student_interactions → enrollments → users to confirm ownership.
 *
 * @param {string} sessionId - The chat_id to verify ownership of
 * @param {string} userEmail - The authenticated user's email
 * @returns {Promise<{authorized: boolean, userId?: string}>}
 */
async function verifySessionOwnership(sessionId, userEmail) {
  const runQuery = (sql) => sql`
    SELECT u.user_id
    FROM chats c
    JOIN student_interactions si ON si.student_interaction_id = c.student_interaction_id
    JOIN enrollments e ON e.enrollment_id = si.enrollment_id
    JOIN users u ON u.user_id = e.user_id
    WHERE c.chat_id = ${sessionId}
      AND u.user_email = ${userEmail};
  `;

  try {
    // runWithAuthRetry auto-heals a rotated app_rw password (refresh + retry once).
    const result = await runWithAuthRetry(runQuery, "ownership check");

    if (result.length > 0) {
      return { authorized: true, userId: result[0].user_id };
    }
    return { authorized: false };
  } catch (error) {
    logger.error("Session ownership verification error", {
      component: "session-auth",
      operation: "verifySessionOwnership",
      sessionId,
      // Flag auth errors that survived the refresh+retry so they're easy to spot.
      authErrorAfterRetry: isAuthError(error),
      errorCode: error.code || error.routine,
      error: error.message,
    });
    return { authorized: false };
  }
}

/**
 * Verify that the authenticated user owns the chat AND that the chat belongs to
 * the given persona and simulation group (mirror of authz.js verifySessionScope).
 * Binding all three IDs stops a caller pairing their own session with another
 * group's persona, whose prompts and context would otherwise be loaded.
 *
 * @param {string} sessionId - The chat_id
 * @param {string} personaId - The persona_id the chat must belong to
 * @param {string} simulationGroupId - The simulation_group_id the chat must belong to
 * @param {string} userEmail - The authenticated user's email
 * @returns {Promise<{authorized: boolean}>}
 */
async function verifySessionScope(sessionId, personaId, simulationGroupId, userEmail) {
  const runQuery = (sql) => sql`
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

  try {
    const result = await runWithAuthRetry(runQuery, "session scope check");
    return { authorized: result.length > 0 };
  } catch (error) {
    logger.error("Session scope verification error", {
      component: "session-auth",
      operation: "verifySessionScope",
      sessionId,
      authErrorAfterRetry: isAuthError(error),
      errorCode: error.code || error.routine,
      error: error.message,
    });
    return { authorized: false };
  }
}

module.exports = {
  verifySessionOwnership,
  verifySessionScope,
  getDbConnection,
  refreshDbConnection,
  runWithAuthRetry,
};
