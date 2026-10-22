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

    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO readwrite;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO tablecreator;

    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO readwrite;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO tablecreator;

    GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO readwrite;
    GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO tablecreator;

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

    -- The blanket GRANT ON ALL TABLES above also covers the vectorstore tables
    -- when the admin owns them (databases where they were created before
    -- data_ingestion moved to app_tc). Narrow them here, in the same
    -- transaction, so readwrite never ends up with UPDATE on embeddings.
    ${readwriteNarrowingSql({ namedTablesOnly: true })}
  `;

  await adminClient.query("BEGIN");
  try {
    await adminClient.query(sql);
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
      ${readwriteNarrowingSql({ namedTablesOnly: false })}
    `);

    // A REVOKE only removes grants made by the revoking role (or the owner),
    // so confirm the end state instead of trusting that the statements ran.
    const { rows } = await tcClient.query(READWRITE_FORBIDDEN_PRIVILEGES_SQL);
    if (rows.length > 0) {
      console.error(JSON.stringify({
        level: "ERROR",
        message: "readwrite still holds privileges it should not have on vectorstore tables",
        privileges: rows,
      }));
    }
  } finally {
    await tcClient.end();
  }
}

/**
 * Reset readwrite's privileges on tables owned by the current role.
 *
 *   langchain_pg_collection: SELECT, INSERT
 *   langchain_pg_embedding:  SELECT, DELETE
 *   anything else:           nothing
 *
 * namedTablesOnly limits it to the three vectorstore tables. The admin uses
 * this so it doesn't touch the application tables it owns. app_tc owns only
 * tables it created, so it narrows all of them.
 *
 * Keep in sync with READWRITE_GRANTS_SQL in data_ingestion/src/helpers/helper.py.
 */
function readwriteNarrowingSql({ namedTablesOnly }) {
  const nameFilter = namedTablesOnly
    ? "AND c.relname IN ('langchain_pg_collection', 'langchain_pg_embedding', 'upsertion_record')"
    : "";
  return `
    DO $$
    DECLARE r record;
    BEGIN
      FOR r IN
        SELECT c.relname,
               CASE c.relname
                 WHEN 'langchain_pg_collection' THEN 'SELECT, INSERT'
                 WHEN 'langchain_pg_embedding'  THEN 'SELECT, DELETE'
               END AS privs
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind IN ('r', 'p')
          AND c.relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
          ${nameFilter}
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
