"use strict";

/**
 * AppSync Lambda data source for Subscription.onTextStream.
 *
 * Runs once, when a client subscribes, and decides whether that caller may
 * receive the named session's text stream. The subscription resolver builds the
 * payload from the caller's verified Cognito identity:
 *
 *   { "sessionId": $ctx.args.sessionId, "email": $ctx.identity.claims.email }
 *
 * and calls $util.unauthorized() unless this returns { authorized: true }.
 * The rule mirrors the /student REST routes: admins bypass, everyone else must
 * own the chat (verifySessionOwnership in authz.js).
 *
 * Fail-closed: a malformed payload, a missing row or any error denies.
 *
 * https://docs.aws.amazon.com/appsync/latest/devguide/aws-appsync-real-time-data.html
 */

const { initializeConnection } = require("./lib.js");
const { verifySessionOwnership, isAdmin } = require("./authz.js");
const logger = require("./logger");

const { SM_DB_CREDENTIALS, RDS_PROXY_ENDPOINT } = process.env;

// chats.chat_id is a uuid column; anything else can never match a row.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DENY = Object.freeze({ authorized: false });

async function getSqlConnection() {
  if (!global.sqlConnection) {
    await initializeConnection(SM_DB_CREDENTIALS, RDS_PROXY_ENDPOINT);
  }
  return global.sqlConnection;
}

exports.handler = async (event, context) => {
  logger.init(null, context);

  const sessionId = event?.sessionId;
  const email = event?.email;

  if (typeof sessionId !== "string" || !UUID_RE.test(sessionId)) {
    logger.warn("Text stream subscription denied: invalid sessionId");
    return DENY;
  }
  if (typeof email !== "string" || email.length === 0) {
    logger.warn("Text stream subscription denied: no email claim", { sessionId });
    return DENY;
  }

  try {
    const sqlConnection = await getSqlConnection();

    if (await isAdmin(sqlConnection, email)) {
      return { authorized: true };
    }

    const ownership = await verifySessionOwnership(sqlConnection, sessionId, email);
    if (ownership.authorized === true) {
      return { authorized: true };
    }

    logger.warn("Text stream subscription denied: caller does not own session", { sessionId });
    return DENY;
  } catch (error) {
    logger.error("Text stream subscription authorization failed", {
      sessionId,
      error: error.message,
    });
    return DENY;
  }
};
