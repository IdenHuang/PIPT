/**
 * Server-side voice kill-switch for start-nova-sonic (cdk/socket-server):
 *   - session-auth.js verifySessionScope enforces personas.voice_enabled and
 *     simulation_groups.instructor_voice_enabled when requireVoiceEnabled is set
 *   - session-guard.js maps the voice_disabled denial to its own message
 *   - server.js asks for the voice check on start-nova-sonic only
 */
import * as fs from 'fs';
import * as path from 'path';

const mockSql = jest.fn();

// session-auth.js resolves these from cdk/socket-server/node_modules, so mock
// them by that path for the mock to apply to its require() calls.
jest.mock('../socket-server/node_modules/postgres', () => jest.fn(() => mockSql));
jest.mock('../socket-server/node_modules/@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: jest.fn(() => ({
    send: jest.fn().mockResolvedValue({
      SecretString: JSON.stringify({ username: 'u', password: 'p', dbname: 'd', port: 5432 }),
    }),
  })),
  GetSecretValueCommand: jest.fn(),
}));

process.env.SM_DB_CREDENTIALS = 'test-secret';
process.env.RDS_PROXY_ENDPOINT = 'proxy.example.internal';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { verifySessionScope } = require('../socket-server/session-auth.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { authorizeSessionRequest, VOICE_DISABLED_ERROR } = require('../socket-server/session-guard.js');

const SESSION = '55555555-5555-4555-8555-555555555555';
const PATIENT = '33333333-3333-4333-8333-333333333333';
const GROUP = '11111111-1111-4111-8111-111111111111';
const EMAIL = 'student@example.edu';

function rowsReturn(rows: unknown[]): void {
  mockSql.mockResolvedValueOnce(rows);
}

beforeEach(() => {
  mockSql.mockReset();
});

describe('verifySessionScope voice switches', () => {
  const voice = { requireVoiceEnabled: true };

  test('allows a voice session when both switches are on', async () => {
    rowsReturn([{ voice_enabled: true, instructor_voice_enabled: true }]);
    await expect(verifySessionScope(SESSION, PATIENT, GROUP, EMAIL, voice)).resolves.toEqual({
      authorized: true,
    });
  });

  test('treats NULL switches as enabled, like the column defaults', async () => {
    rowsReturn([{ voice_enabled: null, instructor_voice_enabled: null }]);
    await expect(verifySessionScope(SESSION, PATIENT, GROUP, EMAIL, voice)).resolves.toEqual({
      authorized: true,
    });
  });

  test.each([
    ['persona voice_enabled', { voice_enabled: false, instructor_voice_enabled: true }],
    ['group instructor_voice_enabled', { voice_enabled: true, instructor_voice_enabled: false }],
  ])('denies a voice session when %s is false', async (_label, row) => {
    rowsReturn([row]);
    await expect(verifySessionScope(SESSION, PATIENT, GROUP, EMAIL, voice)).resolves.toEqual({
      authorized: false,
      reason: 'voice_disabled',
    });
  });

  test('ignores the switches when the voice check is not requested (text sessions)', async () => {
    rowsReturn([{ voice_enabled: false, instructor_voice_enabled: false }]);
    await expect(verifySessionScope(SESSION, PATIENT, GROUP, EMAIL)).resolves.toEqual({
      authorized: true,
    });
  });

  test('denies when the session does not bind to the caller, persona and group', async () => {
    rowsReturn([]);
    await expect(verifySessionScope(SESSION, PATIENT, GROUP, EMAIL, voice)).resolves.toEqual({
      authorized: false,
    });
  });

  test('fails closed when the query errors', async () => {
    mockSql.mockRejectedValueOnce(new Error('db down'));
    await expect(verifySessionScope(SESSION, PATIENT, GROUP, EMAIL, voice)).resolves.toEqual({
      authorized: false,
    });
  });
});

describe('authorizeSessionRequest voice denial message', () => {
  const params = { userEmail: EMAIL, sessionId: SESSION, patientId: PATIENT, simulationGroupId: GROUP };

  test('reports voice being disabled instead of an ownership failure', async () => {
    const verify = jest.fn().mockResolvedValue({ authorized: false, reason: 'voice_disabled' });
    await expect(authorizeSessionRequest(params, verify)).resolves.toEqual({
      allowed: false,
      error: VOICE_DISABLED_ERROR,
    });
  });

  test('keeps the ownership message for other denials', async () => {
    const verify = jest.fn().mockResolvedValue({ authorized: false });
    const result = await authorizeSessionRequest(params, verify);
    expect(result.allowed).toBe(false);
    expect(result.error).not.toBe(VOICE_DISABLED_ERROR);
  });
});

describe('server.js wiring', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'socket-server', 'server.js'), 'utf8');

  function eventBlock(event: string): string {
    const start = server.indexOf(`\n  on("${event}"`);
    if (start === -1) throw new Error(`event not found: ${event}`);
    const next = server.slice(start + 1).search(/\n  (socket\.)?on\(/);
    return server.slice(start, next === -1 ? undefined : start + 1 + next);
  }

  test('start-nova-sonic requires voice to be enabled', () => {
    expect(eventBlock('start-nova-sonic')).toMatch(/requireVoiceEnabled:\s*true/);
  });

  test('text-generation does not apply the voice switches', () => {
    expect(eventBlock('text-generation')).not.toMatch(/requireVoiceEnabled/);
  });
});
