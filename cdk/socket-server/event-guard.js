"use strict";

/**
 * Guards for Socket.IO event handlers.
 *
 * Event payloads are client-controlled: a client can send no argument, null,
 * a string, or an array where a handler expects an object. A handler that
 * dereferences such a payload throws, and because the socket server runs as a
 * single ECS task, an uncaught throw would drop every connected user.
 */

const logger = require("./logger");

/**
 * Returns `value` if it is a plain (non-array) object, otherwise null.
 * ES default parameters do not cover an explicit null, so handlers must
 * normalise payloads with this instead of `(config = {})`.
 */
function asPayload(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

/**
 * Wraps a Socket.IO listener so a synchronous throw or a rejected promise is
 * logged instead of reaching the process-level handlers. Socket.IO ignores
 * the promise an async listener returns, so without this a rejection is
 * unhandled.
 */
function guardHandler(event, socket, handler) {
  const onError = (err) => {
    logger.error("Socket event handler failed", {
      component: "server",
      operation: event,
      socketId: socket.id,
      error: String(err && err.message),
      stack: err && err.stack,
    });
  };
  return (...args) => {
    try {
      const result = handler(...args);
      if (result && typeof result.then === "function") {
        result.then(undefined, onError);
      }
    } catch (err) {
      onError(err);
    }
  };
}

module.exports = { asPayload, guardHandler };
