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

function verifyToken(token) {
  return new Promise((resolve, reject) => {
    jwt.verify(token, getKey, {
      audience: process.env.COGNITO_CLIENT_ID,
      issuer: `https://cognito-idp.${process.env.AWS_REGION}.amazonaws.com/${process.env.COGNITO_USER_POOL_ID}`,
      algorithms: ['RS256']
    }, (err, decoded) => {
      if (err) {
        logger.error("Token verification failed", { component: "auth", operation: "verifyToken", error: err.message });
        reject(err);
      } else {
        logger.info("Token verified successfully", { component: "auth", operation: "verifyToken", userId: decoded.sub });
        resolve(decoded);
      }
    });
  });
}

module.exports = { verifyToken };