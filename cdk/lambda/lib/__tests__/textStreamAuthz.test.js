"use strict";

/**
 * textStreamAuthzFunction: the AppSync Lambda data source behind the
 * Subscription.onTextStream resolver. A caller may subscribe to a chat's text
 * stream only if they own the chat or are an admin. Everything else denies.
 */

const OWNER = "owner@example.edu";
const OTHER = "other-student@example.edu";
const ADMIN = "admin@example.edu";
const CHAT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CHAT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

/** Stand-in for the postgres.js tagged template used by authz.js. */
function makeSql({ fail = false } = {}) {
  const owners = { [CHAT_A]: OWNER, [CHAT_B]: OTHER };
  const calls = [];
  const sql = async (strings, ...values) => {
    const text = strings.join("?");
    calls.push({ text, values });
    if (fail) throw new Error("db down");
    if (text.includes("SELECT roles")) {
      const [email] = values;
      return [{ roles: email === ADMIN ? ["admin"] : ["student"] }];
    }
    if (text.includes("FROM chats c")) {
      const [chatId, email] = values;
      return owners[chatId] === email ? [{ user_id: "u-1" }] : [];
    }
    throw new Error(`unexpected query: ${text}`);
  };
  sql.calls = calls;
  return sql;
}

function loadHandler(sql) {
  jest.resetModules();
  jest.doMock("../lib.js", () => ({
    initializeConnection: jest.fn(async () => {
      global.sqlConnection = sql;
    }),
  }));
  global.sqlConnection = undefined;
  return require("../textStreamAuthzFunction.js").handler;
}

afterEach(() => {
  jest.dontMock("../lib.js");
  global.sqlConnection = undefined;
  jest.restoreAllMocks();
});

beforeEach(() => {
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
});

describe("textStreamAuthzFunction", () => {
  test("allows the chat owner", async () => {
    const handler = loadHandler(makeSql());
    await expect(handler({ sessionId: CHAT_A, email: OWNER })).resolves.toEqual({ authorized: true });
  });

  test("denies another student subscribing to someone else's chat", async () => {
    const handler = loadHandler(makeSql());
    await expect(handler({ sessionId: CHAT_A, email: OTHER })).resolves.toEqual({ authorized: false });
  });

  test("allows admins, matching the /student REST routes", async () => {
    const handler = loadHandler(makeSql());
    await expect(handler({ sessionId: CHAT_A, email: ADMIN })).resolves.toEqual({ authorized: true });
  });

  test("denies an unknown chat", async () => {
    const handler = loadHandler(makeSql());
    const unknown = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    await expect(handler({ sessionId: unknown, email: OWNER })).resolves.toEqual({ authorized: false });
  });

  test.each([
    [{}],
    [{ sessionId: CHAT_A }],
    [{ email: OWNER }],
    [{ sessionId: CHAT_A, email: "" }],
    [{ sessionId: CHAT_A, email: 42 }],
    [{ sessionId: "test-playground-1", email: OWNER }],
    [{ sessionId: `${CHAT_A}' OR '1'='1`, email: OWNER }],
    [{ sessionId: [CHAT_A], email: OWNER }],
    [null],
  ])("denies a malformed payload without touching the DB: %j", async (event) => {
    const sql = makeSql();
    const handler = loadHandler(sql);
    await expect(handler(event)).resolves.toEqual({ authorized: false });
    expect(sql.calls).toHaveLength(0);
  });

  test("fails closed when the database errors", async () => {
    const handler = loadHandler(makeSql({ fail: true }));
    await expect(handler({ sessionId: CHAT_A, email: OWNER })).resolves.toEqual({ authorized: false });
  });

  test("fails closed when the connection cannot be initialized", async () => {
    jest.resetModules();
    jest.doMock("../lib.js", () => ({
      initializeConnection: jest.fn(async () => {
        throw new Error("Failed to initialize database connection");
      }),
    }));
    global.sqlConnection = undefined;
    const { handler } = require("../textStreamAuthzFunction.js");
    await expect(handler({ sessionId: CHAT_A, email: OWNER })).resolves.toEqual({ authorized: false });
  });

  test("uses parameterized queries for caller input", async () => {
    const sql = makeSql();
    const handler = loadHandler(sql);
    await handler({ sessionId: CHAT_A, email: OTHER });
    for (const call of sql.calls) {
      expect(call.text).not.toContain(OTHER);
      expect(call.text).not.toContain(CHAT_A);
    }
  });
});
