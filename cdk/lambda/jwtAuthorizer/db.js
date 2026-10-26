// Database access for the instructor and admin authorizers' role lookup.
// Uses the app_rw credential through RDS Proxy with TLS, like the API handlers.
// The connection is cached on the module for warm invocations.
const postgres = require("postgres");
const { SecretsManagerClient, GetSecretValueCommand } = require("@aws-sdk/client-secrets-manager");

const secretsManager = new SecretsManagerClient();
let sql;

async function getSql(secretId, proxyEndpoint) {
  if (sql) return sql;
  if (!secretId || !proxyEndpoint) {
    throw new Error("Role lookup is not configured");
  }
  const secret = await secretsManager.send(new GetSecretValueCommand({ SecretId: secretId }));
  const credentials = JSON.parse(secret.SecretString);
  sql = postgres({
    host: proxyEndpoint,
    port: credentials.port,
    username: credentials.username,
    password: credentials.password,
    database: credentials.dbname,
    ssl: { rejectUnauthorized: true },
    // One authorizer invocation runs one query; keep the pool small.
    max: 1,
  });
  return sql;
}

module.exports = { getSql };
