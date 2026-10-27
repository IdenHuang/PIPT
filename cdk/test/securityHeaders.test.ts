/**
 * Secure-by-default controls (finding f-ae0e72c9):
 *   - SPA security headers / CSP built for Amplify
 *   - WAF body rules that replace the Count-mode managed rules
 *   - Guardrail PII policy and fixed gateway error messages
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  FRONTEND_IFRAME_DOMAINS,
  buildAmplifyCustomHeaders,
  buildContentSecurityPolicy,
} from '../lib/security-headers';

const root = path.join(__dirname, '..');
const read = (...p: string[]) => fs.readFileSync(path.join(root, ...p), 'utf8');

const HOSTS = {
  region: 'ca-central-1',
  apiHost: 'abc123.execute-api.ca-central-1.amazonaws.com',
  appSyncApiId: 'gql123',
  socketHost: 'd111.cloudfront.net',
  docsHost: 'd222.cloudfront.net',
  uploadBucketName: 'pipt-docs-bucket',
};

const directive = (csp: string, name: string): string[] => {
  const entry = csp.split('; ').find((d) => d.startsWith(name + ' '));
  if (!entry) throw new Error(`missing ${name}`);
  return entry.split(' ').slice(1);
};

describe('Content-Security-Policy', () => {
  const csp = buildContentSecurityPolicy(HOSTS);

  test('locks down script, object, base and framing', () => {
    expect(directive(csp, 'script-src')).toEqual(["'self'", 'blob:']);
    expect(directive(csp, 'object-src')).toEqual(["'none'"]);
    expect(directive(csp, 'base-uri')).toEqual(["'self'"]);
    expect(directive(csp, 'frame-ancestors')).toEqual(["'none'"]);
    expect(csp).not.toContain("'unsafe-eval'");
    expect(directive(csp, 'script-src')).not.toContain("'unsafe-inline'");
  });

  test('allows exactly the backends the SPA talks to', () => {
    expect(directive(csp, 'connect-src')).toEqual(
      expect.arrayContaining([
        'https://abc123.execute-api.ca-central-1.amazonaws.com',
        'https://gql123.appsync-api.ca-central-1.amazonaws.com',
        'wss://gql123.appsync-realtime-api.ca-central-1.amazonaws.com',
        'wss://d111.cloudfront.net',
        'https://cognito-idp.ca-central-1.amazonaws.com',
        'https://pipt-docs-bucket.s3.amazonaws.com',
        'https://d222.cloudfront.net',
      ])
    );
    expect(directive(csp, 'connect-src').some((s) => s.includes('*'))).toBe(false);
  });

  test('frame-src covers every frontend embed host and its subdomains', () => {
    const frameSrc = directive(csp, 'frame-src');
    expect(frameSrc).toContain('https://d222.cloudfront.net');
    for (const domain of FRONTEND_IFRAME_DOMAINS) {
      const covered = frameSrc.some(
        (s) => s === `https://${domain}` || (s.startsWith('https://*.') && domain.endsWith(s.slice('https://*'.length)))
      );
      expect(covered).toBe(true);
    }
    expect(frameSrc).toContain('https://*.panopto.com');
  });

  test('embed host list matches the frontend allowlist', () => {
    const src = read('..', 'frontend', 'src', 'lib', 'embedSafety.ts');
    const block = src.slice(src.indexOf('ALLOWED_IFRAME_DOMAINS'), src.indexOf('];', src.indexOf('ALLOWED_IFRAME_DOMAINS')));
    const frontendDomains = [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect([...FRONTEND_IFRAME_DOMAINS].sort()).toEqual(frontendDomains.sort());
  });
});

describe('Amplify custom headers', () => {
  test('report-only by default, enforcing when asked, with YAML-escaped quotes', () => {
    const reportOnly = buildAmplifyCustomHeaders("default-src 'self'", false);
    expect(reportOnly).toContain("key: 'Content-Security-Policy-Report-Only'");
    expect(reportOnly).toContain("value: 'default-src ''self'''");
    expect(reportOnly).toContain("key: 'Strict-Transport-Security'");
    expect(reportOnly).toContain("key: 'X-Content-Type-Options'");
    expect(reportOnly).toContain("key: 'X-Frame-Options'");

    const enforced = buildAmplifyCustomHeaders("default-src 'self'", true);
    expect(enforced).toContain("key: 'Content-Security-Policy'");
    expect(enforced).not.toContain('Report-Only');
  });

  test('the Amplify app is wired to the headers', () => {
    const stack = read('lib', 'amplify-stack.ts');
    expect(stack).toContain('customHeaders: buildAmplifyCustomHeaders(contentSecurityPolicy, enforceCsp)');
  });
});

describe('API stack wiring', () => {
  const stack = read('lib', 'api-service-stack.ts');
  const spec = read('OpenAPI_Swagger_Definition.yaml');

  test('WAF blocks oversize and XSS bodies with narrow exemptions', () => {
    expect(stack).toMatch(/name: "BlockOversizedBody",\s*priority: \d+,\s*action: \{ block: \{\} \}/);
    expect(stack).toMatch(/name: "BlockXssBody",\s*priority: \d+,\s*action: \{ block: \{\} \}/);
    expect(stack).toContain('wafUriPathIs("/instructor/persona_media", "ENDS_WITH")');
    expect(stack).toContain('API_GATEWAY: { defaultSizeInspectionLimit: "KB_64" }');
  });

  test('guardrail blocks non-persona PII', () => {
    expect(stack).toContain('sensitiveInformationPolicyConfig');
    expect(stack).toMatch(/"EMAIL",[\s\S]*"CREDIT_DEBIT_CARD_NUMBER"[\s\S]*action: "BLOCK"/);
  });

  test('gateway responses never echo the internal error message', () => {
    expect(spec).not.toMatch(/"message":\s*\$context\.error\.messageString/);
  });
});
