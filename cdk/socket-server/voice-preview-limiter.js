"use strict";

/**
 * Per-identity limits for the voice-preview socket event and for socket
 * connections.
 *
 * Each voice preview spawns a Python/Bedrock TTS child process that can live
 * for up to 90 s on a single Fargate task. Limits are keyed on the
 * authenticated identity (Cognito `sub`) rather than the per-connection
 * socket.id, so reconnecting or opening parallel connections does not grant a
 * fresh budget. State survives disconnects and is aged out by prune().
 *
 * Kept free of socket.io/AWS dependencies so it can be unit tested.
 */

/**
 * Stable limiter key for a socket: the verified user id, falling back to the
 * client IP (first X-Forwarded-For hop, as the task sits behind a load
 * balancer) only if no identity is present.
 * @param {{userId?: string, handshake?: {headers?: object, address?: string}}} socket
 * @returns {string}
 */
function limiterKey(socket) {
  if (socket && typeof socket.userId === "string" && socket.userId !== "") {
    return `user:${socket.userId}`;
  }
  const handshake = (socket && socket.handshake) || {};
  const forwarded = handshake.headers && handshake.headers["x-forwarded-for"];
  const ip = typeof forwarded === "string" && forwarded.trim() !== ""
    ? forwarded.split(",")[0].trim()
    : handshake.address || "unknown";
  return `ip:${ip}`;
}

/** Returns a function that runs `fn` at most once. */
function once(fn) {
  let called = false;
  return () => {
    if (called) return;
    called = true;
    fn();
  };
}

class VoicePreviewLimiter {
  /**
   * @param {object} opts
   * @param {number} opts.maxPerWindow - previews started per identity per window
   * @param {number} opts.windowMs - sliding window length
   * @param {number} opts.maxConcurrentPerUser - running TTS processes per identity
   * @param {number} opts.maxConcurrentTotal - running TTS processes on this task
   * @param {() => number} [opts.now]
   */
  constructor({ maxPerWindow, windowMs, maxConcurrentPerUser, maxConcurrentTotal, now = Date.now }) {
    this.maxPerWindow = maxPerWindow;
    this.windowMs = windowMs;
    this.maxConcurrentPerUser = maxConcurrentPerUser;
    this.maxConcurrentTotal = maxConcurrentTotal;
    this.now = now;
    this.timestamps = new Map(); // key → number[] (start times within window)
    this.active = new Map(); // key → running process count
    this.totalActive = 0;
  }

  _recent(key) {
    const now = this.now();
    const recent = (this.timestamps.get(key) || []).filter((t) => now - t < this.windowMs);
    if (recent.length > 0) this.timestamps.set(key, recent);
    else this.timestamps.delete(key);
    return recent;
  }

  /**
   * Try to start a preview for `key`. On success the start is recorded and a
   * concurrency slot is held until the returned (idempotent) release() runs.
   * Refused attempts do not consume rate budget.
   * @param {string} key
   * @returns {{allowed: true, release: () => void} |
   *           {allowed: false, reason: "rate" | "concurrent" | "capacity", retryAfterMs: number}}
   */
  tryAcquire(key) {
    const recent = this._recent(key);
    if (recent.length >= this.maxPerWindow) {
      const retryAfterMs = Math.max(0, recent[0] + this.windowMs - this.now());
      return { allowed: false, reason: "rate", retryAfterMs };
    }
    if ((this.active.get(key) || 0) >= this.maxConcurrentPerUser) {
      return { allowed: false, reason: "concurrent", retryAfterMs: 0 };
    }
    if (this.totalActive >= this.maxConcurrentTotal) {
      return { allowed: false, reason: "capacity", retryAfterMs: 0 };
    }

    recent.push(this.now());
    this.timestamps.set(key, recent);
    this.active.set(key, (this.active.get(key) || 0) + 1);
    this.totalActive += 1;

    const release = once(() => {
      const count = (this.active.get(key) || 0) - 1;
      if (count > 0) this.active.set(key, count);
      else this.active.delete(key);
      this.totalActive = Math.max(0, this.totalActive - 1);
    });
    return { allowed: true, release };
  }

  /** Number of running previews for `key`. */
  activeCount(key) {
    return this.active.get(key) || 0;
  }

  /** Drop identities whose timestamps have all aged out of the window. */
  prune() {
    for (const key of [...this.timestamps.keys()]) this._recent(key);
  }
}

class ConnectionLimiter {
  /** @param {{maxPerUser: number}} opts */
  constructor({ maxPerUser }) {
    this.maxPerUser = maxPerUser;
    this.counts = new Map(); // key → open connection count
  }

  isAtLimit(key) {
    return (this.counts.get(key) || 0) >= this.maxPerUser;
  }

  /**
   * Register an open connection for `key`.
   * @returns {(() => void) | null} idempotent release, or null if at the limit
   */
  tryAdd(key) {
    if (this.isAtLimit(key)) return null;
    this.counts.set(key, (this.counts.get(key) || 0) + 1);
    return once(() => {
      const count = (this.counts.get(key) || 0) - 1;
      if (count > 0) this.counts.set(key, count);
      else this.counts.delete(key);
    });
  }

  count(key) {
    return this.counts.get(key) || 0;
  }
}

/** Parse a positive integer env value, falling back to `fallback`. */
function positiveIntEnv(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

module.exports = { VoicePreviewLimiter, ConnectionLimiter, limiterKey, positiveIntEnv };
