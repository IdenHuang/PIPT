/**
 * Socket credential lifetime (finding f-ce3f0cff): a Socket.IO connection is
 * valid only until its newest verified ID token expires (plus grace), and is
 * extended only by a fresh token bound to the same user.
 */

import * as fs from 'fs';
import * as path from 'path';

/* eslint-disable @typescript-eslint/no-require-imports */
const {
  SocketAuthLifetime,
  ReauthGate,
  tokenExpiryMs,
  DEFAULT_GRACE_MS,
} = require('../socket-server/socket-auth-lifetime.js');
const { resolveRelayToken } = require('../socket-server/relay-token.js');
const { isTransientKeyError } = require('../socket-server/auth.js');
/* eslint-enable @typescript-eslint/no-require-imports */

describe('tokenExpiryMs', () => {
  test('converts exp seconds to epoch ms', () => {
    expect(tokenExpiryMs({ exp: 1_700_000_000 })).toBe(1_700_000_000_000);
  });

  test.each([undefined, null, {}, { exp: '1700000000' }, { exp: NaN }, { exp: Infinity }])(
    'treats %p as already expired',
    (decoded) => {
      expect(tokenExpiryMs(decoded)).toBe(0);
    }
  );
});

describe('SocketAuthLifetime', () => {
  const START = 1_000_000;
  let now: number;
  const clock = () => now;

  beforeEach(() => {
    jest.useFakeTimers();
    now = START;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const advance = (ms: number) => {
    now += ms;
    jest.advanceTimersByTime(ms);
  };

  const make = (expiresAtMs: number) => {
    const onExpire = jest.fn();
    const lifetime = new SocketAuthLifetime({ expiresAtMs, onExpire, now: clock });
    return { lifetime, onExpire };
  };

  test('is valid until exp plus grace, then fires onExpire once', () => {
    const { lifetime, onExpire } = make(START + 60_000);
    advance(60_000 + DEFAULT_GRACE_MS - 1);
    expect(lifetime.isExpired()).toBe(false);
    expect(onExpire).not.toHaveBeenCalled();

    advance(1);
    expect(lifetime.isExpired()).toBe(true);
    expect(onExpire).toHaveBeenCalledTimes(1);

    advance(10 * 60_000);
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  test('renew with a later exp extends the deadline', () => {
    const { lifetime, onExpire } = make(START + 60_000);
    advance(30_000);
    expect(lifetime.renew(START + 3_600_000)).toBe(true);

    advance(60_000 + DEFAULT_GRACE_MS);
    expect(onExpire).not.toHaveBeenCalled();
    expect(lifetime.expiresInMs()).toBe(START + 3_600_000 - now);

    advance(3_600_000);
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  test('renew with an older exp never shortens the deadline', () => {
    const { lifetime, onExpire } = make(START + 3_600_000);
    expect(lifetime.renew(START + 1_000)).toBe(true);
    expect(lifetime.expiresAt).toBe(START + 3_600_000);
    advance(60_000);
    expect(onExpire).not.toHaveBeenCalled();
  });

  test('renew after expiry is refused and does not revive the socket', () => {
    const { lifetime } = make(START + 1_000);
    advance(1_000 + DEFAULT_GRACE_MS);
    expect(lifetime.renew(START + 3_600_000)).toBe(false);
    expect(lifetime.isExpired()).toBe(true);
  });

  test('is expired between the deadline and the timer firing', () => {
    const { lifetime } = make(START + 1_000);
    // Clock moves (e.g. event loop blocked) without timers running yet.
    now += 1_000 + DEFAULT_GRACE_MS;
    expect(lifetime.isExpired()).toBe(true);
  });

  test('a handshake token without exp is expired immediately', () => {
    const { lifetime, onExpire } = make(tokenExpiryMs({}));
    expect(lifetime.isExpired()).toBe(true);
    jest.advanceTimersByTime(0);
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  test('stop cancels the timer and onExpire never fires', () => {
    const { lifetime, onExpire } = make(START + 1_000);
    lifetime.stop();
    advance(60_000);
    expect(onExpire).not.toHaveBeenCalled();
  });
});

describe('ReauthGate (finding f-ac8c49e2)', () => {
  let now: number;
  const make = () => new ReauthGate({ minIntervalMs: 5_000, maxFailures: 3, lockoutMs: 300_000, now: () => now });

  beforeEach(() => {
    now = 1_000_000;
  });

  test('allows one attempt at a time', () => {
    const gate = make();
    expect(gate.tryBegin()).toEqual({ allowed: true });
    now += 60_000;
    expect(gate.tryBegin()).toEqual({ allowed: false, reason: 'in_flight' });
    gate.finish('ok');
    expect(gate.tryBegin()).toEqual({ allowed: true });
  });

  test('enforces the minimum interval between attempts', () => {
    const gate = make();
    gate.tryBegin();
    gate.finish('ok');
    now += 4_999;
    expect(gate.tryBegin()).toEqual({ allowed: false, reason: 'too_soon' });
    now += 1;
    expect(gate.tryBegin()).toEqual({ allowed: true });
  });

  test("never refuses the real client's schedule (hourly renewals, 30s retries)", () => {
    const gate = make();
    for (let i = 0; i < 20; i++) {
      expect(gate.tryBegin().allowed).toBe(true);
      gate.finish(i % 2 ? 'ok' : 'transient');
      now += 30_000;
    }
  });

  test('locks out after maxFailures clear rejections in a row, then recovers', () => {
    const gate = make();
    for (let i = 0; i < 3; i++) {
      expect(gate.tryBegin().allowed).toBe(true);
      gate.finish('rejected');
      now += 5_000;
    }
    expect(gate.tryBegin()).toEqual({ allowed: false, reason: 'locked' });
    now += 300_000;
    expect(gate.tryBegin()).toEqual({ allowed: true });
  });

  test('a success resets the failure count', () => {
    const gate = make();
    for (const outcome of ['rejected', 'rejected', 'ok', 'rejected', 'rejected']) {
      expect(gate.tryBegin().allowed).toBe(true);
      gate.finish(outcome);
      now += 5_000;
    }
    expect(gate.tryBegin().allowed).toBe(true);
  });

  test('transient failures (JWKS unreachable or rate limited) never lock out', () => {
    const gate = make();
    for (let i = 0; i < 10; i++) {
      expect(gate.tryBegin().allowed).toBe(true);
      gate.finish('transient');
      now += 5_000;
    }
  });
});

describe('transient token-check failures', () => {
  const identity = { userId: 'u1', userEmail: 'u1@example.edu' };

  test.each([
    ['rate limited', 'JwksRateLimitError', true],
    ['JWKS endpoint error', 'JwksError', true],
    ['network error', 'Error', true],
    ['unknown kid', 'SigningKeyNotFoundError', false],
  ])('%s -> transient=%p', (_label, name, transient) => {
    const err = new Error('x');
    err.name = name;
    expect(isTransientKeyError(err)).toBe(transient);
  });

  test('resolveRelayToken passes transient through, and only then', async () => {
    const transientErr = Object.assign(new Error('jwks down'), { transient: true });
    await expect(resolveRelayToken('tok', identity, jest.fn().mockRejectedValue(transientErr))).resolves.toEqual({
      ok: false,
      error: 'Authentication failed',
      transient: true,
    });
    await expect(resolveRelayToken('tok', identity, jest.fn().mockRejectedValue(new Error('bad sig')))).resolves.toEqual({
      ok: false,
      error: 'Authentication failed',
    });
  });
});

describe('socket server wiring', () => {
  const root = path.join(__dirname, '..', 'socket-server');
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');

  test('every client event goes through the credential gate', () => {
    // Only the disconnect cleanup may bypass the gated `on` helper.
    const direct = [...server.matchAll(/socket\.on\("([\w-]+)"/g)].map((m) => m[1]);
    expect(new Set(direct)).toEqual(new Set(['disconnect', 'error']));
    expect(server).toContain('if (authLifetime.isExpired())');
  });

  test('start-nova-sonic never falls back to the handshake token', () => {
    // The only read is in the handshake middleware.
    expect(server.match(/socket\.handshake\.auth\.token/g)).toHaveLength(1);
  });

  test('the lifetime module ships in the image', () => {
    expect(dockerfile).toContain('COPY socket-auth-lifetime.js ./');
  });

  test('reauth is gated before any token verification', () => {
    const start = server.indexOf('on("reauth"');
    const block = server.slice(start, server.indexOf('socket.emit("auth-state"', start));
    expect(block.indexOf('reauthGate.tryBegin()')).toBeGreaterThan(-1);
    expect(block.indexOf('reauthGate.tryBegin()')).toBeLessThan(block.indexOf('resolveRelayToken('));
    expect(block).toContain('reauthGate.finish(outcome)');
  });

  test('JWKS fetches for uncached keys are rate limited', () => {
    const auth = fs.readFileSync(path.join(root, 'auth.js'), 'utf8');
    expect(auth).toContain('cache: true');
    expect(auth).toContain('rateLimit: true');
    expect(auth).toContain('jwksRequestsPerMinute: JWKS_REQUESTS_PER_MINUTE');
  });
});
