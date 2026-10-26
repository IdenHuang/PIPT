/**
 * Socket server /stream-callback entitlement (cdk/socket-server):
 *   - stream-relay.js: per-request nonce registry and constant-time compare
 *   - server.js wiring: the relay requires the nonce, the token check is
 *     constant-time, and the nonce is sent to the Lambda server-to-server
 */

import * as fs from 'fs';
import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { StreamRelayRegistry, safeEqual, isValidNonce } = require('../socket-server/stream-relay.js');

const SESSION_A = '55555555-5555-4555-8555-555555555555';
const SESSION_B = '66666666-6666-4666-8666-666666666666';

describe('safeEqual', () => {
  test('matches identical strings only', () => {
    expect(safeEqual('secret', 'secret')).toBe(true);
    expect(safeEqual('secret', 'secreT')).toBe(false);
    expect(safeEqual('secret', 'secret-longer')).toBe(false);
  });

  test.each([undefined, null, 42, ['secret'], {}])('rejects non-string input %p', (value) => {
    expect(safeEqual(value, 'secret')).toBe(false);
    expect(safeEqual('secret', value)).toBe(false);
  });
});

describe('StreamRelayRegistry', () => {
  test('register mints a fresh 64-hex nonce per request', () => {
    const relay = new StreamRelayRegistry();
    const n1 = relay.register(SESSION_A, {});
    const n2 = relay.register(SESSION_A, {});
    expect(isValidNonce(n1)).toBe(true);
    expect(isValidNonce(n2)).toBe(true);
    expect(n1).not.toBe(n2);
  });

  test('resolves the socket only with the matching nonce', () => {
    const relay = new StreamRelayRegistry();
    const socket = { id: 'a' };
    const nonce = relay.register(SESSION_A, socket);
    expect(relay.resolve(SESSION_A, nonce)).toBe(socket);
    expect(relay.resolve(SESSION_A, undefined)).toBeNull();
    expect(relay.resolve(SESSION_A, '')).toBeNull();
    expect(relay.resolve(SESSION_A, 'f'.repeat(64))).toBeNull();
    expect(relay.resolve(SESSION_A, nonce.toUpperCase())).toBeNull();
  });

  test("a nonce for one session cannot publish into another session", () => {
    const relay = new StreamRelayRegistry();
    const nonceA = relay.register(SESSION_A, { id: 'a' });
    relay.register(SESSION_B, { id: 'b' });
    expect(relay.resolve(SESSION_B, nonceA)).toBeNull();
  });

  test('a superseded nonce stops working and cannot release the newer registration', () => {
    const relay = new StreamRelayRegistry();
    const oldNonce = relay.register(SESSION_A, { id: 'old' });
    const newSocket = { id: 'new' };
    const newNonce = relay.register(SESSION_A, newSocket);
    expect(relay.resolve(SESSION_A, oldNonce)).toBeNull();
    relay.release(SESSION_A, oldNonce);
    expect(relay.resolve(SESSION_A, newNonce)).toBe(newSocket);
  });

  test('release removes the registration so the nonce cannot be replayed', () => {
    const relay = new StreamRelayRegistry();
    const nonce = relay.register(SESSION_A, {});
    relay.release(SESSION_A, nonce);
    expect(relay.resolve(SESSION_A, nonce)).toBeNull();
  });

  test('onRelease runs once on release and when superseded', () => {
    const relay = new StreamRelayRegistry();
    const first = jest.fn();
    const second = jest.fn();
    const n1 = relay.register(SESSION_A, {}, first);
    const n2 = relay.register(SESSION_A, {}, second);
    expect(first).toHaveBeenCalledTimes(1);
    relay.release(SESSION_A, n1);
    expect(second).not.toHaveBeenCalled();
    relay.release(SESSION_A, n2);
    relay.release(SESSION_A, n2);
    expect(second).toHaveBeenCalledTimes(1);
  });

  describe('deferred release after an API Gateway timeout', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    test('keeps relaying until the max, then releases', () => {
      const relay = new StreamRelayRegistry();
      const socket = { id: 'a' };
      const onRelease = jest.fn();
      const nonce = relay.register(SESSION_A, socket, onRelease);
      relay.defer(SESSION_A, nonce, 300_000);
      jest.advanceTimersByTime(299_000);
      expect(relay.resolve(SESSION_A, nonce)).toBe(socket);
      jest.advanceTimersByTime(1_000);
      expect(relay.resolve(SESSION_A, nonce)).toBeNull();
      expect(onRelease).toHaveBeenCalledTimes(1);
    });

    test('a terminal frame shortens the hold to the trailing grace period', () => {
      const relay = new StreamRelayRegistry();
      const onRelease = jest.fn();
      const nonce = relay.register(SESSION_A, {}, onRelease);
      relay.defer(SESSION_A, nonce, 300_000);
      relay.settle(SESSION_A, nonce, 15_000);
      jest.advanceTimersByTime(14_999);
      expect(onRelease).not.toHaveBeenCalled();
      jest.advanceTimersByTime(1);
      expect(onRelease).toHaveBeenCalledTimes(1);
    });

    test('a terminal frame that arrived before the timeout is honoured by defer', () => {
      const relay = new StreamRelayRegistry();
      const onRelease = jest.fn();
      const nonce = relay.register(SESSION_A, {}, onRelease);
      relay.settle(SESSION_A, nonce, 15_000);
      expect(onRelease).not.toHaveBeenCalled(); // not deferred: handler releases
      relay.defer(SESSION_A, nonce, 300_000);
      jest.advanceTimersByTime(15_000);
      expect(onRelease).toHaveBeenCalledTimes(1);
    });

    test('settle with a wrong nonce does not shorten the hold', () => {
      const relay = new StreamRelayRegistry();
      const onRelease = jest.fn();
      const nonce = relay.register(SESSION_A, {}, onRelease);
      relay.defer(SESSION_A, nonce, 300_000);
      relay.settle(SESSION_A, 'f'.repeat(64), 0);
      jest.advanceTimersByTime(1_000);
      expect(onRelease).not.toHaveBeenCalled();
    });

    test('a newer registration is not released by the old timer', () => {
      const relay = new StreamRelayRegistry();
      const oldNonce = relay.register(SESSION_A, {});
      relay.defer(SESSION_A, oldNonce, 1_000);
      const socket = { id: 'new' };
      const newNonce = relay.register(SESSION_A, socket);
      jest.advanceTimersByTime(5_000);
      expect(relay.resolve(SESSION_A, newNonce)).toBe(socket);
    });
  });

  test('rejects non-string session ids', () => {
    const relay = new StreamRelayRegistry();
    const nonce = relay.register(SESSION_A, {});
    expect(relay.resolve({ toString: () => SESSION_A }, nonce)).toBeNull();
  });
});

describe('server.js wiring', () => {
  const socketDir = path.join(__dirname, '..', 'socket-server');
  const server = fs.readFileSync(path.join(socketDir, 'server.js'), 'utf8');

  function callbackRoute(): string {
    const start = server.indexOf('app.post("/stream-callback"');
    if (start === -1) throw new Error('/stream-callback route not found');
    return server.slice(start, server.indexOf('\n});', start));
  }

  test('the shared token is compared in constant time', () => {
    const route = callbackRoute();
    expect(route).toMatch(/safeEqual\(req\.headers\["x-callback-token"\], streamCallbackToken\)/);
    expect(route).not.toMatch(/!==\s*streamCallbackToken/);
  });

  test('the relay requires the per-request nonce and rejects without it', () => {
    const route = callbackRoute();
    expect(route).toMatch(/textStreamSockets\.resolve\(session_id, req\.headers\["x-stream-nonce"\]\)/);
    expect(route).toMatch(/status\(403\)/);
    expect(route).not.toMatch(/textStreamSockets\.get\(/);
  });

  test('text-generation registers with a nonce, sends it to the Lambda, and releases by nonce', () => {
    const start = server.indexOf('socket.on("text-generation"');
    const block = server.slice(start, server.indexOf('socket.on(', start + 1));
    expect(block).toMatch(/const streamNonce = textStreamSockets\.register\(sessionId, socket,/);
    expect(block).toMatch(/"X-Stream-Nonce": streamNonce/);
    expect(block).toMatch(/if \(!deferRelease\) textStreamSockets\.release\(sessionId, streamNonce\)/);
    // A 504 from API Gateway keeps the registration instead of erroring out.
    expect(block).toMatch(/response\.status === 504[\s\S]*?textStreamSockets\.defer\(sessionId, streamNonce, TEXT_STREAM_MAX_MS\)[\s\S]*?return;/);
    expect(block).not.toMatch(/textStreamSockets\.(set|delete)\(/);
    // Registration still happens only after the session guard has allowed it.
    expect(block.indexOf('authorizeSessionRequest(')).toBeLessThan(block.indexOf('textStreamSockets.register('));
  });

  test('the relay module is shipped in the container image', () => {
    const dockerfile = fs.readFileSync(path.join(socketDir, 'Dockerfile'), 'utf8');
    expect(dockerfile).toMatch(/^COPY stream-relay\.js \.\/\r?$/m);
  });
});
