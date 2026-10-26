/**
 * Authentication hardening (finding f-dd4c3c7f, plus the PRE_SIGN_UP domain check):
 *   - jwtAuthorizer: ID-token claims, prefix-scoped policy, DB role gate
 *   - socket relay: data.token verified and bound to the handshake identity
 *   - preSignup: exactly one "@", case-insensitive domain match
 *   - stack/spec wiring for the above and the Cognito pool settings
 */

import * as fs from 'fs';
import * as path from 'path';

jest.mock(
  '@aws-sdk/client-ssm',
  () => ({ SSMClient: jest.fn(() => ({ send: jest.fn() })), GetParameterCommand: jest.fn() }),
  { virtual: true }
);

/* eslint-disable @typescript-eslint/no-require-imports */
const authorizer = require('../lambda/jwtAuthorizer/jwtAuthorizer.js');
const { resolveRelayToken } = require('../socket-server/relay-token.js');
const { _extractEmailDomain: extractEmailDomain } = require('../lambda/lib/preSignup.js');
/* eslint-enable @typescript-eslint/no-require-imports */

const METHOD_ARN = 'arn:aws:execute-api:ca-central-1:123456789012:abc123/prod/GET/admin/users';
const SUB = '11111111-1111-4111-8111-111111111111';
const EMAIL = 'user@example.edu';

const idPayload = (overrides: Record<string, unknown> = {}) => ({
  sub: SUB,
  email: EMAIL,
  email_verified: true,
  token_use: 'id',
  ...overrides,
});

const deps = (overrides: Record<string, unknown> = {}) => ({
  verify: jest.fn().mockResolvedValue(idPayload()),
  getRoles: jest.fn().mockResolvedValue(['admin']),
  routePrefix: 'admin',
  requiredRoles: ['admin'],
  ...overrides,
});

const event = { authorizationToken: 'header.payload.sig', methodArn: METHOD_ARN };

describe('jwtAuthorizer claim checks', () => {
  test.each([
    ['access token', { token_use: 'access' }],
    ['missing token_use', { token_use: undefined }],
    ['unverified email', { email_verified: false }],
    ['missing email_verified', { email_verified: undefined }],
    ['missing email', { email: undefined }],
    ['missing sub', { sub: undefined }],
  ])('rejects %s', (_label, overrides) => {
    expect(() => authorizer._assertIdTokenClaims(idPayload(overrides))).toThrow('Unauthorized');
  });

  test('returns the verified email and never falls back to sub', () => {
    expect(authorizer._assertIdTokenClaims(idPayload())).toBe(EMAIL);
  });
});

describe('jwtAuthorizer policy scope', () => {
  test('scopes the resource to the deployment prefix, all methods', () => {
    expect(authorizer._buildScopedResource(METHOD_ARN, 'admin')).toBe(
      'arn:aws:execute-api:ca-central-1:123456789012:abc123/prod/*/admin/*'
    );
    expect(authorizer._buildScopedResource(METHOD_ARN, 'student')).toBe(
      'arn:aws:execute-api:ca-central-1:123456789012:abc123/prod/*/student/*'
    );
  });

  test.each([undefined, '', 'everything', '*'])('fails closed for route prefix %p', (prefix) => {
    expect(() => authorizer._buildScopedResource(METHOD_ARN, prefix)).toThrow('Unauthorized');
  });

  test('fails closed for a malformed methodArn', () => {
    expect(() => authorizer._buildScopedResource('not-an-arn', 'admin')).toThrow('Unauthorized');
  });
});

describe('jwtAuthorizer role gate', () => {
  test('parses REQUIRED_ROLES', () => {
    expect(authorizer._parseRequiredRoles(' instructor, admin ,')).toEqual(['instructor', 'admin']);
    expect(authorizer._parseRequiredRoles(undefined)).toEqual([]);
  });

  test('allows with a scoped resource and verified context when the role is held', async () => {
    const d = deps();
    const { decision, policy } = await authorizer._authorize(event, d);
    expect(decision).toBe('Allow');
    expect(policy.policyDocument.Statement[0]).toEqual({
      Action: 'execute-api:Invoke',
      Effect: 'Allow',
      Resource: 'arn:aws:execute-api:ca-central-1:123456789012:abc123/prod/*/admin/*',
    });
    expect(policy.context).toEqual({ userId: SUB, email: EMAIL });
    expect(d.getRoles).toHaveBeenCalledWith(EMAIL);
  });

  test('denies a student token on the admin surface', async () => {
    const { decision, policy } = await authorizer._authorize(
      event,
      deps({ getRoles: jest.fn().mockResolvedValue(['student']) })
    );
    expect(decision).toBe('Deny');
    expect(policy.policyDocument.Statement[0].Effect).toBe('Deny');
    expect(policy.context).toBeUndefined();
  });

  test('denies a user with no DB row', async () => {
    const { decision } = await authorizer._authorize(event, deps({ getRoles: jest.fn().mockResolvedValue([]) }));
    expect(decision).toBe('Deny');
  });

  test('instructor surface accepts instructor or admin', async () => {
    for (const roles of [['instructor'], ['admin']]) {
      const { decision } = await authorizer._authorize(
        event,
        deps({ routePrefix: 'instructor', requiredRoles: ['instructor', 'admin'], getRoles: jest.fn().mockResolvedValue(roles) })
      );
      expect(decision).toBe('Allow');
    }
  });

  test('student surface does not query the database', async () => {
    const d = deps({ routePrefix: 'student', requiredRoles: [] });
    const { decision } = await authorizer._authorize(event, d);
    expect(decision).toBe('Allow');
    expect(d.getRoles).not.toHaveBeenCalled();
  });

  test('fails closed when the role lookup throws', async () => {
    await expect(
      authorizer._authorize(event, deps({ getRoles: jest.fn().mockRejectedValue(new Error('db down')) }))
    ).rejects.toThrow('db down');
  });

  test('rejects an access token before any role lookup', async () => {
    const d = deps({ verify: jest.fn().mockResolvedValue(idPayload({ token_use: 'access' })) });
    await expect(authorizer._authorize(event, d)).rejects.toThrow('Unauthorized');
    expect(d.getRoles).not.toHaveBeenCalled();
  });

  test('rejects an empty Authorization header', async () => {
    await expect(authorizer._authorize({ ...event, authorizationToken: '' }, deps())).rejects.toThrow('Unauthorized');
  });
});

describe('socket relay token', () => {
  const identity = { userId: SUB, userEmail: EMAIL };

  test('forwards a verified token belonging to the socket user', async () => {
    const verify = jest.fn().mockResolvedValue(idPayload());
    await expect(resolveRelayToken('tok', identity, verify)).resolves.toEqual({ ok: true, token: 'tok' });
    expect(verify).toHaveBeenCalledWith('tok');
  });

  test('rejects a valid token for a different user', async () => {
    const verify = jest.fn().mockResolvedValue(idPayload({ sub: 'someone-else', email: 'other@example.edu' }));
    await expect(resolveRelayToken('tok', identity, verify)).resolves.toMatchObject({ ok: false });
  });

  test('rejects a token whose email differs from the handshake email', async () => {
    const verify = jest.fn().mockResolvedValue(idPayload({ email: 'other@example.edu' }));
    await expect(resolveRelayToken('tok', identity, verify)).resolves.toMatchObject({ ok: false });
  });

  test('rejects a token that fails verification', async () => {
    const verify = jest.fn().mockRejectedValue(new Error('bad signature'));
    await expect(resolveRelayToken('tok', identity, verify)).resolves.toMatchObject({ ok: false });
  });

  test.each([undefined, null, '', 42])('rejects missing token %p without verifying', async (token) => {
    const verify = jest.fn();
    await expect(resolveRelayToken(token, identity, verify)).resolves.toMatchObject({ ok: false });
    expect(verify).not.toHaveBeenCalled();
  });
});

describe('preSignup domain extraction', () => {
  test.each([
    ['user@allowed.edu', 'allowed.edu'],
    ['User@ALLOWED.EDU', 'allowed.edu'],
    ['  user@allowed.edu ', 'allowed.edu'],
  ])('%p -> %p', (email, domain) => {
    expect(extractEmailDomain(email)).toBe(domain);
  });

  test.each(['attacker@allowed.edu@evil.com', 'no-at-sign', '@allowed.edu', 'user@', '', undefined, 7])(
    'rejects %p',
    (email) => {
      expect(extractEmailDomain(email)).toBeNull();
    }
  );
});

describe('stack and spec wiring', () => {
  const root = path.join(__dirname, '..');
  const stack = fs.readFileSync(path.join(root, 'lib', 'api-service-stack.ts'), 'utf8');
  const spec = fs.readFileSync(path.join(root, 'OpenAPI_Swagger_Definition.yaml'), 'utf8');
  const server = fs.readFileSync(path.join(root, 'socket-server', 'server.js'), 'utf8');
  const dockerfile = fs.readFileSync(path.join(root, 'socket-server', 'Dockerfile'), 'utf8');

  test.each([
    ['student', 'ROUTE_PREFIX: "student"', null],
    ['instructor', 'ROUTE_PREFIX: "instructor"', 'REQUIRED_ROLES: "instructor,admin"'],
    ['admin', 'ROUTE_PREFIX: "admin"', 'REQUIRED_ROLES: "admin"'],
  ])('%s authorizer is configured for its own surface', (role, prefix, required) => {
    const start = stack.indexOf(`${role}-authorization-api-gateway`);
    const block = stack.slice(start, stack.indexOf(`${role}LambdaAuthorizer\`,`, start));
    expect(block).toContain(prefix);
    if (required) {
      expect(block).toContain(required);
      expect(block).toContain('vpc: vpcStack.vpc');
      expect(block).toContain('SM_DB_CREDENTIALS: db.secretPathUser.secretName');
    } else {
      expect(block).not.toMatch(/^\s*REQUIRED_ROLES:/m);
      expect(block).not.toContain('vpc: vpcStack.vpc');
    }
  });

  test('every route uses the authorizer matching its path prefix', () => {
    const re = /^ {2}\/(\w+)\/[^\n]*:\n([\s\S]*?)(?=^ {2}\/|^components:)/gm;
    let m: RegExpExecArray | null;
    let checked = 0;
    while ((m = re.exec(spec.replace(/\r\n/g, '\n')))) {
      for (const sec of m[2].matchAll(/- (\w+)Authorizer: \[\]/g)) {
        expect(`${m[1]}:${sec[1]}`).toBe(`${m[1]}:${m[1]}`);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  test('Cognito pool and client hardening is in place', () => {
    expect(stack).toContain('keepOriginal: { email: true }');
    expect(stack).toContain('mfa: cognito.Mfa.OPTIONAL');
    expect(stack).toContain('preventUserExistenceErrors: true');
    expect(stack).toMatch(/userPassword: false,\s*custom: false,\s*userSrp: true/);
  });

  test('the socket relay never forwards data.token directly', () => {
    expect(server).not.toMatch(/Authorization:\s*data\.token/);
    expect(server).toContain('resolveRelayToken(');
    expect(dockerfile).toContain('COPY relay-token.js ./');
  });
});
