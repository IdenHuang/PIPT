const {
  SecretsManagerClient,
  GetSecretValueCommand,
  PutSecretValueCommand,
} = require("@aws-sdk/client-secrets-manager");
const { Client } = require("pg");
const crypto = require("crypto");
const path = require("path");
const migrate = require("node-pg-migrate").default;

const sm = new SecretsManagerClient();

async function getSecret(name) {
  const data = await sm.send(new GetSecretValueCommand({ SecretId: name }));
  return JSON.parse(data.SecretString);
}

async function putSecret(name, secret) {
  await sm.send(
    new PutSecretValueCommand({
      SecretId: name,
      SecretString: JSON.stringify(secret),
    }),
  );
}

async function runMigrations(db) {
  const client = new Client({
    user: db.username,
    password: db.password,
    host: db.host,
    port: db.port || 5432,
    database: db.dbname,
    // Verify the server certificate. The RDS CA is trusted via
    // NODE_EXTRA_CA_CERTS=/var/runtime/ca-cert.pem (set in dbFlow-stack.ts).
    ssl: { rejectUnauthorized: true },
  });
  await client.connect();
  try {
    await migrate({
      dbClient: client,
      dir: path.join(__dirname, "migrations"),
      direction: "up",
      count: Infinity,
      migrationsTable: "pgmigrations",
      logger: console,
      createSchema: false,
    });
  } finally {
    await client.end();
  }
}

async function createAppUsers(
  adminDb,
  dbSecretName,
  userSecretName,
  proxySecretName,
) {
  const adminClient = new Client({
    user: adminDb.username,
    password: adminDb.password,
    host: adminDb.host,
    database: adminDb.dbname, // target DB
    port: adminDb.port || 5432,
    // Verify the server certificate (see runMigrations): this client handles the
    // admin credentials and writes the rotated app passwords.
    ssl: { rejectUnauthorized: true },
  });
  await adminClient.connect();

  // Stable usernames; rotate passwords idempotently
  const RW_NAME = "app_rw";
  const TC_NAME = "app_tc";
  const rwPass = crypto.randomBytes(16).toString("hex");
  const tcPass = crypto.randomBytes(16).toString("hex");

  // Safe quoting for DB identifier inside SQL
  const dbIdent = adminDb.dbname.replace(/"/g, '""');

  const sql = `
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'readwrite') THEN
        CREATE ROLE readwrite;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tablecreator') THEN
        CREATE ROLE tablecreator;
      END IF;
    END$$;

    GRANT CONNECT ON DATABASE "${dbIdent}" TO readwrite;
    GRANT CONNECT ON DATABASE "${dbIdent}" TO tablecreator;

    GRANT USAGE ON SCHEMA public TO readwrite;
    GRANT USAGE ON SCHEMA public TO tablecreator;
    GRANT CREATE ON SCHEMA public TO tablecreator;

    ${adminOwnedGrantsSql()}
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO tablecreator;

    -- readwrite gets no blanket table access: earlier versions granted it full
    -- DML on every table (and every future admin-created table) by default.
    -- Grants persist until revoked, so drop that default here; the per-table
    -- reset below replaces the existing table grants.
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM readwrite;

    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE ON SEQUENCES TO readwrite;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE ON SEQUENCES TO tablecreator;

    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${RW_NAME}') THEN
        EXECUTE format('CREATE USER ${RW_NAME} WITH PASSWORD %L', '${rwPass}');
      ELSE
        EXECUTE format('ALTER USER ${RW_NAME} WITH PASSWORD %L', '${rwPass}');
      END IF;

      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${TC_NAME}') THEN
        EXECUTE format('CREATE USER ${TC_NAME} WITH PASSWORD %L', '${tcPass}');
      ELSE
        EXECUTE format('ALTER USER ${TC_NAME} WITH PASSWORD %L', '${tcPass}');
      END IF;
    END$$;

    GRANT readwrite TO ${RW_NAME};
    GRANT tablecreator TO ${TC_NAME};

    -- Every admin-owned table: reset readwrite to exactly READWRITE_TABLE_PRIVILEGES
    -- (application tables, plus the vectorstore tables on databases where the
    -- admin created them before data_ingestion moved to app_tc). Anything
    -- unlisted (pgmigrations, legacy tables) gets nothing. Runs in this
    -- transaction, so live connections never see the tables without grants.
    ${readwriteNarrowingSql(READWRITE_TABLE_PRIVILEGES)}
  `;

  await adminClient.query("BEGIN");
  try {
    await adminClient.query(sql);
    // Fail the deploy (and roll back, before any secret is rotated) if the
    // audit trail is still editable by the roles it audits.
    const { rows: auditRows } = await adminClient.query(
      appendOnlyViolationsSql(["tablecreator", "readwrite", TC_NAME, RW_NAME]),
    );
    assertAppendOnlyTables(auditRows);
    await adminClient.query("COMMIT");
  } catch (e) {
    await adminClient.query("ROLLBACK");
    throw e;
  } finally {
    await adminClient.end();
  }

  // Update Secrets Manager with the rotated creds
  const base = await getSecret(dbSecretName);
  await putSecret(proxySecretName, {
    ...base,
    username: TC_NAME,
    password: tcPass,
  });
  await putSecret(userSecretName, {
    ...base,
    username: RW_NAME,
    password: rwPass,
  });

  // Runs after the secrets are written so a failure here can't leave the DB
  // and Secrets Manager holding different passwords.
  await grantReadwriteOnTableCreatorObjects(adminDb, TC_NAME, tcPass);
}

/**
 * Give readwrite (app_rw) the minimum access it needs on tables app_tc creates.
 *
 * data_ingestion connects as app_tc, so PGVector / SQLRecordManager tables
 * (langchain_pg_collection, langchain_pg_embedding, upsertion_record) created
 * on first ingest are owned by app_tc. The admin's ALTER DEFAULT PRIVILEGES
 * only covers objects the admin creates, and the admin (rds_superuser, not a
 * true superuser) can't grant on tables it doesn't own. So this runs as app_tc
 * itself: a role can always set its own default privileges and grant on the
 * objects it owns. Without it, text_generation (app_rw) gets "permission
 * denied" on the langchain tables.
 * https://www.postgresql.org/docs/16/sql-alterdefaultprivileges.html
 *
 * What the app_rw Lambdas actually do on these tables:
 *   langchain_pg_collection: SELECT; INSERT (text_generation's PGVector
 *                            get-or-creates the persona's collection)
 *   langchain_pg_embedding:  SELECT (RAG retrieval); DELETE (deleteFile)
 *   upsertion_record:        nothing (only data_ingestion uses it)
 * No UPDATE anywhere, so app_rw can't rewrite stored embeddings.
 */
async function grantReadwriteOnTableCreatorObjects(adminDb, tcName, tcPass) {
  const tcClient = new Client({
    user: tcName,
    password: tcPass,
    host: adminDb.host,
    database: adminDb.dbname,
    port: adminDb.port || 5432,
    ssl: { rejectUnauthorized: true },
  });
  await tcClient.connect();
  try {
    await tcClient.query(`
      -- Tables app_tc creates later (first ingest on a fresh DB) start with
      -- SELECT only, so they never inherit write access. data_ingestion runs
      -- the same per-table narrowing right after creating them
      -- (helpers/helper.py grant_readwrite_on_vectorstore_tables), which adds
      -- the INSERT/DELETE listed above.
      ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM readwrite;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO readwrite;

      -- Every app_tc-owned table: reset readwrite's access to exactly what it
      -- needs. Unlisted tables (upsertion_record, anything new) get nothing.
      ${readwriteNarrowingSql(VECTORSTORE_TABLE_PRIVILEGES)}
    `);

    // A REVOKE only removes grants made by the revoking role (or the owner),
    // so confirm the end state instead of trusting that the statements ran.
    // Fail closed: throwing fails the TriggerFunction and therefore the deploy,
    // rather than reporting success while app_rw can still rewrite embeddings.
    // Safe to throw here: the rotated passwords are already in Secrets Manager.
    const { rows } = await tcClient.query(READWRITE_FORBIDDEN_PRIVILEGES_SQL);
    assertNoForbiddenPrivileges(rows);
  } finally {
    await tcClient.end();
  }
}

/**
 * readwrite's privileges on the vectorstore tables (see
 * grantReadwriteOnTableCreatorObjects for who uses what). upsertion_record is
 * deliberately absent: app_rw never touches it, so it gets nothing.
 * Keep in sync with READWRITE_GRANTS_SQL in data_ingestion/src/helpers/helper.py.
 */
const VECTORSTORE_TABLE_PRIVILEGES = Object.freeze({
  langchain_pg_collection: "SELECT, INSERT",
  langchain_pg_embedding: "SELECT, DELETE",
});

/**
 * Exactly what readwrite (app_rw) may do on each application table, from the
 * SQL the app_rw services run: lambda/lib/studentFunction.js,
 * lambda/lib/instructorFunction.js, text_generation, socket-server,
 * voice-agent, deleteFile, deleteLastMessage, timeoutHandler (and the
 * read-only getFiles / getProfilePictures / generatePreSignedURL /
 * deletePatient). adminFunction and addStudentOnSignUp connect as app_tc and
 * aren't covered here.
 *
 * Foreign-key cascades run as the table owner, so a DELETE on a parent (e.g.
 * personas) doesn't need DELETE on its child tables.
 *
 * A table missing from this map gets NO access for app_rw. When a migration
 * adds a table the app_rw services use, add it here in the same change
 * (test/readwritePrivilegeCheck.test.ts fails otherwise).
 */
const APPLICATION_TABLE_PRIVILEGES = Object.freeze({
  chats: "SELECT, INSERT, UPDATE, DELETE",
  debrief_feedback: "SELECT, INSERT",
  debrief_prompt_history: "SELECT, INSERT",
  debriefs: "SELECT, INSERT",
  dtp_bank: "SELECT, INSERT, UPDATE",
  enrollments: "SELECT, INSERT, DELETE",
  feedback: "SELECT",
  group_instructors: "SELECT",
  issue_reports: "SELECT, INSERT",
  key_questions: "SELECT",
  messages: "SELECT, INSERT, UPDATE, DELETE",
  organizations: "SELECT",
  persona_data: "SELECT, INSERT, UPDATE, DELETE",
  persona_media: "SELECT, INSERT, UPDATE, DELETE",
  personas: "SELECT, INSERT, UPDATE, DELETE",
  question_bank: "SELECT, INSERT, UPDATE",
  question_interactions: "SELECT, INSERT",
  recommendations_bank: "SELECT, INSERT, UPDATE",
  // Written only by adminFunction / bootstrapAdmin (app_tc); app_rw never writes it.
  role_audit_log: "SELECT",
  rubrics: "SELECT",
  simulation_group_dtps: "SELECT, INSERT, UPDATE, DELETE",
  simulation_group_questions: "SELECT, INSERT, UPDATE, DELETE",
  simulation_group_recommendations: "SELECT, INSERT, UPDATE, DELETE",
  simulation_groups: "SELECT, INSERT, UPDATE",
  student_interactions: "SELECT, INSERT, UPDATE",
  system_prompt_history: "SELECT",
  user_engagement_log: "SELECT, INSERT",
  users: "SELECT, INSERT, UPDATE",
});

const READWRITE_TABLE_PRIVILEGES = Object.freeze({
  ...APPLICATION_TABLE_PRIVILEGES,
  ...VECTORSTORE_TABLE_PRIVILEGES,
});

/**
 * What used to be "GRANT ... ON ALL TABLES / ALL SEQUENCES IN SCHEMA public",
 * limited to objects the admin owns:
 *   tablecreator: SELECT, INSERT, UPDATE, DELETE on every admin-owned table,
 *     except APPEND_ONLY_TABLES (role_audit_log), which get SELECT, INSERT only
 *   readwrite, tablecreator: USAGE on every admin-owned sequence
 *
 * The ALL TABLES form fails outright ("permission denied for table ...") as
 * soon as the schema holds a table the admin has no privileges on, which is
 * the case once data_ingestion (app_tc) has created the vectorstore tables. A
 * role always holds full privileges on what it owns, so app_tc loses nothing.
 */
function adminOwnedGrantsSql() {
  return `
    DO $$
    DECLARE r record;
    BEGIN
      FOR r IN
        SELECT c.relname, c.relkind
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind IN ('r', 'p', 'S')
          AND c.relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
      LOOP
        IF r.relkind = 'S' THEN
          EXECUTE format('GRANT USAGE ON SEQUENCE public.%I TO readwrite, tablecreator', r.relname);
        ELSIF r.relname = ANY (ARRAY[${appendOnlyTablesSqlArray()}]) THEN
          -- Append-only audit tables: app_tc (adminFunction, bootstrapAdmin)
          -- writes the rows it audits, so it must not be able to rewrite or
          -- erase them. REVOKE first: earlier deploys granted full DML.
          EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.%I FROM tablecreator', r.relname);
          EXECUTE format('GRANT SELECT, INSERT ON TABLE public.%I TO tablecreator', r.relname);
        ELSE
          EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO tablecreator', r.relname);
        END IF;
      END LOOP;
    END$$;
  `;
}

const PRIVILEGE_LIST_RE = /^(SELECT|INSERT|UPDATE|DELETE)(, (SELECT|INSERT|UPDATE|DELETE))*$/;
const TABLE_NAME_RE = /^[a-z_][a-z0-9_]*$/;

/**
 * Audit tables the app roles may only read and append to. role_audit_log is
 * written by adminFunction / bootstrapAdmin as app_tc, the same credential
 * whose role changes it records, so app_tc must not be able to UPDATE, DELETE
 * or TRUNCATE it.
 */
const APPEND_ONLY_TABLES = ["role_audit_log"];

function appendOnlyTablesSqlArray() {
  for (const tbl of APPEND_ONLY_TABLES) {
    if (!TABLE_NAME_RE.test(tbl)) throw new Error(`Invalid append-only table name: ${tbl}`);
  }
  return APPEND_ONLY_TABLES.map((tbl) => `'${tbl}'`).join(", ");
}

/**
 * Rows (role, tbl, priv) where an app role can still modify an append-only
 * table. has_table_privilege includes inherited grants, so checking app_tc
 * also catches anything granted to tablecreator.
 */
function appendOnlyViolationsSql(roles) {
  for (const role of roles) {
    if (!TABLE_NAME_RE.test(role)) throw new Error(`Invalid role name: ${role}`);
  }
  const roleValues = roles.map((r) => `('${r}')`).join(", ");
  return `
    SELECT r.role, t.tbl, p.priv
    FROM (VALUES ${roleValues}) AS r(role)
    CROSS JOIN unnest(ARRAY[${appendOnlyTablesSqlArray()}]) AS t(tbl)
    CROSS JOIN (VALUES ('UPDATE'), ('DELETE'), ('TRUNCATE')) AS p(priv)
    WHERE to_regclass('public.' || t.tbl) IS NOT NULL
      AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r.role)
      AND has_table_privilege(r.role, to_regclass('public.' || t.tbl), p.priv);
  `;
}

/** Throw if appendOnlyViolationsSql returned any rows. */
function assertAppendOnlyTables(rows) {
  if (!rows || rows.length === 0) return;
  const triples = rows.map((r) => `${r.role}:${r.tbl}:${r.priv}`).join(", ");
  console.error(JSON.stringify({
    level: "ERROR",
    message: "app roles can still modify append-only audit tables",
    privileges: rows,
  }));
  throw new Error(`app roles can still modify append-only audit tables: ${triples}`);
}

/**
 * Reset readwrite's privileges on every public table owned by the current
 * role: REVOKE ALL, then GRANT exactly what privilegeMap lists. Tables not in
 * the map end up with nothing. Tables owned by other roles aren't touched (the
 * current role couldn't change them anyway).
 *
 * The admin passes READWRITE_TABLE_PRIVILEGES; app_tc, which only owns the
 * vectorstore tables it created, passes VECTORSTORE_TABLE_PRIVILEGES.
 *
 * Keep in sync with READWRITE_GRANTS_SQL in data_ingestion/src/helpers/helper.py.
 */
function readwriteNarrowingSql(privilegeMap) {
  const entries = Object.entries(privilegeMap);
  for (const [tbl, privs] of entries) {
    // Constants, but they're interpolated into SQL, so check them anyway.
    if (!TABLE_NAME_RE.test(tbl) || !PRIVILEGE_LIST_RE.test(privs)) {
      throw new Error(`Invalid readwrite privilege entry: ${tbl} => ${privs}`);
    }
  }
  const values = entries.map(([tbl, privs]) => `('${tbl}', '${privs}')`).join(",\n          ");
  return `
    DO $$
    DECLARE r record;
    BEGIN
      FOR r IN
        SELECT c.relname, m.privs
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        LEFT JOIN (VALUES
          ${values}
        ) AS m(tbl, privs) ON m.tbl = c.relname
        WHERE n.nspname = 'public'
          AND c.relkind IN ('r', 'p')
          AND c.relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
      LOOP
        EXECUTE format('REVOKE ALL ON TABLE public.%I FROM readwrite', r.relname);
        IF r.privs IS NOT NULL THEN
          EXECUTE format('GRANT %s ON TABLE public.%I TO readwrite', r.privs, r.relname);
        END IF;
      END LOOP;
    END$$;
  `;
}

// Privileges readwrite must NOT hold on the vectorstore tables, whoever owns them.
// Keep in sync with READWRITE_FORBIDDEN_PRIVILEGES_SQL in data_ingestion/src/helpers/helper.py.
const READWRITE_FORBIDDEN_PRIVILEGES_SQL = `
  SELECT f.tbl, f.priv
  FROM (VALUES
    ('langchain_pg_collection', 'UPDATE'), ('langchain_pg_collection', 'DELETE'),
    ('langchain_pg_embedding',  'UPDATE'), ('langchain_pg_embedding',  'INSERT'),
    ('upsertion_record', 'SELECT'), ('upsertion_record', 'INSERT'),
    ('upsertion_record', 'UPDATE'), ('upsertion_record', 'DELETE')
  ) AS f(tbl, priv)
  WHERE to_regclass('public.' || f.tbl) IS NOT NULL
    AND has_table_privilege('readwrite', to_regclass('public.' || f.tbl), f.priv);
`;

/**
 * Throw if READWRITE_FORBIDDEN_PRIVILEGES_SQL returned any rows.
 *
 * The usual cause is a vectorstore table owned by a role other than the admin
 * or app_tc (neither narrowing pass touches it), or a grant made by a third
 * role (a REVOKE can't remove it). Fix by revoking as that owner/grantor, or
 * moving ownership to app_tc, then redeploy.
 */
function assertNoForbiddenPrivileges(rows) {
  if (!rows || rows.length === 0) return;
  const pairs = rows.map((r) => `${r.tbl}:${r.priv}`).join(", ");
  console.error(JSON.stringify({
    level: "ERROR",
    message: "readwrite still holds privileges it should not have on vectorstore tables",
    privileges: rows,
  }));
  throw new Error(`readwrite still holds forbidden privileges on vectorstore tables: ${pairs}`);
}

exports.handler = async function (event, context) {
  const requestId = context?.awsRequestId || "unknown";
  console.log(JSON.stringify({ level: "INFO", requestId, message: "db_setup handler invoked" }));

  const { DB_SECRET_NAME, DB_USER_SECRET_NAME, DB_PROXY } = process.env;

  try {
    console.log(JSON.stringify({ level: "INFO", requestId, message: "Fetching admin DB credentials" }));
    const adminDb = await getSecret(DB_SECRET_NAME);

    // Run migrations
    console.log(JSON.stringify({ level: "INFO", requestId, message: "Running database migrations" }));
    await runMigrations(adminDb);
    console.log(JSON.stringify({ level: "INFO", requestId, message: "Database migrations completed" }));

    console.log(JSON.stringify({ level: "INFO", requestId, message: "Creating/updating application database users" }));
    await createAppUsers(adminDb, DB_SECRET_NAME, DB_USER_SECRET_NAME, DB_PROXY);
    console.log(JSON.stringify({ level: "INFO", requestId, message: "Application database users created/updated successfully" }));

    return { status: "ok" };
  } catch (error) {
    console.error(JSON.stringify({ level: "ERROR", requestId, message: "db_setup failed", error: error.message, stack: error.stack }));
    throw error;
  }
};

// Exported for unit tests.
exports.assertNoForbiddenPrivileges = assertNoForbiddenPrivileges;
exports.readwriteNarrowingSql = readwriteNarrowingSql;
exports.adminOwnedGrantsSql = adminOwnedGrantsSql;
exports.appendOnlyViolationsSql = appendOnlyViolationsSql;
exports.assertAppendOnlyTables = assertAppendOnlyTables;
exports.APPEND_ONLY_TABLES = APPEND_ONLY_TABLES;
exports.APPLICATION_TABLE_PRIVILEGES = APPLICATION_TABLE_PRIVILEGES;
exports.VECTORSTORE_TABLE_PRIVILEGES = VECTORSTORE_TABLE_PRIVILEGES;
exports.READWRITE_TABLE_PRIVILEGES = READWRITE_TABLE_PRIVILEGES;
exports.READWRITE_FORBIDDEN_PRIVILEGES_SQL = READWRITE_FORBIDDEN_PRIVILEGES_SQL;
