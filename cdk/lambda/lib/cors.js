/**
 * CORS origin helper.
 *
 * Reads ALLOWED_ORIGINS from environment (comma-separated list, supports
 * wildcard subdomains like "https://*.amplifyapp.com").
 *
 * Returns the matching origin to echo back in the Access-Control-Allow-Origin
 * header, or falls back to the first allowed origin if none match.
 * If ALLOWED_ORIGINS is unset or empty, fails closed (returns ""); only an
 * explicit "*" entry allows every origin.
 *
 * Keep every copy in sync: cdk/lambda/lib/cors.js, cdk/lambda/adminFunction/cors.js
 * (byte-identical), cdk/layers/cors/python/cors_helper.py,
 * cdk/text_generation/src/main.py and cdk/socket-server/server.js.
 */

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);

// "*" matches one or more DNS labels (letters, digits, hyphens joined by dots),
// so it can never span a scheme, port, userinfo or path delimiter (":", "@", "/").
const WILDCARD_HOST_LABELS = "[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)*";

const ORIGIN_PATTERNS = ALLOWED_ORIGINS.filter((p) => p !== "*").map((pattern) => {
  // Escape regex special chars except *, then expand * to the label matcher
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, WILDCARD_HOST_LABELS);
  return new RegExp("^" + escaped + "$");
});

/**
 * @param {object} event — API Gateway Lambda proxy event
 * @returns {string} The origin to set in Access-Control-Allow-Origin
 */
function getCorsOrigin(event) {
  if (ALLOWED_ORIGINS.length === 0) {
    // Misconfigured: fail closed. Browsers reject an empty Access-Control-Allow-Origin.
    return "";
  }
  if (ALLOWED_ORIGINS.includes("*")) {
    return "*";
  }

  const origin = (event.headers && (event.headers.origin || event.headers.Origin)) || "";

  if (!origin) {
    // No Origin header (e.g., same-origin request, server-to-server) — return primary domain
    return ALLOWED_ORIGINS[0];
  }

  const isAllowed = ORIGIN_PATTERNS.some((re) => re.test(origin));
  return isAllowed ? origin : ALLOWED_ORIGINS[0];
}

/**
 * Build standard CORS headers for a response.
 * @param {object} event — API Gateway Lambda proxy event
 * @returns {object} Headers object with CORS fields
 */
function getCorsHeaders(event) {
  return {
    "Access-Control-Allow-Headers": "Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token",
    "Access-Control-Allow-Origin": getCorsOrigin(event),
    "Access-Control-Allow-Methods": "*",
  };
}

module.exports = { getCorsOrigin, getCorsHeaders };
