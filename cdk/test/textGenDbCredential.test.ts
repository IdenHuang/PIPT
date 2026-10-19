/**
 * The text-generation Lambda must connect as the least-privilege app_rw user
 * (db.secretPathUser), not the RDS master credential, and may read only that
 * DB secret (plus the stream callback secret granted via grantRead).
 */

import * as fs from 'fs';
import * as path from 'path';

const stack = fs.readFileSync(path.join(__dirname, '..', 'lib', 'api-service-stack.ts'), 'utf8');

function textGenBlock(): string {
  const start = stack.indexOf('const textGenLambdaDockerFunc = new lambda.DockerImageFunction(');
  const end = stack.indexOf('// Grant access to DynamoDB actions', start);
  if (start === -1 || end === -1) throw new Error('text-gen Lambda block not found');
  return stack.slice(start, end);
}

describe('text-generation Lambda DB credential', () => {
  const block = textGenBlock();

  test('uses the app_rw user secret, not the master credential', () => {
    expect(block).toMatch(/SM_DB_CREDENTIALS:\s*db\.secretPathUser\.secretName/);
    expect(block).not.toContain('secretPathAdminName');
  });

  test('Secrets Manager access is scoped to the user secret, not secret:*', () => {
    expect(block).toMatch(/actions:\s*\["secretsmanager:GetSecretValue"\],\s*resources:\s*\[db\.secretPathUser\.secretArn\]/);
    expect(block).not.toMatch(/secretsmanager:\$\{this\.region\}:\$\{this\.account\}:secret:\*/);
  });

  test('the stream callback secret is still readable', () => {
    expect(block).toContain('this.streamCallbackSecret.grantRead(textGenLambdaDockerFunc)');
  });
});
