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
    this._entries = new Map(); // sessionId -> { socket, nonce, onRelease, timer, deferred }
  }

  /**
   * Register a socket for a session and return the nonce the Lambda must echo.
   * `onRelease` runs exactly once, when this registration is released,
   * superseded by a newer one, or its scheduled release fires.
   */
  register(sessionId, socket, onRelease) {
    const previous = this._entries.get(sessionId);
    if (previous) this._drop(sessionId, previous);
    const nonce = crypto.randomBytes(32).toString("hex");
    // settleMs: delay recorded by settle() once a terminal frame arrived.
    this._entries.set(sessionId, { socket, nonce, onRelease, timer: null, deferred: false, settleMs: null });
    return nonce;
  }

  /**
   * Remove the registration only if it is still the one identified by nonce,
   * so a finished request cannot drop a newer request's registration.
   */
  release(sessionId, nonce) {
    const entry = this._entries.get(sessionId);
    if (entry && entry.nonce === nonce) this._drop(sessionId, entry);
  }

  /**
   * Keep the registration alive after the HTTP call to the Lambda returned
   * early (API Gateway's 29s integration timeout) while the Lambda is still
   * streaming. It is released after `maxMs`, or sooner via settle().
   */
  defer(sessionId, nonce, maxMs) {
    const entry = this._entries.get(sessionId);
    if (!entry || entry.nonce !== nonce) return;
    entry.deferred = true;
    // A terminal frame may already have arrived just before the timeout.
    this._schedule(sessionId, entry, entry.settleMs ?? maxMs);
  }

  /**
   * Record a terminal frame: release `ms` later (time for a trailing frame
   * such as session_complete). For a registration that isn't deferred yet
   * the delay is only remembered, since the request handler releases it.
   */
  settle(sessionId, nonce, ms) {
    const entry = this._entries.get(sessionId);
    if (!entry || entry.nonce !== nonce) return;
    entry.settleMs = ms;
    if (entry.deferred) this._schedule(sessionId, entry, ms);
  }

  _schedule(sessionId, entry, ms) {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => this.release(sessionId, entry.nonce), ms);
    if (typeof entry.timer.unref === "function") entry.timer.unref();
  }

  /** Return the registered socket only when the presented nonce matches. */
  resolve(sessionId, nonce) {
    if (typeof sessionId !== "string" || !isValidNonce(nonce)) return null;
    const entry = this._entries.get(sessionId);
    if (!entry || !safeEqual(entry.nonce, nonce)) return null;
    return entry.socket;
  }

  _drop(sessionId, entry) {
    if (entry.timer) clearTimeout(entry.timer);
    this._entries.delete(sessionId);
    if (typeof entry.onRelease === "function") entry.onRelease();
  }
}

module.exports = { StreamRelayRegistry, safeEqual, isValidNonce };
