// jose v5+ is ESM-only — use dynamic import() and cache the module at cold start.
let joseModule;
let JWKS;

async function initJose() {
  if (!joseModule) {
    joseModule = await import("jose");
    JWKS = joseModule.createRemoteJWKSet(new URL(process.env.AUTH_JWKS_URI));
  }
}

/**
 * Builds an API Gateway authorizer Allow policy with context.
 *
 * This authorizer is a pure AUTHENTICATION gate — it validates the JWT signature,
 * issuer, audience, and expiry. It does NOT perform role-based authorization.
 *
 * Role-based authorization is enforced in each Lambda handler by checking the
 * user's roles column in the database (the single source of truth for roles).
 *
 * @param {string} principalId - The user's subject identifier
 * @param {string} resource - The API Gateway resource ARN (wildcarded)
 * @param {{ userId: string, email: string }} context
 * @returns {object} API Gateway Authorizer Response
 */
function buildAllowPolicy(principalId, resource, context) {
  return {
    principalId,
    policyDocument: {
      Version: "2012-10-17",
      Statement: [
        {
          Action: "execute-api:Invoke",
          Effect: "Allow",
          Resource: resource,
        },
      ],
    },
    context,
  };
}

exports.handler = async (event, context) => {
  const requestId = context?.awsRequestId || "unknown";

  try {
    // Lazy-init jose (ESM dynamic import, cached after first call)
    await initJose();

    const token = event.authorizationToken.toString();

    // Verify the JWT against the JWKS endpoint with issuer and audience checks.
    // This confirms the user is authenticated (valid, non-expired token from our Cognito pool).
    const { payload } = await joseModule.jwtVerify(token, JWKS, {
      issuer: process.env.AUTH_ISSUER,
      audience: process.env.AUTH_AUDIENCE,
    });

    // Build the wildcarded resource ARN for the policy
    const parts = event.methodArn.split("/");
    const resource = parts.slice(0, 2).join("/") + "/*";

    const email = payload.email || payload.sub;

    // cognito:groups is deliberately NOT forwarded: roles live only in the
    // database, and no handler may authorize from a token claim.

    console.log(
      JSON.stringify({
        level: "INFO",
        requestId,
        message: "Authentication successful",
        userId: payload.sub,
      })
    );

    return buildAllowPolicy(payload.sub, resource, {
      userId: payload.sub,
      email,
    });
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
