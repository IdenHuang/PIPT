/**
 * Structured logging utility for Lambda functions.
 * Outputs JSON logs for easy CloudWatch Insights querying.
 *
 * Every data object passed to info/warn/error is run through `redact()` before
 * it is serialized, so credentials, signed URLs and student content never reach
 * CloudWatch even if a call site passes a whole event or query string. Call
 * sites should still log identifiers only; redaction is a backstop.
 *
 * NOTE: cdk/lambda/adminFunction/logger.js must stay byte-identical to this
 * file (the admin function is bundled from its own directory).
 *
 * Usage:
 *   const logger = require("./logger");
 *   // At handler entry:
 *   logger.init(event, context);
 *   logger.info("Processing request", { route: "GET /admin/instructors" });
 *   logger.error("Query failed", { error: err.message, stack: err.stack });
 */

const REDACTED = "[REDACTED]";
const MAX_DEPTH = 8;

// Keys whose values are replaced wholesale, matched case-insensitively after
// stripping "-" and "_" (so "group_access_code", "groupAccessCode" and
// "Group-Access-Code" all match "groupaccesscode").
const SENSITIVE_KEYS = new Set([
  // Credentials and session material
  "authorization",
  "cookie",
  "setcookie",
  "password",
  "secret",
  "apikey",
  "xapikey",
  "xcallbacktoken",
  "groupaccesscode",
  "accesscode",
  // Signed links (answer keys, documents)
  "url",
  "signedurl",
  "presignedurl",
  // Raw request material and student/clinical content
  "headers",
  "multivalueheaders",
  "body",
  "messagecontent",
]);

function isSensitiveKey(key) {
  const normalized = String(key).toLowerCase().replace(/[-_]/g, "");
  // Any *token key: token, idToken, access_token, refreshToken, x-callback-token...
  return SENSITIVE_KEYS.has(normalized) || normalized.endsWith("token");
}

/**
 * Returns a deep copy of `value` with sensitive keys replaced by "[REDACTED]".
 * Handles arrays, Error objects and circular references; never mutates input.
 */
function redact(value, depth = 0, seen = new WeakSet()) {
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return "[Truncated]";
  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redact(item, depth + 1, seen));
  }
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }

  const out = {};
  for (const [key, val] of Object.entries(value)) {
    out[key] = isSensitiveKey(key) ? REDACTED : redact(val, depth + 1, seen);
  }
  return out;
}

let _requestId = null;
let _route = null;

function init(event, context) {
  _requestId = context?.awsRequestId || event?.requestContext?.requestId || "unknown";
  _route = event ? `${event.httpMethod} ${event.resource}` : "unknown";
}

function _log(level, message, data = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    requestId: _requestId,
    route: _route,
    message,
    ...redact(data),
  };
  // Use console.error for WARN/ERROR so CloudWatch marks severity correctly
  if (level === "ERROR" || level === "WARN") {
    console.error(JSON.stringify(entry));
  } else {
    console.log(JSON.stringify(entry));
  }
}

function info(message, data) {
  _log("INFO", message, data);
}

function warn(message, data) {
  _log("WARN", message, data);
}

function error(message, data) {
  _log("ERROR", message, data);
}

function logResponse(response) {
  _log("INFO", "Lambda response", {
    statusCode: response.statusCode,
    bodyLength: response.body ? response.body.length : 0,
  });
}

module.exports = { init, info, warn, error, logResponse, redact };
