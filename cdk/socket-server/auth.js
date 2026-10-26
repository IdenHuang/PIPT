const jwt = require('jsonwebtoken');
const jwksClient = require('jwks-rsa');
const logger = require('./logger');

const client = jwksClient({
  jwksUri: `https://cognito-idp.${process.env.AWS_REGION}.amazonaws.com/${process.env.COGNITO_USER_POOL_ID}/.well-known/jwks.json`
});

function getKey(header, callback) {
  client.getSigningKey(header.kid, (err, key) => {
    if (err) {
      logger.error("Failed to get signing key", { component: "auth", operation: "getKey", kid: header.kid, error: err.message });
      return callback(err);
    }
    const signingKey = key.publicKey || key.rsaPublicKey;
    callback(null, signingKey);
  });
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

function verifyToken(token) {
  return new Promise((resolve, reject) => {
    jwt.verify(token, getKey, {
      audience: process.env.COGNITO_CLIENT_ID,
      issuer: `https://cognito-idp.${process.env.AWS_REGION}.amazonaws.com/${process.env.COGNITO_USER_POOL_ID}`,
      algorithms: ['RS256']
    }, (err, decoded) => {
      const claimError = err ? null : idTokenClaimError(decoded);
      if (err || claimError) {
        const message = err ? err.message : claimError;
        logger.error("Token verification failed", { component: "auth", operation: "verifyToken", error: message });
        reject(err || new Error(claimError));
      } else {
        logger.info("Token verified successfully", { component: "auth", operation: "verifyToken", userId: decoded.sub });
        resolve(decoded);
      }
    });
  });
}

module.exports = { verifyToken, idTokenClaimError };