/**
 * The readwrite (app_rw) privilege check must fail closed at deploy time and
 * raise an alarm at ingest time (finding f-cb881fa5 / f-a135d08b).
 */

import * as fs from 'fs';
import * as path from 'path';

// db_setup's runtime deps come from a Lambda layer, not cdk/node_modules.
jest.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: jest.fn(),
  GetSecretValueCommand: jest.fn(),
  PutSecretValueCommand: jest.fn(),
}), { virtual: true });
jest.mock('pg', () => ({ Client: jest.fn() }), { virtual: true });
jest.mock('node-pg-migrate', () => ({ default: jest.fn() }), { virtual: true });

// eslint-disable-next-line @typescript-eslint/no-var-requires
const dbSetup = require('../lambda/db_setup/index.js');

describe('db_setup forbidden-privilege check', () => {
  let errorSpy: jest.SpyInstance;
  beforeEach(() => { errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {}); });
  afterEach(() => errorSpy.mockRestore());

  test('passes when no forbidden privileges remain', () => {
    expect(() => dbSetup.assertNoForbiddenPrivileges([])).not.toThrow();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  test('throws, naming the offending privileges, when any remain', () => {
    const rows = [
      { tbl: 'langchain_pg_embedding', priv: 'UPDATE' },
      { tbl: 'upsertion_record', priv: 'SELECT' },
    ];
    expect(() => dbSetup.assertNoForbiddenPrivileges(rows))
      .toThrow(/langchain_pg_embedding:UPDATE, upsertion_record:SELECT/);
    expect(errorSpy).toHaveBeenCalled();
  });

  test('the verification result is passed to the assertion, not just logged', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lambda', 'db_setup', 'index.js'), 'utf8');
    expect(src).toMatch(
      /await tcClient\.query\(READWRITE_FORBIDDEN_PRIVILEGES_SQL\);\s*assertNoForbiddenPrivileges\(rows\);/,
    );
  });
});

describe('db_setup per-table readwrite grants (no blanket grants)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lambda', 'db_setup', 'index.js'), 'utf8');
  const migrationsDir = path.join(__dirname, '..', 'lambda', 'db_setup', 'migrations');

  function migrationTables(): string[] {
    const names = new Set<string>();
    for (const f of fs.readdirSync(migrationsDir)) {
      const text = fs.readFileSync(path.join(migrationsDir, f), 'utf8');
      // Require the column list so prose like "uses CREATE TABLE IF NOT EXISTS, ..." doesn't match.
      for (const m of text.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?\s*\(/gi)) {
        names.add(m[1].toLowerCase());
      }
      for (const m of text.matchAll(/createTable\(\s*['"]([a-z_][a-z0-9_]*)/gi)) names.add(m[1].toLowerCase());
    }
    return [...names].sort();
  }

  test('every table a migration creates has an explicit app_rw entry', () => {
    // A missing entry means app_rw gets "permission denied" on that table.
    const tables = migrationTables();
    expect(tables.length).toBeGreaterThan(20);
    const missing = tables.filter((t) => !(t in dbSetup.APPLICATION_TABLE_PRIVILEGES));
    expect(missing).toEqual([]);
  });

  test('vectorstore and bookkeeping tables stay narrowed', () => {
    const rw = dbSetup.READWRITE_TABLE_PRIVILEGES;
    expect(rw.langchain_pg_collection).toBe('SELECT, INSERT');
    expect(rw.langchain_pg_embedding).toBe('SELECT, DELETE');
    expect(rw).not.toHaveProperty('upsertion_record');
    expect(rw).not.toHaveProperty('pgmigrations');
  });

  test('tables app_rw never writes are read-only', () => {
    for (const t of ['organizations', 'group_instructors', 'rubrics', 'key_questions', 'feedback', 'system_prompt_history']) {
      expect(dbSetup.APPLICATION_TABLE_PRIVILEGES[t]).toBe('SELECT');
    }
  });

  test('no blanket ON ALL TABLES grant or default table grant to readwrite', () => {
    expect(src).not.toMatch(/ON ALL TABLES IN SCHEMA public TO readwrite/);
    // Only app_tc's own default (SELECT on tables it creates) may grant readwrite anything.
    const defaultGrants = src.match(/ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT [^;]* ON TABLES TO readwrite/g) || [];
    expect(defaultGrants).toEqual(['ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO readwrite']);
    expect(src).toContain('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM readwrite;');
    // ON ALL TABLES fails once app_tc owns tables the admin can't grant on.
    expect(src).not.toMatch(/GRANT [^;]*ON ALL (TABLES|SEQUENCES) IN SCHEMA/);
  });

  test('narrowing SQL only accepts known privileges and plain table names', () => {
    expect(() => dbSetup.readwriteNarrowingSql({ chats: 'SELECT; DROP TABLE users' })).toThrow();
    expect(() => dbSetup.readwriteNarrowingSql({ 'bad"name': 'SELECT' })).toThrow();
    const sql = dbSetup.readwriteNarrowingSql({ chats: 'SELECT, INSERT' });
    expect(sql).toContain("('chats', 'SELECT, INSERT')");
    expect(sql).toContain('c.relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)');
  });
});

describe('data ingestion readwrite privilege alarm', () => {
  const stack = fs.readFileSync(path.join(__dirname, '..', 'lib', 'api-service-stack.ts'), 'utf8');
  const helper = fs.readFileSync(
    path.join(__dirname, '..', 'data_ingestion', 'src', 'helpers', 'helper.py'), 'utf8');

  test('metric filter matches the marker the Python helper logs', () => {
    expect(helper).toContain('READWRITE_PRIVILEGE_CHECK_FAILED = "READWRITE_PRIVILEGE_CHECK_FAILED"');
    expect(stack).toContain('logs.FilterPattern.literal("READWRITE_PRIVILEGE_CHECK_FAILED")');
    expect(stack).toContain('`${id}-ReadwritePrivilegeCheckAlarm`');
  });

  test('timeout handler rule is scoped to the timeout alarm only', () => {
    const start = stack.indexOf('`${id}-DataIngestLambdaTimeoutRule`');
    const block = stack.slice(start, stack.indexOf('});', start));
    expect(block).toContain('resources: [timeoutAlarm.alarmArn]');
  });
});
