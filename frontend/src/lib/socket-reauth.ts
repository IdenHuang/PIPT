// Keeps a Socket.IO connection authenticated past ID-token expiry.
//
// The socket server only accepts events while the connection's credential is
// valid (see cdk/socket-server/socket-auth-lifetime.js). After connecting it
// emits 'auth-state' with the time left; this helper sends a freshly refreshed
// ID token on 'reauth' a few minutes before then, and again after each
// renewal. If renewal keeps failing (signed out, refresh token revoked), the
// server disconnects with 'auth-expired'.

import type { Socket } from 'socket.io-client';
import { authService } from '@/lib/auth';

// Renew this long before expiry. Leaves room for background-tab timer
// throttling (Chrome runs hidden-tab timers at most once a minute).
const RENEW_BEFORE_MS = 5 * 60 * 1000;
const RETRY_MS = 30 * 1000;
const MIN_DELAY_MS = 1000;
const ACK_TIMEOUT_MS = 10 * 1000;

type ReauthAck = { ok: true; expiresInMs: number } | { ok: false; error: string };

export interface SocketReauthOptions {
  // Called when the server ended the connection because the sign-in expired
  // and no new token could be obtained.
  onExpired?: (message: string) => void;
}

/**
 * Attach automatic re-authentication to a socket. Safe to call once per
 * socket; survives reconnects. Returns a function that detaches it.
 */
export function attachSocketReauth(socket: Socket, options: SocketReauthOptions = {}): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let deadline = 0; // local epoch ms when the server will expire the socket
  let expiredMessage: string | null = null;
  let detached = false;

  const clearTimer = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const scheduleRenewal = (expiresInMs: number) => {
    deadline = Date.now() + expiresInMs;
    schedule(expiresInMs - RENEW_BEFORE_MS);
  };

  const schedule = (delayMs: number) => {
    clearTimer();
    if (detached) return;
    timer = setTimeout(renew, Math.max(MIN_DELAY_MS, delayMs));
  };

  const retryLater = () => {
    if (Date.now() < deadline) schedule(RETRY_MS);
  };

  async function renew() {
    timer = null;
    if (detached || !socket.connected) return;
    const token = await authService.getIdToken({ forceRefresh: true });
    if (detached || !socket.connected) return;
    if (!token) {
      retryLater();
      return;
    }
    socket.timeout(ACK_TIMEOUT_MS).emit('reauth', { token }, (err: Error | null, res?: ReauthAck) => {
      if (detached) return;
      if (!err && res?.ok) {
        scheduleRenewal(res.expiresInMs);
      } else {
        retryLater();
      }
    });
  }

  const onAuthState = (data: { expiresInMs?: number }) => {
    expiredMessage = null;
    if (typeof data?.expiresInMs === 'number') scheduleRenewal(data.expiresInMs);
  };

  const onAuthExpired = (data: { message?: string }) => {
    expiredMessage = data?.message || 'Your sign-in has expired. Please sign in again.';
  };

  const onDisconnect = (reason: string) => {
    clearTimer();
    // A server-initiated disconnect is not retried by Socket.IO. If it was a
    // credential expiry, reconnect once if a token can still be obtained
    // (e.g. renewal failed only because the network dropped); otherwise
    // report it so the page can tell the user.
    if (reason !== 'io server disconnect' || expiredMessage === null || detached) return;
    const message = expiredMessage;
    expiredMessage = null;
    authService.getIdToken().then((token) => {
      if (detached) return;
      if (token) {
        socket.connect();
      } else {
        options.onExpired?.(message);
      }
    });
  };

  socket.on('auth-state', onAuthState);
  socket.on('auth-expired', onAuthExpired);
  socket.on('disconnect', onDisconnect);

  return () => {
    detached = true;
    clearTimer();
    socket.off('auth-state', onAuthState);
    socket.off('auth-expired', onAuthExpired);
    socket.off('disconnect', onDisconnect);
  };
}
