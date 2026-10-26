/**
 * Text-stream relay registry for POST /stream-callback.
 *
 * The shared x-callback-token only proves "some holder of the secret is
 * calling". To publish into a session the caller must also present the
 * per-request nonce this server minted when it registered that session's
 * socket and passed to the text-generation Lambda (X-Stream-Nonce header).
 * The nonce never reaches the browser, is single-flight, and is discarded
 * when the request finishes, so a leaked shared secret alone cannot inject
 * frames into another student's session.
 */
const crypto = require("crypto");

// 32 random bytes, hex-encoded. Anything else is rejected before comparison.
const NONCE_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Constant-time string comparison. Returns false for non-strings or
 * length mismatches without leaking where the strings differ.
 */
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function isValidNonce(nonce) {
  return typeof nonce === "string" && NONCE_PATTERN.test(nonce);
}

class StreamRelayRegistry {
  constructor() {
    this._entries = new Map(); // sessionId -> { socket, nonce }
  }

  /** Register a socket for a session and return the nonce the Lambda must echo. */
  register(sessionId, socket) {
    const nonce = crypto.randomBytes(32).toString("hex");
    this._entries.set(sessionId, { socket, nonce });
    return nonce;
  }

  /**
   * Remove the registration only if it is still the one identified by nonce,
   * so a finished request cannot drop a newer request's registration.
   */
  release(sessionId, nonce) {
    const entry = this._entries.get(sessionId);
    if (entry && entry.nonce === nonce) this._entries.delete(sessionId);
  }

  /** Return the registered socket only when the presented nonce matches. */
  resolve(sessionId, nonce) {
    if (typeof sessionId !== "string" || !isValidNonce(nonce)) return null;
    const entry = this._entries.get(sessionId);
    if (!entry || !safeEqual(entry.nonce, nonce)) return null;
    return entry.socket;
  }
}

module.exports = { StreamRelayRegistry, safeEqual, isValidNonce };
