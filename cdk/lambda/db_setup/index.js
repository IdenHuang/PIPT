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
