// jose v5+ is ESM-only — use dynamic import() and cache the module at cold start.
let joseModule;
let JWKS;

async function initJose() {
  if (!joseModule) {
    joseModule = await import("jose");
    JWKS = joseModule.createRemoteJWKSet(new URL(process.env.AUTH_JWKS_URI));
  }
}

// Route prefixes each authorizer deployment may protect. The deployment's
// ROUTE_PREFIX picks one; anything else fails closed at cold start.
const ROUTE_PREFIXES = ["student", "instructor", "admin"];

/**
 * Asserts the verified payload is a Cognito ID token for a verified email.
 *
 * - token_use must be "id": access tokens carry no email, and the handlers join
 *   every ownership predicate on email. (The audience check already rejects
 *   Cognito access tokens because they have no `aud`; this keeps that true even
 *   if the audience configuration changes.)
 * - email_verified must be true: an unverified email in the token would let a
 *   caller claim another user's identity. The user pool also sets
 *   keepOriginal.email so a pending email change never reaches the token.
 *
 * @param {object} payload - jose-verified JWT payload
 * @returns {string} the verified email
 * @throws {Error} "Unauthorized" when any check fails
 */
function assertIdTokenClaims(payload) {
  if (!payload || payload.token_use !== "id") {
    throw new Error("Unauthorized");
  }
  if (payload.email_verified !== true && payload.email_verified !== "true") {
    throw new Error("Unauthorized");
  }
  if (typeof payload.email !== "string" || payload.email.length === 0) {
    throw new Error("Unauthorized");
  }
  if (typeof payload.sub !== "string" || payload.sub.length === 0) {
    throw new Error("Unauthorized");
  }
  return payload.email;
}

/**
 * Builds the policy resource for this deployment's route prefix:
 * arn:aws:execute-api:<region>:<acct>:<apiId>/<stage>/<METHOD>/<prefix>/*
 *
 * API Gateway caches the policy per token for authorizerResultTtlInSeconds and
 * reuses it for every route on this authorizer, so the resource must cover the
 * whole prefix — but nothing outside it.
 *
 * @param {string} methodArn - event.methodArn
 * @param {string} routePrefix - "student" | "instructor" | "admin"
 * @returns {string}
 */
function buildScopedResource(methodArn, routePrefix) {
  if (!ROUTE_PREFIXES.includes(routePrefix)) {
    throw new Error("Unauthorized");
  }
  const parts = String(methodArn).split("/");
  // parts[0] = arn:aws:execute-api:<region>:<acct>:<apiId>, parts[1] = stage
  if (parts.length < 3 || !parts[0].startsWith("arn:aws:execute-api:") || !parts[1]) {
    throw new Error("Unauthorized");
  }
  return `${parts[0]}/${parts[1]}/*/${routePrefix}/*`;
}

/**
 * Parses REQUIRED_ROLES ("instructor,admin") into a list. Empty means the
 * surface needs authentication only (the student surface).
 * @param {string|undefined} raw
 * @returns {string[]}
 */
function parseRequiredRoles(raw) {
  return String(raw || "")
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean);
}

/**
 * True when the user holds at least one of the required roles, or none are required.
 * @param {string[]} userRoles - users.roles from the database
 * @param {string[]} requiredRoles
 */
function hasRequiredRole(userRoles, requiredRoles) {
  if (requiredRoles.length === 0) return true;
  if (!Array.isArray(userRoles)) return false;
  return requiredRoles.some((role) => userRoles.includes(role));
}

/**
 * Builds an API Gateway authorizer policy.
 *
 * The authorizer authenticates the caller and, for the instructor and admin
 * surfaces, checks the caller's role in the database (users.roles, the single
 * source of truth). Handlers re-check the role on every request, so a demotion
 * takes effect immediately in the handler even while a cached Allow is live.
 *
 * @param {string} principalId - The user's subject identifier
 * @param {"Allow"|"Deny"} effect
 * @param {string} resource - Prefix-scoped API Gateway resource ARN
 * @param {{ userId: string, email: string }} [context]
 * @returns {object} API Gateway Authorizer Response
 */
function buildPolicy(principalId, effect, resource, context) {
  const response = {
    principalId,
    policyDocument: {
      Version: "2012-10-17",
      Statement: [
        {
          Action: "execute-api:Invoke",
          Effect: effect,
          Resource: resource,
        },
      ],
    },
  };
  if (context) response.context = context;
  return response;
}

function buildAllowPolicy(principalId, resource, context) {
  return buildPolicy(principalId, "Allow", resource, context);
}

/**
 * Looks up users.roles for an email. Loaded lazily so the student authorizer,
 * which requires no role, never needs the database or the postgres layer.
 * @param {string} email
 * @returns {Promise<string[]>}
 */
async function lookupRoles(email) {
  const { getSql } = require("./db.js");
  const sql = await getSql(process.env.SM_DB_CREDENTIALS, process.env.RDS_PROXY_ENDPOINT);
  const rows = await sql`SELECT roles FROM "users" WHERE user_email = ${email};`;
  return rows[0]?.roles || [];
}

/**
 * Core decision, with dependencies injected for testing.
 * @param {object} event - API Gateway TOKEN authorizer event
 * @param {{ verify: (token: string) => Promise<object>, getRoles: (email: string) => Promise<string[]>,
 *   routePrefix: string, requiredRoles: string[] }} deps
 */
async function authorize(event, deps) {
  const token = String(event.authorizationToken || "");
  if (!token) throw new Error("Unauthorized");

  const payload = await deps.verify(token);
  const email = assertIdTokenClaims(payload);
  const resource = buildScopedResource(event.methodArn, deps.routePrefix);

  if (deps.requiredRoles.length > 0) {
    const roles = await deps.getRoles(email);
    if (!hasRequiredRole(roles, deps.requiredRoles)) {
      return { decision: "Deny", policy: buildPolicy(payload.sub, "Deny", resource) };
    }
  }

  return {
    decision: "Allow",
    policy: buildAllowPolicy(payload.sub, resource, { userId: payload.sub, email }),
  };
}

exports.handler = async (event, context) => {
  const requestId = context?.awsRequestId || "unknown";

  try {
    // Lazy-init jose (ESM dynamic import, cached after first call)
    await initJose();

    const { decision, policy } = await authorize(event, {
      // Verify signature, issuer, audience and expiry against the pool's JWKS.
      verify: async (token) =>
        (
          await joseModule.jwtVerify(token, JWKS, {
            issuer: process.env.AUTH_ISSUER,
            audience: process.env.AUTH_AUDIENCE,
            algorithms: ["RS256"],
          })
        ).payload,
      getRoles: lookupRoles,
      routePrefix: process.env.ROUTE_PREFIX,
      requiredRoles: parseRequiredRoles(process.env.REQUIRED_ROLES),
    });

    // cognito:groups is deliberately NOT forwarded: roles live only in the
    // database, and no handler may authorize from a token claim.
    console.log(
      JSON.stringify({
        level: decision === "Allow" ? "INFO" : "WARN",
        requestId,
        message: decision === "Allow" ? "Authorization allowed" : "Authorization denied: missing role",
        userId: policy.principalId,
        routePrefix: process.env.ROUTE_PREFIX,
      })
    );

    return policy;
  } catch (error) {
    if (error.message !== "Unauthorized") {
      console.error(
        JSON.stringify({
          level: "ERROR",
          requestId,
          message: "Authentication failed",
          error: error.message,
        })
      );
    }
    // API Gateway wants this *exact* error message, otherwise it returns 500 instead of 401
    throw new Error("Unauthorized");
  }
};

// Exported for unit testing
exports._buildAllowPolicy = buildAllowPolicy;
exports._buildPolicy = buildPolicy;
exports._assertIdTokenClaims = assertIdTokenClaims;
exports._buildScopedResource = buildScopedResource;
exports._parseRequiredRoles = parseRequiredRoles;
exports._hasRequiredRole = hasRequiredRole;
exports._authorize = authorize;
