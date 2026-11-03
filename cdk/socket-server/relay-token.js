const { tokenExpiryMs } = require("./socket-auth-lifetime");

/**
 * Verifies a client-supplied ID token and binds it to the socket's identity.
 *
 * Used for every token a client sends after the handshake: the per-request
 * token on text-generation and start-nova-sonic (forwarded upstream), and the
 * "reauth" event that extends the socket's lifetime. The token is verified the
 * same way as the handshake token, and it must belong to the same user the
 * socket authenticated as. Otherwise the session guard would authorize as one
 * user while the API call ran as another.
 *
 * @param {unknown} token - client-supplied token
 * @param {{ userId: string, userEmail: string }} socketIdentity - from the verified handshake
 * @param {(token: string) => Promise<object>} verify - auth.verifyToken
 * @returns {Promise<{ ok: true, token: string, expiresAt: number } | { ok: false, error: string, transient?: true }>}
 *   expiresAt is the token's exp in epoch milliseconds. transient is set when
 *   the token could not be checked (JWKS unreachable or rate limited).
 */
async function resolveRelayToken(token, socketIdentity, verify) {
  if (typeof token !== "string" || token.length === 0) {
    return { ok: false, error: "Authentication token required" };
  }
  if (!socketIdentity || !socketIdentity.userId) {
    return { ok: false, error: "Authentication failed" };
  }
  let decoded;
  try {
    decoded = await verify(token);
  } catch (err) {
    // transient: the signing key couldn't be fetched, so the token itself
    // was not judged (see auth.verifyToken).
    return err && err.transient
      ? { ok: false, error: "Authentication failed", transient: true }
      : { ok: false, error: "Authentication failed" };
  }
  if (
    !decoded ||
    decoded.sub !== socketIdentity.userId ||
    decoded.email !== socketIdentity.userEmail
  ) {
    return { ok: false, error: "Authentication failed" };
  }
  return { ok: true, token, expiresAt: tokenExpiryMs(decoded) };
}

module.exports = { resolveRelayToken };
