const postgres = require("postgres");
const { SecretsManagerClient, GetSecretValueCommand } = require("@aws-sdk/client-secrets-manager");

// Create a Secrets Manager client
const secretsManager = new SecretsManagerClient();

async function readCredentials(SM_DB_CREDENTIALS) {
  const secretResponse = await secretsManager.send(
    new GetSecretValueCommand({ SecretId: SM_DB_CREDENTIALS })
  );
  return JSON.parse(secretResponse.SecretString);
}

/**
 * Returns a postgres.js `password` callback. postgres.js calls it for every new
 * pooled connection (https://github.com/porsager/postgres#connection-details).
 * The first call reuses the credentials read at init; later calls re-read the
 * secret, so connections opened after db_setup rotates the app_rw/app_tc
 * passwords (every deploy) authenticate with the new value instead of the one
 * cached at cold start. Already-open connections are unaffected by rotation.
 */
function rotatingPassword(SM_DB_CREDENTIALS, initialCredentials) {
  let first = true;
  return async () => {
    if (first) {
      first = false;
      return initialCredentials.password;
    }
    const credentials = await readCredentials(SM_DB_CREDENTIALS);
    return credentials.password;
  };
}

async function initializeConnection(SM_DB_CREDENTIALS, RDS_PROXY_ENDPOINT) {
  try {
    console.log(JSON.stringify({ level: "INFO", message: "Initializing database connection" }));
    // Retrieve the secret from AWS Secrets Manager
    const credentials = await readCredentials(SM_DB_CREDENTIALS);

    const connectionConfig = {
      host: RDS_PROXY_ENDPOINT,
      port: credentials.port,
      username: credentials.username,
      password: rotatingPassword(SM_DB_CREDENTIALS, credentials),
      database: credentials.dbname,
      ssl: { rejectUnauthorized: true },
    };

    // The postgres.js pool is stored on the global object and reused across warm
    // invocations; new connections pick up rotated passwords via rotatingPassword.
    global.sqlConnection = postgres(connectionConfig);

    console.log(JSON.stringify({ level: "INFO", message: "Database connection initialized successfully" }));
  } catch (error) {
    console.error(JSON.stringify({ level: "ERROR", message: "Error initializing database connection", error: error.message, stack: error.stack }));
    throw new Error("Failed to initialize database connection");
  }
}

module.exports = { initializeConnection, rotatingPassword };
