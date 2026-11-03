const { CognitoJwtVerifier } = require('aws-jwt-verify');
const logger = require('./logger');

// Cognito ID-token verification with aws-jwt-verify
// (https://github.com/awslabs/aws-jwt-verify).
//
// Chosen over jsonwebtoken + jwks-rsa for how it fetches signing keys
// (findings f-ac8c49e2, f-e757a3fc):
// - Known keys are cached with no expiry, so a valid token never needs a JWKS
//   download and a flood of forged tokens cannot make valid ones fail.
// - A kid missing from the JWKS triggers at most one download, then a
//   10-second penalty period in which further unknown kids are refused
//   locally. A rotated Cognito key is picked up by the next allowed download.
//   Concurrent downloads are merged into one.
// It checks signature (RS256), exp, iss, aud (clientId) and token_use itself;
// idTokenClaimError below adds the email checks the session guard relies on.

let verifier = null;
function getVerifier() {
  if (!verifier) {
    verifier = CognitoJwtVerifier.create({
      userPoolId: process.env.COGNITO_USER_POOL_ID,
      clientId: process.env.COGNITO_CLIENT_ID,
      tokenUse: 'id',
    });
  }
  return verifier;
}

/**
 * Download the user pool's signing keys ahead of the first connection.
 * Failure is not fatal: the first verification fetches them instead.
 */
async function hydrateVerifier() {
  try {
    await getVerifier().hydrate();
    logger.info("Cognito signing keys loaded", { component: "auth", operation: "hydrate" });
  } catch (err) {
    logger.warn("Could not preload Cognito signing keys", { component: "auth", operation: "hydrate", error: err.message });
  }
}

// Failures where the signing key could not be obtained, so the token itself
// was never judged: JWKS unreachable or invalid, or the penalty period after
// an unknown kid. Everything else (bad signature, expired, wrong audience,
// unknown kid, malformed) is a clear rejection of the token.
const TRANSIENT_KEY_ERRORS = new Set([
  'WaitPeriodNotYetEndedJwkError',
  'FetchError',
  'NonRetryableFetchError',
  'JwksNotAvailableInCacheError',
  'JwksValidationError',
]);

/** Whether a verification failure says nothing about the token itself. */
function isTransientKeyError(err) {
  return !!err && TRANSIENT_KEY_ERRORS.has(err.name);
}

/**
 * Same ID-token claim checks as the API Gateway authorizer: the socket server
 * keys session authorization on the token's email, so it must be a Cognito ID
 * token carrying a verified email.
 * @param {object} decoded
 * @returns {string|null} error message, or null when the claims are acceptable
 */
function idTokenClaimError(decoded) {
  if (!decoded || decoded.token_use !== 'id') return 'token_use must be id';
  if (decoded.email_verified !== true && decoded.email_verified !== 'true') return 'email not verified';
  if (typeof decoded.email !== 'string' || !decoded.email) return 'email claim missing';
  if (typeof decoded.sub !== 'string' || !decoded.sub) return 'sub claim missing';
  return null;
}

/**
 * Verify a Cognito ID token. A rejection carries `transient: true` when the
 * signing key could not be obtained: the token may be valid, so callers must
 * not hold it against the client.
 * @param {string} token
 * @returns {Promise<object>} the verified payload
 */
async function verifyToken(token) {
  let decoded;
  try {
    decoded = await getVerifier().verify(token);
  } catch (err) {
    const failure = err instanceof Error ? err : new Error(String(err));
    if (isTransientKeyError(failure)) {
      failure.transient = true;
      // Penalty-period refusals are expected under a forged-kid flood and
      // cost nothing; logging each one would be the expensive part.
      if (failure.name === 'WaitPeriodNotYetEndedJwkError') throw failure;
    }
    logger.error("Token verification failed", { component: "auth", operation: "verifyToken", error: failure.message });
    throw failure;
  }
  const claimError = idTokenClaimError(decoded);
  if (claimError) {
    logger.error("Token verification failed", { component: "auth", operation: "verifyToken", error: claimError });
    throw new Error(claimError);
  }
  logger.info("Token verified successfully", { component: "auth", operation: "verifyToken", userId: decoded.sub });
  return decoded;
}

module.exports = {
  verifyToken,
  hydrateVerifier,
  idTokenClaimError,
  isTransientKeyError,
  _getVerifier: getVerifier, // tests: preload a JWKS with cacheJwks()
};
