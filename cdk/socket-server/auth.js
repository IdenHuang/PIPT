const jwt = require('jsonwebtoken');
const jwksClient = require('jwks-rsa');
const logger = require('./logger');

// Known signing keys are cached (cache hits never reach the rate limiter), so
// the limit only applies to fetches for a kid that isn't cached, e.g. a forged
// token or a Cognito key rotation. Without it, every forged-kid token, from the
// unauthenticated handshake or from "reauth", made an outbound JWKS request.
const JWKS_REQUESTS_PER_MINUTE = 10;
const client = jwksClient({
  jwksUri: `https://cognito-idp.${process.env.AWS_REGION}.amazonaws.com/${process.env.COGNITO_USER_POOL_ID}/.well-known/jwks.json`,
  cache: true,
  cacheMaxAge: 10 * 60 * 1000,
  rateLimit: true,
  jwksRequestsPerMinute: JWKS_REQUESTS_PER_MINUTE,
});

/**
 * Whether a signing-key lookup failure says nothing about the token itself
 * (JWKS unreachable or rate limited) as opposed to the token's kid not being
 * a Cognito key. jsonwebtoken wraps the callback error, so it is classified
 * here, where the original error is still available.
 */
function isTransientKeyError(err) {
  return !err || err.name !== "SigningKeyNotFoundError";
}

function makeGetKey(onKeyError) {
  return (header, callback) => {
    client.getSigningKey(header.kid, (err, key) => {
      if (err) {
        onKeyError(err);
        logger.error("Failed to get signing key", { component: "auth", operation: "getKey", kid: header.kid, error: err.message });
        return callback(err);
      }
      const signingKey = key.publicKey || key.rsaPublicKey;
      callback(null, signingKey);
    });
  };
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
 * signing key could not be fetched (JWKS unreachable or rate limited): the
 * token may be valid, so callers must not hold it against the client.
 */
function verifyToken(token) {
  return new Promise((resolve, reject) => {
    let keyError = null;
    const getKey = makeGetKey((err) => { keyError = err; });
    jwt.verify(token, getKey, {
      audience: process.env.COGNITO_CLIENT_ID,
      issuer: `https://cognito-idp.${process.env.AWS_REGION}.amazonaws.com/${process.env.COGNITO_USER_POOL_ID}`,
      algorithms: ['RS256']
    }, (err, decoded) => {
      const claimError = err ? null : idTokenClaimError(decoded);
      if (err || claimError) {
        const message = err ? err.message : claimError;
        logger.error("Token verification failed", { component: "auth", operation: "verifyToken", error: message });
        const failure = err || new Error(claimError);
        if (keyError && isTransientKeyError(keyError)) failure.transient = true;
        reject(failure);
      } else {
        logger.info("Token verified successfully", { component: "auth", operation: "verifyToken", userId: decoded.sub });
        resolve(decoded);
      }
    });
  });
}

module.exports = { verifyToken, idTokenClaimError, isTransientKeyError };