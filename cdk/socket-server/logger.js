"use strict";

/**
 * Structured logging utility for the socket server (ECS Fargate / Node.js).
 *
 * Emits single-line JSON to stdout/stderr so it lands in CloudWatch Logs and is
 * queryable with CloudWatch Logs Insights (e.g. `fields @timestamp, level, message`).
 * This mirrors the Lambda logger (cdk/lambda/lib/logger.js) but is process-oriented
 * rather than request-oriented.
 *
 * WARN/ERROR are written via console.error so CloudWatch tags severity correctly;
 * INFO/DEBUG go to console.log.
 *
 * Usage:
 *   const logger = require("./logger");
 *   logger.info("DB connection initialized", { component: "session-auth" });
 *   logger.error("Query failed", { error: err.message, stack: err.stack });
 */

const SERVICE = "socket-server";

// Redaction mirrors cdk/lambda/lib/logger.js; keep the key lists in sync.
// Every data object is redacted before
// serialization so tokens, signed URLs and student content never reach
// CloudWatch, even if a call site passes a whole socket payload.
const REDACTED = "[REDACTED]";
const MAX_DEPTH = 8;

// Matched case-insensitively after stripping "-" and "_".
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

function _log(level, message, data = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    service: SERVICE,
    message,
    ...redact(data),
  };
  let line;
  try {
    line = JSON.stringify(entry);
  } catch {
    // Fall back to a safe representation if data contains circular refs.
    line = JSON.stringify({ timestamp: entry.timestamp, level, service: SERVICE, message });
  }
  if (level === "ERROR" || level === "WARN") {
    console.error(line);
  } else {
    console.log(line);
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

module.exports = { info, warn, error, redact };
