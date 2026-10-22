/**
 * Secrets Manager access must be scoped to the specific secrets each role reads.
 * A grant on `arn:aws:secretsmanager:<region>:<account>:secret:*` lets a function
 * read every secret in the account (admin DB credential, GitHub PAT, CloudFront
 * signing key, other deployments' secrets), so none may exist in any stack.
 */

import * as fs from 'fs';
import * as path from 'path';

const libDir = path.join(__dirname, '..', 'lib');
const stackFiles = fs.readdirSync(libDir).filter((f) => f.endsWith('-stack.ts'));
const read = (file: string) => fs.readFileSync(path.join(libDir, file), 'utf8');

/** Returns the source of every `new iam.PolicyStatement(...)` call, parens balanced. */
function policyStatements(src: string): string[] {
  const marker = 'new iam.PolicyStatement(';
  const out: string[] = [];
  let start = src.indexOf(marker);
  while (start !== -1) {
    let depth = 0;
    let end = start + marker.length - 1;
    for (; end < src.length; end++) {
      if (src[end] === '(') depth++;
      else if (src[end] === ')' && --depth === 0) break;
    }
    out.push(src.slice(start, end + 1));
    start = src.indexOf(marker, end);
  }
  return out;
}

const secretsStatements = (file: string) =>
  policyStatements(read(file)).filter((s) => s.includes('secretsmanager:'));

describe('Secrets Manager IAM scope', () => {
  test('stack files were found', () => {
    expect(stackFiles.length).toBeGreaterThan(0);
  });

  test.each(stackFiles)('%s grants no wildcard Secrets Manager resources', (file) => {
    const src = read(file);
    expect(src).not.toMatch(/:secret:\*/);
    expect(src).not.toMatch(/secretsmanager:\*/);
    for (const statement of secretsStatements(file)) {
      expect(statement).not.toMatch(/resources:\s*\[\s*["']\*["']\s*\]/);
    }
  });

  test('PutSecretValue is granted only to the DBFlow migration role, on the app user secrets', () => {
    for (const file of stackFiles.filter((f) => f !== 'dbFlow-stack.ts')) {
      expect(read(file)).not.toContain('secretsmanager:PutSecretValue');
    }
    const put = secretsStatements('dbFlow-stack.ts').filter((s) => s.includes('PutSecretValue'));
    expect(put).toHaveLength(1);
    expect(put[0]).not.toContain('GetSecretValue');
    expect(put[0]).toMatch(
      /resources:\s*\[\s*db\.secretPathUser\.secretArn,\s*db\.secretPathTableCreator\.secretArn,?\s*\]/
    );
  });

  test('DBFlow reads only the admin secret, matched by name plus the 6-character suffix', () => {
    const src = read('dbFlow-stack.ts');
    expect(src).toContain(':secret:${db.secretPathAdminName}-??????`');
    const get = secretsStatements('dbFlow-stack.ts').filter((s) => s.includes('GetSecretValue'));
    expect(get).toHaveLength(1);
    expect(get[0]).toMatch(/resources:\s*\[adminSecretArn\]/);
  });

  test('the CloudFront signing key is referenced by name plus the 6-character suffix', () => {
    expect(read('api-service-stack.ts')).toContain(
      ':secret:${stackPrefix}/CloudFrontSigningKey-??????`'
    );
  });

  test('the ECS socket task role cannot assume arbitrary roles', () => {
    expect(read('ecs-socket-stack.ts')).not.toContain('sts:AssumeRole"');
  });
});
