/**
 * Socket server session authorization (cdk/socket-server):
 *   - session-guard.js authorizeSessionRequest decisions
 *   - server.js wiring: both session events go through the guard, and no
 *     shared "default" session fallback remains
 */

import * as fs from 'fs';
import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { authorizeSessionRequest } = require('../socket-server/session-guard.js');

const SESSION = '55555555-5555-4555-8555-555555555555';
const PATIENT = '33333333-3333-4333-8333-333333333333';
const GROUP = '11111111-1111-4111-8111-111111111111';
const EMAIL = 'student@example.edu';

const valid = (): Record<string, unknown> => ({
  userEmail: EMAIL,
  sessionId: SESSION,
  patientId: PATIENT,
  simulationGroupId: GROUP,
});

describe('authorizeSessionRequest', () => {
  test('allows when the scope check authorizes, passing all four values', async () => {
    const verify = jest.fn().mockResolvedValue({ authorized: true });
    await expect(authorizeSessionRequest(valid(), verify)).resolves.toEqual({ allowed: true });
    expect(verify).toHaveBeenCalledWith(SESSION, PATIENT, GROUP, EMAIL);
  });

  test('denies when the scope check rejects', async () => {
    const verify = jest.fn().mockResolvedValue({ authorized: false });
    await expect(authorizeSessionRequest(valid(), verify)).resolves.toMatchObject({ allowed: false });
  });

  test('denies when the scope check throws', async () => {
    const verify = jest.fn().mockRejectedValue(new Error('db down'));
    await expect(authorizeSessionRequest(valid(), verify)).resolves.toMatchObject({ allowed: false });
  });

  test.each([undefined, null, '', '   ', 42])(
    'denies a missing or invalid email (%p) without querying',
    async (userEmail) => {
      const verify = jest.fn().mockResolvedValue({ authorized: true });
      const result = await authorizeSessionRequest({ ...valid(), userEmail }, verify);
      expect(result.allowed).toBe(false);
      expect(verify).not.toHaveBeenCalled();
    }
  );

  test.each(['sessionId', 'patientId', 'simulationGroupId'])(
    'denies when %s is omitted, instead of skipping the check',
    async (field) => {
      const verify = jest.fn().mockResolvedValue({ authorized: true });
      const badValues: unknown[] = [undefined, '', { $ne: null }];
      for (const value of badValues) {
        const result = await authorizeSessionRequest({ ...valid(), [field]: value }, verify);
        expect(result.allowed).toBe(false);
      }
      expect(verify).not.toHaveBeenCalled();
    }
  );

  test('denies a truthy non-boolean authorization result', async () => {
    const verify = jest.fn().mockResolvedValue({ authorized: 'yes' });
    await expect(authorizeSessionRequest(valid(), verify)).resolves.toMatchObject({ allowed: false });
  });
});

describe('server.js wiring', () => {
  const socketDir = path.join(__dirname, '..', 'socket-server');
  const server = fs.readFileSync(path.join(socketDir, 'server.js'), 'utf8');

  function eventBlock(event: string): string {
    const start = server.indexOf(`socket.on("${event}"`);
    if (start === -1) throw new Error(`event not found: ${event}`);
    const next = server.indexOf('socket.on(', start + 1);
    return server.slice(start, next);
  }

  test.each([
    ['start-nova-sonic', 'connectToVoiceAgent('],
    ['text-generation', 'fetch('],
  ])('%s runs the guard and returns on denial before doing any work', (event, firstWork) => {
    const block = eventBlock(event);
    const guardAt = block.indexOf('authorizeSessionRequest(');
    expect(guardAt).toBeGreaterThan(-1);
    expect(block.indexOf('verifySessionScope', guardAt)).toBeGreaterThan(guardAt);
    expect(guardAt).toBeLessThan(block.indexOf(firstWork));
    expect(block).toMatch(/if \(!\w+Authz\.allowed\) \{[\s\S]*?return;\s*\}/);
  });

  test('ownership is no longer conditional on session_id or email being present', () => {
    expect(server).not.toMatch(/if \(sessionId && socket\.userEmail\)/);
  });

  test('no shared "default" session fallback remains', () => {
    expect(server).not.toMatch(/session_id \|\| "default"/);
  });

  test('the guard module is shipped in the container image', () => {
    const dockerfile = fs.readFileSync(path.join(socketDir, 'Dockerfile'), 'utf8');
    expect(dockerfile).toMatch(/^COPY session-guard\.js \.\/\r?$/m);
  });
});
