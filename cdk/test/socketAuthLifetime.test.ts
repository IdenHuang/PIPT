/**
 * Socket credential lifetime (finding f-ce3f0cff): a Socket.IO connection is
 * valid only until its newest verified ID token expires (plus grace), and is
 * extended only by a fresh token bound to the same user.
 */

import * as fs from 'fs';
import * as path from 'path';

/* eslint-disable @typescript-eslint/no-require-imports */
const { SocketAuthLifetime, tokenExpiryMs, DEFAULT_GRACE_MS } = require('../socket-server/socket-auth-lifetime.js');
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
});
