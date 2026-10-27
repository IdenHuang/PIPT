// Database access for the instructor and admin authorizers' role lookup.
// Uses the app_rw credential through RDS Proxy with TLS, like the API handlers.
// The connection is cached on the module for warm invocations.
const postgres = require("postgres");
const { SecretsManagerClient, GetSecretValueCommand } = require("@aws-sdk/client-secrets-manager");

const secretsManager = new SecretsManagerClient();
let sql;

async function readCredentials(secretId) {
  const secret = await secretsManager.send(new GetSecretValueCommand({ SecretId: secretId }));
  return JSON.parse(secret.SecretString);
}

async function getSql(secretId, proxyEndpoint) {
  if (sql) return sql;
  if (!secretId || !proxyEndpoint) {
    throw new Error("Role lookup is not configured");
  }
  const credentials = await readCredentials(secretId);
  // postgres.js calls `password` for every new connection
  // (https://github.com/porsager/postgres#connection-details). Re-read the secret
  // after the first one so a connection reopened after db_setup rotates app_rw
  // (every deploy) uses the new password, not the one cached at cold start.
  let first = true;
  sql = postgres({
    host: proxyEndpoint,
    port: credentials.port,
    username: credentials.username,
    password: async () => {
      if (first) {
        first = false;
        return credentials.password;
      }
      return (await readCredentials(secretId)).password;
    },
    database: credentials.dbname,
    ssl: { rejectUnauthorized: true },
    // One authorizer invocation runs one query; keep the pool small.
    max: 1,
  });
  return sql;
}

module.exports = { getSql };
