/**
 * Voice session prompt source (finding f-61fd93f7):
 *   - patient-context.js fetchPatientContext fails closed and never falls back
 *   - server.js uses only the server-fetched context, never client prompt fields
 *   - OpenAPI declares /student/patient_context behind studentAuthorizer
 */

import * as fs from 'fs';
import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { fetchPatientContext } = require('../socket-server/patient-context.js');

const GROUP = '11111111-1111-4111-8111-111111111111';
const PATIENT = '33333333-3333-4333-8333-333333333333';
const ENDPOINT = 'https://api.example.com/prod/';
const TOKEN = 'id-token';

const args = (overrides: Record<string, unknown> = {}) => ({
  endpoint: ENDPOINT,
  simulationGroupId: GROUP,
  patientId: PATIENT,
  token: TOKEN,
  ...overrides,
});

const okResponse = (body: unknown) =>
  jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => body });

const PERSONA = {
  system_prompt: 'group rules',
  persona_name: 'Jane',
  persona_age: 40,
  persona_prompt: 'text persona',
  voice_persona_prompt: 'voice persona',
  llm_completion: true,
};

describe('fetchPatientContext', () => {
  test('returns the server persona, preferring the voice prompt', async () => {
    const fetchImpl = okResponse(PERSONA);
    const result = await fetchPatientContext(args(), fetchImpl);
    expect(result).toEqual({
      ok: true,
      context: {
        patient_name: 'Jane',
        patient_prompt: 'voice persona',
        system_prompt: 'group rules',
        llm_completion: true,
      },
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      `https://api.example.com/prod/student/patient_context?simulation_group_id=${GROUP}&patient_id=${PATIENT}`,
      { headers: { Authorization: TOKEN } },
    );
  });

  test('falls back to persona_prompt only from the server body', async () => {
    const result = await fetchPatientContext(
      args(),
      okResponse({ ...PERSONA, voice_persona_prompt: null }),
    );
    expect(result.context.patient_prompt).toBe('text persona');
  });

  test('llm_completion is true only for a boolean true', async () => {
    const result = await fetchPatientContext(
      args(),
      okResponse({ ...PERSONA, llm_completion: 'true' }),
    );
    expect(result.context.llm_completion).toBe(false);
  });

  test.each([
    ['endpoint_not_configured', { endpoint: '' }],
    ['missing_ids', { simulationGroupId: undefined }],
    ['missing_ids', { patientId: 42 }],
    ['missing_token', { token: '' }],
  ])('rejects bad inputs without fetching (%s)', async (reason, overrides) => {
    const fetchImpl = jest.fn();
    const result = await fetchPatientContext(args(overrides), fetchImpl);
    expect(result).toEqual({ ok: false, reason });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test.each([403, 404, 500])('fails closed on HTTP %i', async (status) => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: false, status, json: async () => ({}) });
    expect(await fetchPatientContext(args(), fetchImpl)).toEqual({ ok: false, reason: `http_${status}` });
  });

  test('fails closed on a network error', async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error('ECONNRESET'));
    expect(await fetchPatientContext(args(), fetchImpl)).toEqual({ ok: false, reason: 'fetch_error' });
  });

  test.each([[null], [{}], [{ persona_prompt: 'x' }]])('fails closed on an unusable body %#', async (body) => {
    expect(await fetchPatientContext(args(), okResponse(body))).toEqual({ ok: false, reason: 'invalid_body' });
  });
});

describe('server.js and API wiring', () => {
  const root = path.join(__dirname, '..');
  const server = fs.readFileSync(path.join(root, 'socket-server', 'server.js'), 'utf8');
  const dockerfile = fs.readFileSync(path.join(root, 'socket-server', 'Dockerfile'), 'utf8');
  const spec = fs.readFileSync(path.join(root, 'OpenAPI_Swagger_Definition.yaml'), 'utf8');

  test('never reads client-supplied prompt fields', () => {
    expect(server).not.toMatch(/config\.(patient_prompt|system_prompt|patient_name|llm_completion)\b(?!\s*\/)/);
    expect(server).not.toMatch(/\|\|\s*config\.(patient_prompt|system_prompt|patient_name|llm_completion)/);
    expect(server).not.toMatch(/EXTRA_SYSTEM_PROMPT:\s*config\./);
    expect(server).not.toMatch(/PATIENT_PROMPT:[ \t]*(?!voiceContext\.)\S/);
  });

  test('aborts start-nova-sonic when the context cannot be loaded', () => {
    expect(server).toMatch(/const patientContext = await fetchPatientContext\(/);
    expect(server).toMatch(/if \(!patientContext\.ok\) \{[\s\S]{0,400}?socket\.emit\("nova-error"[\s\S]{0,120}?return;/);
    // The fetch runs before both the AgentCore and local child-process paths.
    const fetchAt = server.indexOf('fetchPatientContext({');
    const agentCoreAt = server.search(/if \(VOICE_AGENT_ARN\) \{\s*console\.log\("🔀/);
    expect(fetchAt).toBeGreaterThan(-1);
    expect(agentCoreAt).toBeGreaterThan(fetchAt);
  });

  test('the module is shipped in the container image', () => {
    expect(dockerfile).toMatch(/^COPY patient-context\.js \.\/\r?$/m);
  });

  test('OpenAPI declares GET /student/patient_context behind studentAuthorizer -> studentFunction', () => {
    const m = spec.match(/\n {2}\/student\/patient_context:\r?\n([\s\S]*?)(?=\r?\n {2}\/)/);
    expect(m).toBeTruthy();
    const block = m![1];
    expect(block).toMatch(/(^|\n) {4}get:/);
    expect(block).toContain('- studentAuthorizer: []');
    expect(block).toContain('${studentFunction.Arn}');
    expect(block).toContain('type: "aws_proxy"');
  });
});
