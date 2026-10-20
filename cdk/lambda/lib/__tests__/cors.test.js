const fs = require("fs");
const path = require("path");

// Same ALLOWED_ORIGINS shape the CDK stack sets (cdk/lib/api-service-stack.ts).
const DEPLOYED_ORIGINS = [
  "https://main.d3sunerinpg5un.amplifyapp.com",
  "https://*.amplifyapp.com",
  "http://localhost:5173",
  "http://localhost:5174",
].join(",");
const PRIMARY_ORIGIN = "https://main.d3sunerinpg5un.amplifyapp.com";

// cors.js reads ALLOWED_ORIGINS at require time, so load a fresh copy per config.
function loadCors(allowedOrigins, file = "../cors.js") {
  const saved = process.env.ALLOWED_ORIGINS;
  if (allowedOrigins === undefined) delete process.env.ALLOWED_ORIGINS;
  else process.env.ALLOWED_ORIGINS = allowedOrigins;
  let mod;
  jest.isolateModules(() => {
    mod = require(file);
  });
  if (saved === undefined) delete process.env.ALLOWED_ORIGINS;
  else process.env.ALLOWED_ORIGINS = saved;
  return mod;
}

const event = (origin) => ({ headers: origin === undefined ? {} : { origin } });

describe("getCorsOrigin with the deployed allowlist", () => {
  const { getCorsOrigin } = loadCors(DEPLOYED_ORIGINS);

  it.each([
    PRIMARY_ORIGIN,
    "https://main.d3uv171xv91wfq.amplifyapp.com",
    "https://feature-x.d3uv171xv91wfq.amplifyapp.com",
    "http://localhost:5173",
  ])("echoes allowed origin %s", (origin) => {
    expect(getCorsOrigin(event(origin))).toBe(origin);
  });

  it.each([
    "https://evil.example.com",
    "https://amplifyapp.com",
    "https://.amplifyapp.com",
    "https://evil.amplifyapp.com.attacker.net",
    "https://evil-amplifyapp.com",
    "https://evil.com:1234.amplifyapp.com",
    "https://evil.com@x.amplifyapp.com",
    "https://evil.com/x.amplifyapp.com",
    "https://evil.com?.amplifyapp.com",
    "https://main.d3uv171xv91wfq.amplifyapp.com\n",
    "http://localhost:5175",
  ])("does not echo disallowed origin %j", (origin) => {
    expect(getCorsOrigin(event(origin))).toBe(PRIMARY_ORIGIN);
  });

  it("returns the primary origin when no Origin header is sent", () => {
    expect(getCorsOrigin(event(undefined))).toBe(PRIMARY_ORIGIN);
  });
});

describe("getCorsOrigin configuration edge cases", () => {
  it.each([undefined, "", " ", ",", " , "])("fails closed when ALLOWED_ORIGINS is %j", (value) => {
    const { getCorsOrigin, getCorsHeaders } = loadCors(value);
    expect(getCorsOrigin(event("https://anything.example"))).toBe("");
    expect(getCorsHeaders(event(PRIMARY_ORIGIN))["Access-Control-Allow-Origin"]).toBe("");
  });

  it("allows every origin only for an explicit *", () => {
    const { getCorsOrigin } = loadCors("*");
    expect(getCorsOrigin(event("https://anything.example"))).toBe("*");
  });
});

describe("CORS helper copies", () => {
  it("adminFunction/cors.js is byte-identical to lib/cors.js", () => {
    const lib = fs.readFileSync(path.join(__dirname, "..", "cors.js"), "utf8");
    const admin = fs.readFileSync(path.join(__dirname, "..", "..", "adminFunction", "cors.js"), "utf8");
    expect(admin).toBe(lib);
  });
});
