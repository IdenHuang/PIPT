"use strict";

/**
 * db_setup rotates the app_rw/app_tc passwords on every deploy and writes the
 * new value to Secrets Manager. Warm Lambdas keep their postgres.js pool, so any
 * connection the pool opens after a rotation must authenticate with the current
 * secret, not the one read at cold start.
 *
 * postgres.js calls a function-valued `password` option for every new
 * connection; these tests drive that callback the way the pool would.
 */

const SECRET_ID = "app-rw-secret";
const PROXY = "proxy.example.internal";

let secretValues;
let secretReads;
let postgresConfigs;

function loadModule(modulePath) {
  jest.resetModules();
  secretReads = 0;
  postgresConfigs = [];
  jest.doMock(
    "@aws-sdk/client-secrets-manager",
    () => ({
      SecretsManagerClient: jest.fn(() => ({
        send: jest.fn(async (command) => {
          expect(command.input.SecretId).toBe(SECRET_ID);
          const password = secretValues[Math.min(secretReads, secretValues.length - 1)];
          secretReads += 1;
          return {
            SecretString: JSON.stringify({ username: "app_rw", password, port: 5432, dbname: "pipt" }),
          };
        }),
      })),
      GetSecretValueCommand: jest.fn((input) => ({ input })),
    }),
    { virtual: true }
  );
  jest.doMock(
    "postgres",
    () =>
      jest.fn((config) => {
        postgresConfigs.push(config);
        return { config };
      }),
    { virtual: true }
  );
  return require(modulePath);
}

afterEach(() => {
  jest.dontMock("@aws-sdk/client-secrets-manager");
  jest.dontMock("postgres");
  delete global.sqlConnection;
  delete global.sqlConnectionTableCreator;
});

const CASES = [
  {
    name: "lib/lib.js (student, instructor, signup, bootstrap, text-stream authz)",
    connect: async () => {
      const { initializeConnection } = loadModule("../lib.js");
      await initializeConnection(SECRET_ID, PROXY);
      return global.sqlConnection.config;
    },
  },
  {
    name: "adminFunction/libadmin.js",
    connect: async () => {
      const { initializeConnection } = loadModule("../../adminFunction/libadmin.js");
      await initializeConnection(SECRET_ID, PROXY);
      return global.sqlConnectionTableCreator.config;
    },
  },
  {
    name: "jwtAuthorizer/db.js (instructor/admin authorizers)",
    connect: async () => {
      const { getSql } = loadModule("../../jwtAuthorizer/db.js");
      return (await getSql(SECRET_ID, PROXY)).config;
    },
  },
];

describe.each(CASES)("$name", ({ connect }) => {
  test("keeps TLS verification and the proxy host", async () => {
    secretValues = ["pw-1"];
    const config = await connect();
    expect(config.host).toBe(PROXY);
    expect(config.username).toBe("app_rw");
    expect(config.ssl).toEqual({ rejectUnauthorized: true });
    expect(typeof config.password).toBe("function");
  });

  test("first connection reuses the init read; later connections re-read the rotated secret", async () => {
    secretValues = ["pw-before-deploy", "pw-after-deploy"];
    const config = await connect();
    expect(secretReads).toBe(1);

    // First pooled connection: no extra Secrets Manager call.
    await expect(config.password()).resolves.toBe("pw-before-deploy");
    expect(secretReads).toBe(1);

    // A connection opened after db_setup rotated the password gets the new one.
    await expect(config.password()).resolves.toBe("pw-after-deploy");
    expect(secretReads).toBe(2);
  });
});
