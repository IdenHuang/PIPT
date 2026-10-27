/**
 * Socket server voice-preview / connection limits (cdk/socket-server):
 *   - voice-preview-limiter.js: per-identity rate, concurrency and connection caps
 *   - server.js wiring: limits are keyed on the user, not socket.id, and are
 *     not reset on disconnect
 */
import * as fs from 'fs';
import * as path from 'path';

/* eslint-disable @typescript-eslint/no-require-imports */
const {
  VoicePreviewLimiter,
  ConnectionLimiter,
  limiterKey,
  positiveIntEnv,
} = require('../socket-server/voice-preview-limiter.js');
/* eslint-enable @typescript-eslint/no-require-imports */

function makeLimiter(overrides: Record<string, number> = {}) {
  let clock = 1_000_000;
  const limiter = new VoicePreviewLimiter({
    maxPerWindow: 5,
    windowMs: 60_000,
    maxConcurrentPerUser: 2,
    maxConcurrentTotal: 10,
    now: () => clock,
    ...overrides,
  });
  return { limiter, advance: (ms: number) => { clock += ms; } };
}

describe('limiterKey', () => {
  test('uses the verified user id regardless of socket.id', () => {
    expect(limiterKey({ id: 'a', userId: 'sub-1' })).toBe('user:sub-1');
    expect(limiterKey({ id: 'b', userId: 'sub-1' })).toBe('user:sub-1');
  });

  test('falls back to the first X-Forwarded-For hop, then the socket address', () => {
    expect(limiterKey({ handshake: { headers: { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' } } })).toBe('ip:203.0.113.7');
    expect(limiterKey({ handshake: { headers: {}, address: '198.51.100.2' } })).toBe('ip:198.51.100.2');
  });
});

describe('VoicePreviewLimiter', () => {
  test('rate limit applies per identity and reports when to retry', () => {
    const { limiter, advance } = makeLimiter({ maxConcurrentPerUser: 100 });
    for (let i = 0; i < 5; i++) {
      expect(limiter.tryAcquire('user:a').allowed).toBe(true);
      advance(1_000);
    }
    const refused = limiter.tryAcquire('user:a');
    expect(refused).toEqual({ allowed: false, reason: 'rate', retryAfterMs: 55_000 });
    // Another user is unaffected.
    expect(limiter.tryAcquire('user:b').allowed).toBe(true);
    // Budget returns once the oldest start leaves the window.
    advance(55_000);
    expect(limiter.tryAcquire('user:a').allowed).toBe(true);
  });

  test('released previews still count toward the rate budget', () => {
    const { limiter } = makeLimiter();
    for (let i = 0; i < 5; i++) {
      const slot = limiter.tryAcquire('user:a');
      expect(slot.allowed).toBe(true);
      slot.release();
    }
    expect(limiter.tryAcquire('user:a')).toMatchObject({ allowed: false, reason: 'rate' });
  });

  test('caps concurrent previews per identity until a slot is released', () => {
    const { limiter } = makeLimiter();
    const first = limiter.tryAcquire('user:a');
    const second = limiter.tryAcquire('user:a');
    expect(limiter.tryAcquire('user:a')).toEqual({ allowed: false, reason: 'concurrent', retryAfterMs: 0 });
    first.release();
    first.release(); // idempotent: must not free two slots
    expect(limiter.activeCount('user:a')).toBe(1);
    expect(limiter.tryAcquire('user:a').allowed).toBe(true);
    expect(second.allowed).toBe(true);
  });

  test('refused attempts do not consume rate budget', () => {
    const { limiter } = makeLimiter({ maxConcurrentPerUser: 1 });
    const held = limiter.tryAcquire('user:a');
    for (let i = 0; i < 10; i++) expect(limiter.tryAcquire('user:a').allowed).toBe(false);
    held.release();
    expect(limiter.tryAcquire('user:a').allowed).toBe(true);
  });

  test('caps total concurrent previews across identities', () => {
    const { limiter } = makeLimiter({ maxConcurrentTotal: 2 });
    const a = limiter.tryAcquire('user:a');
    limiter.tryAcquire('user:b');
    expect(limiter.tryAcquire('user:c')).toMatchObject({ allowed: false, reason: 'capacity' });
    a.release();
    expect(limiter.tryAcquire('user:c').allowed).toBe(true);
  });

  test('prune drops identities whose history has aged out', () => {
    const { limiter, advance } = makeLimiter();
    limiter.tryAcquire('user:a').release();
    advance(60_000);
    limiter.prune();
    expect(limiter.timestamps.size).toBe(0);
  });
});

describe('ConnectionLimiter', () => {
  test('caps open connections per identity and frees them on release', () => {
    const limiter = new ConnectionLimiter({ maxPerUser: 2 });
    const r1 = limiter.tryAdd('user:a');
    limiter.tryAdd('user:a');
    expect(limiter.isAtLimit('user:a')).toBe(true);
    expect(limiter.tryAdd('user:a')).toBeNull();
    expect(limiter.tryAdd('user:b')).not.toBeNull();
    r1();
    r1();
    expect(limiter.count('user:a')).toBe(1);
  });
});

describe('positiveIntEnv', () => {
  test.each([[undefined, 5], ['', 5], ['0', 5], ['-3', 5], ['abc', 5], ['8', 8]])('%p → %p', (value, expected) => {
    expect(positiveIntEnv(value, 5)).toBe(expected);
  });
});

describe('server.js wiring', () => {
  const socketDir = path.join(__dirname, '..', 'socket-server');
  const server = fs.readFileSync(path.join(socketDir, 'server.js'), 'utf8');

  function block(marker: string): string {
    const start = server.indexOf(marker);
    if (start === -1) throw new Error(`${marker} not found`);
    return server.slice(start, server.indexOf('\n  });', start));
  }

  test('voice-preview limits are keyed on the user identity, not socket.id', () => {
    const handler = block('socket.on("voice-preview",');
    expect(handler).toMatch(/voicePreviewLimiter\.tryAcquire\(limiterKey\(socket\)\)/);
    expect(handler).not.toMatch(/socket\.id/);
    // The limit is checked before any process is spawned.
    expect(handler.indexOf('tryAcquire(')).toBeLessThan(handler.indexOf('spawn('));
  });

  test('disconnect does not clear rate-limit history', () => {
    expect(server).not.toMatch(/voicePreviewTimestamps/);
    const disconnect = block('socket.on("disconnect", () => {');
    expect(disconnect).toMatch(/stopTtsProcess\(\)/);
    expect(disconnect).not.toMatch(/\.delete\(/);
  });

  test('every TTS process exit path releases its concurrency slot', () => {
    expect(server).toMatch(/child\.releaseVoiceSlot = slot\.release/);
    const handler = block('socket.on("voice-preview",');
    expect(handler).toMatch(/on\("close"[\s\S]*?child\.releaseVoiceSlot\(\)/);
    expect(handler).toMatch(/on\("error"[\s\S]*?child\.releaseVoiceSlot\(\)/);
    expect(server).not.toMatch(/ttsProcess\.kill\(\)/);
  });

  test('connections are counted per user and released on disconnect', () => {
    expect(server).toMatch(/connectionLimiter\.isAtLimit\(limiterKey\(socket\)\)/);
    expect(server).toMatch(/const releaseConnection = connectionLimiter\.tryAdd\(limiterKey\(socket\)\)/);
    expect(server).toMatch(/socket\.on\("disconnect", releaseConnection\)/);
  });

  test('the limiter module is shipped in the container image', () => {
    const dockerfile = fs.readFileSync(path.join(socketDir, 'Dockerfile'), 'utf8');
    expect(dockerfile).toMatch(/^COPY voice-preview-limiter\.js \.\/\r?$/m);
  });
});
