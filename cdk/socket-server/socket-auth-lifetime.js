"use strict";

/**
 * Bounds a Socket.IO connection to the lifetime of the credential it was
 * opened with.
 *
 * The handshake verifies a Cognito ID token once. Without this, the socket
 * (and any voice session on it) would keep working after that token expired,
 * after a global sign-out, or after a password reset. The connection is now
 * valid only until the newest verified token's `exp` plus a short grace
 * period. The client extends it by sending a fresh token on the "reauth"
 * event before then; otherwise the server disconnects it.
 */

// Covers clock skew and a reauth that is still in flight when exp passes.
const DEFAULT_GRACE_MS = 30 * 1000;
// setTimeout overflows above 2^31-1 ms (~24.8 days); re-arm in chunks.
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * Epoch milliseconds at which a verified token lapses, or 0 if it has no
 * numeric `exp` (treated as already expired).
 * @param {object} decoded - verified JWT payload
 * @returns {number}
 */
function tokenExpiryMs(decoded) {
  return decoded && typeof decoded.exp === "number" && Number.isFinite(decoded.exp)
    ? decoded.exp * 1000
    : 0;
}

class SocketAuthLifetime {
  /**
   * @param {object} options
   * @param {number} options.expiresAtMs - exp of the handshake token, epoch ms
   * @param {() => void} options.onExpire - called once when the lifetime ends
   * @param {number} [options.graceMs]
   * @param {() => number} [options.now]
   * @param {typeof setTimeout} [options.setTimer]
   * @param {typeof clearTimeout} [options.clearTimer]
   */
  constructor({
    expiresAtMs,
    onExpire,
    graceMs = DEFAULT_GRACE_MS,
    now = Date.now,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  }) {
    this._expiresAt = Number.isFinite(expiresAtMs) ? expiresAtMs : 0;
    this._onExpire = onExpire;
    this._graceMs = graceMs;
    this._now = now;
    this._setTimer = setTimer;
    this._clearTimer = clearTimer;
    this._timer = null;
    this._stopped = false;
    this._schedule();
  }

  /** Epoch ms of the newest verified token's exp. */
  get expiresAt() {
    return this._expiresAt;
  }

  /** Milliseconds until the client's credential expires (may be negative). */
  expiresInMs() {
    return this._expiresAt - this._now();
  }

  /** True once exp plus the grace period has passed. */
  isExpired() {
    return this._stopped || this._now() >= this._expiresAt + this._graceMs;
  }

  /**
   * Extend the lifetime to a newer verified token's exp. An older exp never
   * shortens it. Has no effect after the lifetime ended.
   * @param {number} expiresAtMs
   * @returns {boolean} whether the lifetime is still active
   */
  renew(expiresAtMs) {
    if (this.isExpired()) return false;
    if (Number.isFinite(expiresAtMs) && expiresAtMs > this._expiresAt) {
      this._expiresAt = expiresAtMs;
      this._schedule();
    }
    return true;
  }

  /** Cancel the timer (on disconnect). onExpire will not be called. */
  stop() {
    this._stopped = true;
    this._clearTimer(this._timer);
    this._timer = null;
  }

  _schedule() {
    this._clearTimer(this._timer);
    this._timer = null;
    if (this._stopped) return;
    const delay = Math.max(0, this._expiresAt + this._graceMs - this._now());
    this._timer = this._setTimer(() => {
      this._timer = null;
      if (this._stopped) return;
      if (this._now() >= this._expiresAt + this._graceMs) {
        this._stopped = true;
        this._onExpire();
      } else {
        this._schedule();
      }
    }, Math.min(delay, MAX_TIMER_MS));
    if (this._timer && typeof this._timer.unref === "function") this._timer.unref();
  }
}

module.exports = { SocketAuthLifetime, tokenExpiryMs, DEFAULT_GRACE_MS };
