/**
 * Upstream credential for the text-generation relay.
 *
 * The client sends a fresh ID token with each request (data.token) because the
 * handshake token can expire on a long-lived socket. That token must not be
 * forwarded as-is: it is verified the same way as the handshake token, and it
 * must belong to the same user the socket authenticated as. Otherwise the
 * session guard would authorize as one user while the API call ran as another.
 *
 * @param {unknown} token - client-supplied token (data.token)
 * @param {{ userId: string, userEmail: string }} socketIdentity - from the verified handshake
 * @param {(token: string) => Promise<object>} verify - auth.verifyToken
 * @returns {Promise<{ ok: true, token: string } | { ok: false, error: string }>}
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
  } catch {
    return { ok: false, error: "Authentication failed" };
  }
  if (
    !decoded ||
    decoded.sub !== socketIdentity.userId ||
    decoded.email !== socketIdentity.userEmail
  ) {
    return { ok: false, error: "Authentication failed" };
  }
  return { ok: true, token };
}

module.exports = { resolveRelayToken };
