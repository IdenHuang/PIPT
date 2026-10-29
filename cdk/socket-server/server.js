const crypto = require("crypto");
const express = require("express");
const { createServer } = require("http");
const { Server } = require("socket.io");
const { spawn } = require("child_process");
const WebSocket = require("ws");
const { verifyToken } = require("./auth");
const { verifySessionScope } = require("./session-auth");
const { authorizeSessionRequest } = require("./session-guard");
const { resolveRelayToken } = require("./relay-token");
const { fetchPatientContext } = require("./patient-context");
const { StreamRelayRegistry, safeEqual } = require("./stream-relay");
const { VoicePreviewLimiter, ConnectionLimiter, limiterKey, positiveIntEnv } = require("./voice-preview-limiter");
const logger = require("./logger");
const { SignatureV4 } = require("@smithy/signature-v4");
const { HttpRequest } = require("@smithy/protocol-http");
const { defaultProvider } = require("@aws-sdk/credential-provider-node");
const { SecretsManagerClient, GetSecretValueCommand } = require("@aws-sdk/client-secrets-manager");

// ─── Voice Agent Adapter ──────────────────────────────────────────────────────
// When VOICE_AGENT_ARN is set, audio is streamed to the AgentCore
// voice agent via SigV4-authenticated WebSocket instead of using the local
// nova_sonic.py child process.
const VOICE_AGENT_ARN = process.env.VOICE_AGENT_ENDPOINT || "";
const AGENTCORE_REGION = process.env.AWS_REGION || "ca-central-1";
// Upper bounds for starting a voice session: the WebSocket upgrade, then the
// agent's "Nova Sonic ready" message (guardrail check, persona load, Bedrock
// stream open). Past either, the client gets an error it can retry from.
const VOICE_AGENT_HANDSHAKE_TIMEOUT_MS = 20000;
const VOICE_READY_TIMEOUT_MS = 60000;

// SHA-256 helper for SigV4
class Sha256 {
  constructor(secret) {
    this._hmac = secret
      ? crypto.createHmac("sha256", secret)
      : crypto.createHash("sha256");
  }
  update(data) {
    this._hmac.update(typeof data === "string" ? data : Buffer.from(data));
  }
  async digest() {
    return new Uint8Array(this._hmac.digest());
  }
}

/**
 * Open a SigV4-authenticated WebSocket connection to AgentCore's /ws endpoint.
 * @param {object} initConfig — init message payload (session_id, patient_name, etc.)
 * @returns {Promise<WebSocket>}
 */
async function connectToVoiceAgent(initConfig) {
  const sessionId = initConfig.session_id || `session-${Date.now()}-${crypto.randomUUID()}`;

  // Build the AgentCore WebSocket URL
  const host = `bedrock-agentcore.${AGENTCORE_REGION}.amazonaws.com`;
  const wsPath = `/runtimes/${VOICE_AGENT_ARN}/ws`;
  const queryParams = `X-Amzn-Bedrock-AgentCore-Runtime-Session-Id=${encodeURIComponent(sessionId)}`;

  // Create an HTTP request to sign
  const request = new HttpRequest({
    method: "GET",
    protocol: "wss:",
    hostname: host,
    path: wsPath,
    query: Object.fromEntries(new URLSearchParams(queryParams)),
    headers: {
      host: host,
    },
  });

  // Sign the request with SigV4
  const signer = new SignatureV4({
    credentials: defaultProvider(),
    region: AGENTCORE_REGION,
    service: "bedrock-agentcore",
    sha256: Sha256,
  });

  const signed = await signer.sign(request);

  // Build the final WebSocket URL with signed headers
  const wsUrl = `wss://${host}${wsPath}?${queryParams}`;
  console.log("🔌 Connecting to AgentCore WebSocket:", wsUrl);

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, {
      headers: signed.headers,
      // Fail instead of leaving the student on "connecting" if AgentCore
      // never completes the upgrade.
      handshakeTimeout: VOICE_AGENT_HANDSHAKE_TIMEOUT_MS,
    });

    ws.on("open", () => {
      console.log("✅ AgentCore WebSocket connected (session:", sessionId, ")");
      // Send init message with session config
      ws.send(JSON.stringify({ type: "init", ...initConfig }));
      resolve(ws);
    });

    ws.on("error", (err) => {
      console.error("❌ AgentCore WebSocket error:", err.message);
      reject(err);
    });
  });
}

const app = express();
const server = createServer(app);

// Parse ALLOWED_ORIGINS env var for CORS. Supports wildcard subdomains.
// Matching mirrors cdk/lambda/lib/cors.js. Unset/empty fails closed (no browser
// origin allowed); only an explicit "*" entry allows every origin.
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
// "*" matches one or more DNS labels, never ":", "@" or "/".
const WILDCARD_HOST_LABELS = "[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)*";
const allowedOriginPatterns = allowedOrigins.filter((p) => p !== "*").map((pattern) => {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, WILDCARD_HOST_LABELS);
  return new RegExp("^" + escaped + "$");
});
if (allowedOrigins.length === 0) {
  console.warn("⚠️ ALLOWED_ORIGINS is not set; all browser origins will be rejected");
}
const corsOriginConfig = allowedOrigins.includes("*")
  ? "*"
  : (origin, callback) => {
      if (!origin) return callback(null, true); // allow non-browser requests
      const isAllowed = allowedOriginPatterns.some((re) => re.test(origin));
      callback(null, isAllowed ? origin : false);
    };

const io = new Server(server, {
  cors: { origin: corsOriginConfig, methods: ["GET", "POST"] },
  // Keep WebSocket alive through CloudFront/NLB layers.
  // A PING is still sent every 15s (traffic flows well within CloudFront's
  // idle timeout window), but the PONG grace period is 25s. The old 10s grace
  // was too tight: spawning the Nova child process and heavy synchronous JSON
  // logging can briefly block the Node event loop, delaying PONGs and causing
  // spurious "ping timeout" disconnects (which then forced non-streaming
  // fallback on the client).
  pingInterval: 15000,
  pingTimeout: 25000,
  // Allow up to 60s for the initial HTTP→WS upgrade (covers cold starts)
  connectTimeout: 60000,
});

// ─── Health Check ─────────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({ status: "healthy" });
});

// ─── Text Stream Callback ─────────────────────────────────────────────────────
// The text generation Lambda POSTs streaming chunks here instead of AppSync.
// Maps sessionId → { socket, nonce }. A callback is relayed only when it carries
// the per-request nonce minted at registration (see stream-relay.js).
const textStreamSockets = new StreamRelayRegistry();
// Upper bound for relaying after API Gateway gives up: the text-gen Lambda's
// timeout (300s) plus slack.
const TEXT_STREAM_MAX_MS = 310 * 1000;
// Grace period after an "end" frame for the trailing "session_complete"
// (the Lambda saves the message and joins matching threads in between).
const TEXT_STREAM_TRAILING_MS = 15 * 1000;

// Load the shared callback secret once at startup so header checks are free.
let streamCallbackToken = null;
const _smClient = new SecretsManagerClient({ region: process.env.AWS_REGION || "ca-central-1" });
(async () => {
  const secretName = process.env.SM_STREAM_CALLBACK_SECRET;
  if (!secretName) {
    logger.warn("SM_STREAM_CALLBACK_SECRET not set — /stream-callback auth disabled", {
      component: "server",
      operation: "loadStreamCallbackToken",
    });
    return;
  }
  try {
    const { SecretString } = await _smClient.send(new GetSecretValueCommand({ SecretId: secretName }));
    streamCallbackToken = SecretString;
    logger.info("Stream callback token loaded", {
      component: "server",
      operation: "loadStreamCallbackToken",
    });
  } catch (e) {
    logger.error("Failed to load stream callback secret", {
      component: "server",
      operation: "loadStreamCallbackToken",
      secretName,
      error: e.message,
    });
  }
})();

app.use(express.json());

app.post("/stream-callback", (req, res) => {
  // Fail-closed: reject all requests if the callback token was never loaded
  if (!streamCallbackToken) {
    return res.status(503).json({ error: "Stream callback authentication not configured" });
  }
  if (!safeEqual(req.headers["x-callback-token"], streamCallbackToken)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { session_id, data } = req.body || {};
  if (typeof session_id !== "string" || !session_id || !data || typeof data !== "object") {
    return res.status(400).json({ error: "session_id and data required" });
  }

  // Entitlement: the caller must echo the nonce this server minted for the
  // in-flight request on this session. The shared token alone is not enough.
  const socket = textStreamSockets.resolve(session_id, req.headers["x-stream-nonce"]);
  if (!socket) {
    logger.warn("Rejected stream callback without a matching session nonce", {
      component: "server",
      operation: "stream-callback",
      sessionId: session_id,
    });
    return res.status(403).json({ error: "Forbidden" });
  }

  if (socket.connected) {
    socket.emit("text-stream", data);
  } else {
    console.warn(`⚠️ Socket for session ${session_id} is disconnected`);
  }

  // After a 504 the request handler has already returned, so terminal frames
  // drive the release: hold briefly after "end"/"error" for a trailing
  // "session_complete". No-op for non-deferred registrations.
  if (data.type === "end" || data.type === "error" || data.type === "session_complete") {
    textStreamSockets.settle(
      session_id,
      req.headers["x-stream-nonce"],
      data.type === "session_complete" ? 0 : TEXT_STREAM_TRAILING_MS,
    );
  }

  res.status(200).json({ ok: true });
});

// ─── TURN Credential Generation (RFC 5389) ───────────────────────────────────
// NOTE: Currently unused — retained for future TURN server integration.
/**
 * Generate time-limited TURN credentials using HMAC-SHA1.
 * @param {string} username — unique identifier (e.g. socket.userId)
 * @param {string} sharedSecret — TURN shared secret
 * @param {number} ttlSeconds — credential lifetime (max 24 hours)
 * @returns {{ username: string, credential: string }}
 */
function generateTurnCredentials(username, sharedSecret, ttlSeconds = 86400) { // eslint-disable-line no-unused-vars
  const timestamp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const turnUsername = `${timestamp}:${username}`;
  const hmac = crypto.createHmac("sha1", sharedSecret);
  hmac.update(turnUsername);
  const turnPassword = hmac.digest("base64");
  return { username: turnUsername, credential: turnPassword };
}

// ─── Voice Preview & Connection Limits ────────────────────────────────────────
// Keyed on the authenticated identity (not socket.id) so reconnecting or
// opening parallel sockets does not reset the budget. State outlives the
// connection and is aged out by the prune interval below. This service runs
// as a single task, so these limits also protect it from exhaustion.
const TTS_TIMEOUT_MS = 90000;
const voicePreviewLimiter = new VoicePreviewLimiter({
  maxPerWindow: positiveIntEnv(process.env.VOICE_PREVIEW_MAX_PER_MINUTE, 5),
  windowMs: 60000,
  maxConcurrentPerUser: positiveIntEnv(process.env.VOICE_PREVIEW_MAX_CONCURRENT_PER_USER, 2),
  maxConcurrentTotal: positiveIntEnv(process.env.VOICE_PREVIEW_MAX_CONCURRENT_TOTAL, 10),
});
const connectionLimiter = new ConnectionLimiter({
  maxPerUser: positiveIntEnv(process.env.SOCKET_MAX_CONNECTIONS_PER_USER, 10),
});
setInterval(() => voicePreviewLimiter.prune(), 5 * 60 * 1000).unref();

function voicePreviewRefusalMessage(result) {
  if (result.reason === "rate") {
    const seconds = Math.max(1, Math.ceil(result.retryAfterMs / 1000));
    return `Rate limit exceeded. Please wait ${seconds}s before starting another voice preview.`;
  }
  if (result.reason === "concurrent") {
    return "Too many voice previews are already running for your account. Stop one before starting another.";
  }
  return "Voice preview is busy right now. Please try again in a moment.";
}

// ─── Socket.IO Connection ─────────────────────────────────────────────────────
io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth.token;
    if (!token) {
      return next(new Error("Authentication token required"));
    }

    const decoded = await verifyToken(token);
    socket.userId = decoded.sub;
    socket.userEmail = decoded.email;
    // Early refusal with a clear connect_error; the authoritative count is
    // taken in the connection handler so abandoned handshakes cannot leak.
    if (connectionLimiter.isAtLimit(limiterKey(socket))) {
      console.warn("⚠️ Connection limit reached for:", socket.userEmail);
      return next(new Error("Too many open connections for this account"));
    }
    console.log("🔐 User authenticated:", socket.userEmail);
    next();
  } catch (err) {
    console.error("🔐 Authentication failed:", err.message);
    next(new Error("Authentication failed"));
  }
});

io.on("connection", (socket) => {
  const releaseConnection = connectionLimiter.tryAdd(limiterKey(socket));
  if (!releaseConnection) {
    console.warn("⚠️ Connection limit reached for:", socket.userEmail);
    socket.disconnect(true);
    return;
  }
  socket.on("disconnect", releaseConnection);

  console.log("🔌 CLIENT CONNECTED:", socket.id, "User:", socket.userEmail);
  console.log(
    process.env.SM_DB_CREDENTIALS
      ? "🔐 DB CREDENTIALS LOADED"
      : "❌ NO DB CREDENTIALS",
  );
  console.log(
    process.env.RDS_PROXY_ENDPOINT ? "🔐 RDS PROXY LOADED" : "❌ NO RDS PROXY",
  );

  let novaProcess = null;
  let novaReady = false;
  // Bumped by every start-nova-sonic and stop-nova-sonic. A start that is
  // still awaiting (authz, patient context, AgentCore connect) checks it and
  // gives up if a newer start or a stop arrived in the meantime.
  let voiceGeneration = 0;
  let voiceReadyTimer = null;

  function clearVoiceReadyTimer() {
    if (voiceReadyTimer) {
      clearTimeout(voiceReadyTimer);
      voiceReadyTimer = null;
    }
  }

  // End the current AgentCore session. socket.agentWs is cleared before the
  // close so that WebSocket's handlers (which check they are still current)
  // stay silent. Otherwise the old session's "close" would arrive after the
  // student clicked reconnect and end the new session with an error.
  function closeAgentWs() {
    clearVoiceReadyTimer();
    const ws = socket.agentWs;
    socket.agentWs = null;
    novaReady = false;
    if (!ws) return;
    try {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "end_session" }));
      }
      ws.close();
    } catch {}
  }

  // Small delay then log active client count
  setTimeout(() => {
    console.log(`🔌 ACTIVE CLIENTS: ${io.engine.clientsCount}`);
  }, 100);

  socket.on("error", (err) => {
    console.error("🔌 SOCKET ERROR:", err);
  });

  // ─── Start Nova Sonic (Socket.IO audio transport) ───────────────────────
  // When VOICE_AGENT_ARN is set, audio is streamed to the AgentCore
  // voice agent via WebSocket. Otherwise, falls back to the local
  // nova_sonic.py child process.
  socket.on("start-nova-sonic", async (config = {}) => {
    const now = Date.now();
    if (now - lastNovaSonicStart < 2000) {
      // Reply instead of dropping silently, which left the client waiting
      // on "connecting" for a nova-started that never came.
      socket.emit("nova-error", { error: "Voice is already starting. Please wait a moment and try again." });
      return;
    }
    lastNovaSonicStart = now;
    const generation = ++voiceGeneration;
    const isStale = () => generation !== voiceGeneration;
    console.log("🚀 Starting Nova Sonic session for client:", socket.id);

    // A new start replaces any previous session. Tear it down before the
    // awaits below so none of its late events reach the new session.
    audioStarted = false;
    closeAgentWs();
    if (novaProcess) {
      novaProcess.kill();
      novaProcess = null;
    }
    novaReady = false;

    // ── Session authorization (fail closed; see session-guard.js) ─────────
    // The caller must own the chat and it must belong to the patient/group in
    // the config, since those IDs drive which persona context is loaded.
    const sessionId = config.session_id;
    const novaAuthz = await authorizeSessionRequest(
      {
        userEmail: socket.userEmail,
        sessionId,
        patientId: config.patient_id,
        simulationGroupId: config.simulation_group_id,
      },
      verifySessionScope,
    );
    if (!novaAuthz.allowed) {
      logger.warn("Session authorization denied for start-nova-sonic", {
        component: "server",
        operation: "start-nova-sonic",
        userEmail: socket.userEmail,
        sessionId,
      });
      if (!isStale()) socket.emit("nova-error", { error: novaAuthz.error });
      return;
    }
    if (isStale()) return;

    // ── Caller's ID token for upstream calls ───────────────────────────────
    // The handshake token expires on a long-lived socket (ID tokens last an
    // hour), which made a reconnect after a long idle period fail to load the
    // patient context. The client sends a fresh token with each start; it is
    // verified and bound to the handshake identity, exactly like the
    // text-generation relay. Clients that don't send one keep the old behaviour.
    let userToken = socket.handshake.auth.token;
    if (config.token !== undefined) {
      const fresh = await resolveRelayToken(
        config.token,
        { userId: socket.userId, userEmail: socket.userEmail },
        verifyToken,
      );
      if (isStale()) return;
      if (!fresh.ok) {
        logger.warn("Relay token rejected for start-nova-sonic", {
          component: "server",
          operation: "start-nova-sonic",
          userEmail: socket.userEmail,
          sessionId,
        });
        socket.emit("nova-error", { error: fresh.error });
        return;
      }
      userToken = fresh.token;
    }

    // ── Authoritative patient context (fail closed) ────────────────────────
    // The persona, system prompt and completion rule come only from
    // GET /student/patient_context, which verifies enrollment and that the
    // persona belongs to the group. Client-supplied prompt fields
    // (config.patient_prompt / system_prompt / patient_name / llm_completion)
    // are never read: any failure here ends the session instead.
    const patientContext = await fetchPatientContext({
      endpoint: process.env.TEXT_GENERATION_ENDPOINT,
      simulationGroupId: config.simulation_group_id,
      patientId: config.patient_id,
      token: userToken,
    });
    if (isStale()) return;
    if (!patientContext.ok) {
      logger.warn("Patient context unavailable for start-nova-sonic", {
        component: "server",
        operation: "start-nova-sonic",
        userEmail: socket.userEmail,
        sessionId,
        reason: patientContext.reason,
      });
      socket.emit("nova-error", { error: "Could not load patient context for this session" });
      return;
    }
    const voiceContext = patientContext.context;

    // ── AgentCore WebSocket path ──────────────────────────────────────────
    if (VOICE_AGENT_ARN) {
      console.log("🔀 Using AgentCore WebSocket for ARN:", VOICE_AGENT_ARN);

      try {
        const agentWs = await connectToVoiceAgent({
          session_id: sessionId,
          voice_id: config.voice_id || "",
          user_id: socket.userId || "anonymous",
          patient_name: voiceContext.patient_name,
          patient_prompt: voiceContext.patient_prompt,
          patient_id: config.patient_id || "",
          simulation_group_id: config.simulation_group_id || "",
          llm_completion: voiceContext.llm_completion,
          system_prompt: voiceContext.system_prompt,
          cognito_token: userToken || "",
          text_generation_endpoint: process.env.TEXT_GENERATION_ENDPOINT || "",
          // The voice agent runs outside CDK, so pass the guardrail it must apply.
          // It fails closed (withholds AI text) if neither this nor its own
          // BEDROCK_GUARDRAIL_ID env var is set.
          guardrail_id: process.env.BEDROCK_GUARDRAIL_ID || "",
          guardrail_region: process.env.BEDROCK_GUARDRAIL_REGION || process.env.AWS_REGION || "",
        });

        // A newer start or a stop arrived while connecting: this session is
        // no longer wanted, so don't attach it to the socket.
        if (isStale()) {
          try {
            agentWs.send(JSON.stringify({ type: "end_session" }));
            agentWs.close();
          } catch {}
          return;
        }

        socket.agentWs = agentWs;
        const isCurrent = () => socket.agentWs === agentWs;

        voiceReadyTimer = setTimeout(() => {
          voiceReadyTimer = null;
          if (!isCurrent() || novaReady) return;
          console.warn("⏰ Voice agent not ready after %dms; giving up", VOICE_READY_TIMEOUT_MS);
          closeAgentWs();
          socket.emit("nova-error", { error: "Voice took too long to connect. Please try again." });
        }, VOICE_READY_TIMEOUT_MS);

        // Relay messages from agent back to the frontend
        agentWs.on("message", (data) => {
          // Events from a session that was replaced or stopped must not reach
          // the client, which may already be running a newer session.
          if (!isCurrent()) return;
          try {
            const msg = JSON.parse(data.toString());
            console.log("📨 AGENT MSG type=%s role=%s", msg.type, msg.role);

            if (msg.type === "audio") {
              socket.emit("audio-chunk", { data: msg.data });
            } else if (msg.type === "audio-flush") {
              // Guardrail blocked (or couldn't screen) the AI reply: discard queued audio.
              socket.emit("audio-flush", {});
            } else if (msg.type === "user-turn-start") {
              socket.emit("turn-start", { role: "user" });
            } else if (msg.type === "turn-start") {
              socket.emit("turn-start", { role: msg.role });
            } else if (msg.type === "user-text") {
              console.log("💬 AGENT USER TEXT:", msg.text);
              socket.emit("text-message", { text: msg.text, role: "user" });
            } else if (msg.type === "text") {
              console.log("💬 AGENT TEXT:", msg.text);
              socket.emit("text-message", { text: msg.text, role: msg.role || "assistant" });
              if (msg.text && msg.text.includes("Nova Sonic ready")) {
                novaReady = true;
                clearVoiceReadyTimer();
                socket.emit("nova-started", { status: "Nova Sonic session started" });
              }
            } else if (msg.type === "diagnosis_complete") {
              console.log("🎯 DIAGNOSIS COMPLETE:", msg.text);
              socket.emit("diagnosis-complete", { message: msg.text });
            } else if (msg.type === "diagnosis_verdict") {
              console.log("🩺 DIAGNOSIS VERDICT:", msg.verdict);
              if (msg.verdict) {
                socket.emit("diagnosis-complete", { message: "Session completed successfully" });
              }
            } else if (msg.type === "error" && (msg.error === "session_timeout" || msg.error === "stream_error" || msg.error === "guardrail_unavailable")) {
              // guardrail_unavailable: the agent refused (or stopped) the session
              // because content can't be screened; voice must not run unguarded.
              console.log("⏰ Voice session ended:", msg.error, msg.message);
              // The agent's Bedrock stream is dead but it keeps the WebSocket
              // open. Close it now: left open, its later "close" fired after
              // the student clicked reconnect and ended the new session too.
              closeAgentWs();
              socket.emit("voice-session-ended", {
                reason: msg.error,
                message: msg.message || "Voice had an issue. Please reconnect to continue where you left off."
              });
            }
          } catch (err) {
            console.warn("⚠️ Failed to parse agent message:", err.message);
          }
        });

        agentWs.on("close", (code, reason) => {
          console.log("🔚 Voice agent WebSocket closed (code=%s reason=%s)", code, reason);
          // Closed by us (stop, replace, timeout): already handled.
          if (!isCurrent()) return;
          clearVoiceReadyTimer();
          socket.agentWs = null;
          novaReady = false;
          // Notify the frontend so it can exit voice mode gracefully
          socket.emit("voice-session-ended", {
            reason: "session_limit",
            message: "Voice had an issue. Please reconnect to continue where you left off."
          });
        });

        agentWs.on("error", (err) => {
          console.error("❌ Voice agent WebSocket error:", err.message);
          if (!isCurrent()) return;
          socket.emit("nova-error", { error: err.message });
        });

      } catch (error) {
        console.error("❌ Failed to connect to voice agent:", error.message);
        if (!isStale()) {
          socket.emit("nova-error", { error: "Failed to connect to voice agent" });
        }
      }
      return;
    }

    // ── Local child process path (fallback) ───────────────────────────────
    // nova_sonic.py inherits the ECS task role through process.env
    // (AWS_CONTAINER_CREDENTIALS_RELATIVE_URI). Per-user Cognito Identity Pool
    // credentials are deliberately not used: that role is reachable by any
    // signed-in user directly, so it carries no permissions.

    const PORT = process.env.PORT || 80;

    // Try python3 first, then python if that fails
    const pythonCmd = process.env.PYTHON_CMD || "python3";
    console.log(`🐍 PYTHON_CMD env var: ${process.env.PYTHON_CMD}`);
    console.log(`🐍 Using command: ${pythonCmd}`);
    console.log(`🐍 Attempting to spawn: ${pythonCmd} nova_sonic.py`);

    try {
      novaProcess = spawn(pythonCmd, ["nova_sonic.py"], {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          SESSION_ID: sessionId,
          VOICE_ID: config.voice_id || "",
          USER_ID: socket.userId || "anonymous",
          SM_DB_CREDENTIALS: process.env.SM_DB_CREDENTIALS || "",
          RDS_PROXY_ENDPOINT: process.env.RDS_PROXY_ENDPOINT || "",
          PATIENT_NAME: voiceContext.patient_name,
          PATIENT_PROMPT: voiceContext.patient_prompt,
          PATIENT_ID: config.patient_id || "",
          SIMULATION_GROUP_ID: config.simulation_group_id || "",
          LLM_COMPLETION: voiceContext.llm_completion ? "true" : "false",
          EXTRA_SYSTEM_PROMPT: voiceContext.system_prompt,
          APPSYNC_GRAPHQL_URL: process.env.APPSYNC_GRAPHQL_URL || "",
          COGNITO_TOKEN: userToken || "",
        },
      });
      console.log("📡 Nova process spawned with PID:", novaProcess.pid);
    } catch (error) {
      console.error("❌ Failed to spawn Nova process:", error.message);
      socket.emit("nova-error", { error: "Failed to start voice system" });
      return;
    }

    // Capture stdout and stderr
    novaProcess.stdout.on("data", (data) => {
      data
        .toString()
        .split("\n")
        .filter(Boolean)
        .forEach((line) => {
          try {
            const parsed = JSON.parse(line);
            console.log("📤 NOVA JSON:", parsed);

            // ─ Audio chunks ───────────────────────────────────────────────
            if (parsed.type === "audio") {
              // Skip debug file saving for better performance
              socket.emit("audio-chunk", { data: parsed.data });
            }
            // ─ Guardrail blocked the AI reply: discard queued audio ──────
            else if (parsed.type === "audio-flush") {
              socket.emit("audio-flush", {});
            }
            // ─ Turn start signals ─────────────────────────────────────────
            else if (parsed.type === "user-turn-start") {
              socket.emit("turn-start", { role: "user" });
            }
            else if (parsed.type === "turn-start") {
              socket.emit("turn-start", { role: parsed.role });
            }
            // ─ Debug messages ───────────────────────────────────────────
            else if (parsed.type === "debug") {
              console.log("🐞 NOVA DEBUG:", parsed.text);
            }
            // ─ Text messages ─────────────────────────────────────────────
            else if (parsed.type === "user-text") {
              console.log("💬 NOVA USER TEXT:", parsed.text);
              socket.emit("text-message", { text: parsed.text, role: "user" });
            }
            else if (parsed.type === "text") {
              console.log("💬 NOVA TEXT:", parsed.text);
              socket.emit("text-message", { text: parsed.text, role: parsed.role || "assistant" });
              if (parsed.text.includes("Nova Sonic ready")) {
                novaReady = true;
                socket.emit("nova-started", {
                  status: "Nova Sonic session started",
                });
              }
            }
            // ─ Diagnosis completion ──────────────────────────────────────
            else if (parsed.type === "diagnosis_complete") {
              console.log("🎯 DIAGNOSIS COMPLETE:", parsed.text);
              socket.emit("diagnosis-complete", { message: parsed.text });
            } else if (parsed.type === "diagnosis_verdict") {
              console.log("🩺 DIAGNOSIS VERDICT:", parsed.verdict);
              if (parsed.verdict) {
                socket.emit("diagnosis-complete", {
                  message: "Session completed successfully",
                });
              }
            }
            // ─ Guardrail unavailable: refuse/end voice (audio can't be screened)
            else if (parsed.type === "error" && parsed.error === "guardrail_unavailable") {
              console.error("🛡️ Nova process stopped: guardrail unavailable");
              socket.emit("voice-session-ended", {
                reason: parsed.error,
                message: parsed.message || "Voice chat is unavailable right now. Please try again later.",
              });
              if (novaProcess) {
                novaProcess.kill();
                novaProcess = null;
              }
            }
          } catch {
            // Plain‑text fallback
            console.log("[python]", line);
            if (line.includes("Nova Sonic ready")) {
              novaReady = true;
              socket.emit("nova-started", {
                status: "Nova Sonic session started",
              });
            }
            // Forward voice transcriptions with correct role
            if (line.startsWith("User:")) {
              socket.emit("text-message", { text: line.replace("User:", "").trim(), role: "user" });
            } else if (line.startsWith("Assistant:")) {
              socket.emit("text-message", { text: line.replace("Assistant:", "").trim(), role: "assistant" });
            }
            // Handle diagnosis completion in plain text fallback
            if (line.includes("SESSION COMPLETED")) {
              socket.emit("diagnosis-complete", {
                message: "Session completed successfully",
              });
            }
          }
        });
    });

    novaProcess.stderr.on("data", (data) => {
      console.warn("⚠️ Nova stderr:", data.toString().trim());
    });

    novaProcess.on("error", (error) => {
      console.error("❌ Nova process error:", error.message);
      if (error.code === "ENOENT") {
        console.log("🐍 Trying 'python' instead of 'python3'");
        // Retry with 'python' command
        try {
          novaProcess = spawn("python", ["nova_sonic.py"], {
            stdio: ["pipe", "pipe", "pipe"],
            env: {
              ...process.env,
              SESSION_ID: sessionId,
              VOICE_ID: config.voice_id || "",
              USER_ID: socket.userId || "anonymous",
              SM_DB_CREDENTIALS: process.env.SM_DB_CREDENTIALS || "",
              RDS_PROXY_ENDPOINT: process.env.RDS_PROXY_ENDPOINT || "",
              PATIENT_NAME: voiceContext.patient_name,
              PATIENT_PROMPT: voiceContext.patient_prompt,
              PATIENT_ID: config.patient_id || "",
              SIMULATION_GROUP_ID: config.simulation_group_id || "",
              LLM_COMPLETION: voiceContext.llm_completion ? "true" : "false",
              EXTRA_SYSTEM_PROMPT: voiceContext.system_prompt,
              APPSYNC_GRAPHQL_URL: process.env.APPSYNC_GRAPHQL_URL || "",
              COGNITO_TOKEN: userToken || "",
            },
          });
          console.log(
            "📡 Nova process spawned with 'python', PID:",
            novaProcess.pid,
          );
        } catch (retryError) {
          console.error(
            "❌ Failed to spawn with 'python' too:",
            retryError.message,
          );
          socket.emit("nova-error", { error: "Python not found" });
        }
      } else {
        socket.emit("nova-error", { error: error.message });
      }
    });

    const spawnedProcess = novaProcess;
    novaProcess.on("close", (code) => {
      console.log("🔚 Nova process closed with code:", code);
      // A killed predecessor exits after its replacement started; only the
      // current process may reset the session state.
      if (novaProcess !== spawnedProcess) return;
      novaProcess = null;
      novaReady = false;
    });
  });

  // ─── Audio‑input from client ──────────────────────────────────────────────
  let audioStarted = false;
  let lastNovaSonicStart = 0;
  let textGenInFlight = false;
  socket.on("audio-input", (msg) => {
    // ── AgentCore WebSocket path ──────────────────────────────────────────
    if (socket.agentWs && socket.agentWs.readyState === WebSocket.OPEN) {
      if (!audioStarted) {
        socket.agentWs.send(JSON.stringify({ type: "start_audio" }));
        audioStarted = true;
      }
      socket.agentWs.send(JSON.stringify({ type: "audio", data: msg.data }));
      return;
    }

    // ── Local child process path ──────────────────────────────────────────
    if (novaProcess && novaProcess.stdin.writable && novaReady) {
      if (!audioStarted) {
        novaProcess.stdin.write(JSON.stringify({ type: "start_audio" }) + "\n");
        audioStarted = true;
        console.log("🎬 Sent start_audio to Nova process");
      }
      novaProcess.stdin.write(
        JSON.stringify({ type: "audio", data: msg.data }) + "\n",
      );
    } else {
      console.log("❌ Cannot send audio - not ready");
    }
  });

  // ─── Text‑input from client ───────────────────────────────────────────────
  socket.on("text-input", (msg) => {
    // ── AgentCore WebSocket path ──────────────────────────────────────────
    if (socket.agentWs && socket.agentWs.readyState === WebSocket.OPEN) {
      socket.agentWs.send(JSON.stringify({ type: "text", text: msg.text }));
      console.log("📝 Sent text to AgentCore WS");
      return;
    }

    // ── Local child process path ──────────────────────────────────────────
    if (novaProcess && novaProcess.stdin.writable && novaReady) {
      novaProcess.stdin.write(
        JSON.stringify({ type: "text", data: msg.text }) + "\n",
      );
      console.log("📝 Sent text to Nova process");
    }
  });

  // ─── Text generation streaming ─────────────────────────────────────────────
  socket.on("text-generation", async (data) => {
    if (textGenInFlight) return;
    textGenInFlight = true;
    // Log identifiers only: data.token is the caller's bearer token and
    // data.message is student content, so neither may reach CloudWatch.
    console.log("🚀 Text generation request:", {
      session_id: data && data.session_id,
      patient_id: data && data.patient_id,
      simulation_group_id: data && data.simulation_group_id,
    });

    const sessionId = data.session_id;

    // ── Session authorization (fail closed; see session-guard.js) ─────────
    const textAuthz = await authorizeSessionRequest(
      {
        userEmail: socket.userEmail,
        sessionId,
        patientId: data && data.patient_id,
        simulationGroupId: data && data.simulation_group_id,
      },
      verifySessionScope,
    );
    if (!textAuthz.allowed) {
      logger.warn("Session authorization denied for text-generation", {
        component: "server",
        operation: "text-generation",
        userEmail: socket.userEmail,
        sessionId,
      });
      socket.emit("text-stream", {
        type: "error",
        content: textAuthz.error,
      });
      textGenInFlight = false;
      return;
    }

    // The upstream call must run as the user this socket authenticated as.
    // data.token is verified and bound to the handshake identity before use.
    const relayToken = await resolveRelayToken(
      data && data.token,
      { userId: socket.userId, userEmail: socket.userEmail },
      verifyToken,
    );
    if (!relayToken.ok) {
      logger.warn("Relay token rejected for text-generation", {
        component: "server",
        operation: "text-generation",
        userEmail: socket.userEmail,
        sessionId,
      });
      socket.emit("text-stream", {
        type: "error",
        content: relayToken.error,
      });
      textGenInFlight = false;
      return;
    }

    // Register this socket so /stream-callback can find it. With stream=true the
    // Lambda POSTs chunks back to this server's internal NLB URL, which it reads
    // from SSM — the callback destination is never sent in the request.
    // The nonce is sent server-to-server only and must be echoed on every
    // callback; it never reaches the browser.
    // textGenInFlight is cleared when the registration is released, which may
    // be after this handler returns (see the 504 case below).
    const streamNonce = textStreamSockets.register(sessionId, socket, () => {
      textGenInFlight = false;
    });
    let deferRelease = false;

    try {
      const response = await fetch(
        `${process.env.TEXT_GENERATION_ENDPOINT}/student/text_generation?simulation_group_id=${encodeURIComponent(data.simulation_group_id)}&session_id=${encodeURIComponent(sessionId)}&patient_id=${encodeURIComponent(data.patient_id)}&session_name=${encodeURIComponent(data.session_name || "")}&stream=true`,
        {
          method: "POST",
          headers: {
            Authorization: relayToken.token,
            "Content-Type": "application/json",
            "X-Stream-Nonce": streamNonce,
          },
          body: JSON.stringify({ message_content: data.message }),
        },
      );

      if (!response.ok) {
        // Try to parse the error body for specific error messages
        let errorBody = null;
        try {
          errorBody = await response.json();
        } catch (e) {
          // Body not parseable as JSON
        }

        if (response.status === 403 && errorBody && errorBody.error === "Message limit reached") {
          socket.emit("text-stream", {
            type: "error",
            content: errorBody.message || "Message limit reached",
            code: "MESSAGE_LIMIT_REACHED",
          });
          return; // Don't throw — we've handled this error specifically
        }

        if (response.status === 504) {
          // API Gateway caps the integration at 29s, but the Lambda keeps
          // running and keeps POSTing chunks. Keep the registration until its
          // "end"/"error" callback arrives (or the Lambda's max runtime).
          logger.warn("Text generation exceeded the API Gateway timeout; still relaying callbacks", {
            component: "server",
            operation: "text-generation",
            sessionId,
          });
          deferRelease = true;
          textStreamSockets.defer(sessionId, streamNonce, TEXT_STREAM_MAX_MS);
          return;
        }

        throw new Error(`HTTP ${response.status}`);
      }

      // Lambda returns after all chunks have been POSTed to /stream-callback.
      // Nothing to read from the response body — chunks were already relayed.
      console.log("✅ Text generation complete for session:", sessionId);
    } catch (error) {
      console.error("Text generation error:", error);
      socket.emit("text-stream", {
        type: "error",
        content: error.message || "Failed to generate response",
      });
    } finally {
      if (!deferRelease) textStreamSockets.release(sessionId, streamNonce);
    }
  });

  // ─── End‑audio event ─────────────────────────────────────────────────────
  socket.on("end-audio", () => {
    // ── AgentCore WebSocket path ──────────────────────────────────────────
    if (socket.agentWs && socket.agentWs.readyState === WebSocket.OPEN) {
      socket.agentWs.send(JSON.stringify({ type: "end_audio" }));
      audioStarted = false;
      return;
    }

    // ── Local child process path ──────────────────────────────────────────
    if (novaProcess && novaProcess.stdin.writable && novaReady) {
      novaProcess.stdin.write(JSON.stringify({ type: "end_audio" }) + "\n");
      audioStarted = false;
      console.log("🛑 Sent end_audio to Nova process");
    }
  });

  // ─── Voice Preview (mic-based — no agent, no DB) ─────────────────────────
  let ttsProcess = null;
  let ttsReady = false;
  let ttsTimeout = null;

  // Stop this socket's TTS process (if any) and free its limiter slot right
  // away, without waiting for the child to exit, so switching voices is not
  // refused by the concurrency cap.
  function stopTtsProcess() {
    if (ttsTimeout) { clearTimeout(ttsTimeout); ttsTimeout = null; }
    ttsReady = false;
    if (!ttsProcess) return false;
    const child = ttsProcess;
    ttsProcess = null;
    child.kill();
    child.releaseVoiceSlot();
    return true;
  }

  socket.on("voice-preview", (config = {}) => {
    console.log("🎙️ Voice preview requested:", config.voice_id);

    // Replace any previous TTS process for this socket before checking limits
    stopTtsProcess();

    const slot = voicePreviewLimiter.tryAcquire(limiterKey(socket));
    if (!slot.allowed) {
      console.log(`⚠️ Voice preview refused (${slot.reason}) for:`, socket.userEmail);
      socket.emit("nova-error", { error: voicePreviewRefusalMessage(slot) });
      return;
    }

    const pythonCmd = process.env.PYTHON_CMD || "python3";

    let child;
    try {
      child = spawn(pythonCmd, ["voice_preview_tts.py"], {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
        },
      });
    } catch (error) {
      slot.release();
      console.error("❌ Failed to spawn TTS process:", error.message);
      socket.emit("nova-error", { error: "Failed to start voice preview" });
      return;
    }
    child.releaseVoiceSlot = slot.release; // idempotent
    ttsProcess = child;

    // Send initial config (voice_id) — stdin stays open for audio
    ttsProcess.stdin.write(
      JSON.stringify({ voice_id: config.voice_id || "amy" }) + "\n",
    );

    // Start 90s session timeout
    ttsTimeout = setTimeout(() => {
      ttsTimeout = null;
      if (stopTtsProcess()) {
        socket.emit("voice-preview-done", {});
        console.log("⏰ Voice preview TTS process killed by 90s timeout");
      }
    }, TTS_TIMEOUT_MS);

    // Read JSON lines from stdout
    ttsProcess.stdout.on("data", (data) => {
      data.toString().split("\n").filter(Boolean).forEach((line) => {
        try {
          const msg = JSON.parse(line);
          if (msg.type === "audio") {
            socket.emit("audio-chunk", { data: msg.data });
          } else if (msg.type === "ready") {
            ttsReady = true;
            socket.emit("voice-preview-ready", {});
          } else if (msg.type === "done") {
            socket.emit("voice-preview-done", {});
          } else if (msg.type === "error") {
            socket.emit("nova-error", { error: msg.error });
            // The preview can't continue after an error (e.g. guardrail
            // unavailable); stop the process so no further audio is relayed.
            if (ttsProcess === child) stopTtsProcess();
          }
        } catch {
          console.log("[tts]", line);
        }
      });
    });

    ttsProcess.stderr.on("data", (data) => {
      console.warn("⚠️ TTS stderr:", data.toString().trim());
    });

    ttsProcess.on("error", (error) => {
      console.error("❌ TTS process error:", error.message);
      child.releaseVoiceSlot();
      socket.emit("nova-error", { error: "Voice preview failed" });
    });

    ttsProcess.on("close", (code) => {
      console.log("🎙️ TTS process exited with code:", code);
      child.releaseVoiceSlot();
      // A replaced process can exit after its successor started; only clear
      // state that still belongs to this child.
      if (ttsProcess === child) {
        if (ttsTimeout) { clearTimeout(ttsTimeout); ttsTimeout = null; }
        ttsProcess = null;
        ttsReady = false;
      }
    });
  });

  // Relay mic audio to the voice preview process
  socket.on("voice-preview-audio", (msg) => {
    if (ttsProcess && ttsProcess.stdin.writable && ttsReady) {
      ttsProcess.stdin.write(JSON.stringify({ type: "audio", data: msg.data }) + "\n");
    }
  });

  socket.on("voice-preview-start-audio", () => {
    if (ttsProcess && ttsProcess.stdin.writable && ttsReady) {
      ttsProcess.stdin.write(JSON.stringify({ type: "start_audio" }) + "\n");
      console.log("🎬 Voice preview: start_audio");
    }
  });

  socket.on("voice-preview-end-audio", () => {
    if (ttsProcess && ttsProcess.stdin.writable && ttsReady) {
      ttsProcess.stdin.write(JSON.stringify({ type: "end_audio" }) + "\n");
      console.log("🛑 Voice preview: end_audio");
    }
  });

  socket.on("stop-voice-preview", () => {
    if (stopTtsProcess()) {
      console.log("🛑 Voice preview stopped by client");
    }
  });

  // ─── Optional Stop event ────────────────────────────────────────────────
  socket.on("stop-nova-sonic", () => {
    console.log("🛑 Stop requested by client");
    // Abandon any start that is still connecting.
    voiceGeneration++;
    // ── AgentCore WebSocket path ──────────────────────────────────────────
    if (socket.agentWs) {
      closeAgentWs();
      return;
    }

    // ── Local child process path ──────────────────────────────────────────
    if (novaProcess) {
      novaProcess.kill();
      novaProcess = null;
      novaReady = false;
    }
  });

  // ─── Disconnect cleanup ──────────────────────────────────────────────────
  socket.on("disconnect", () => {
    console.log("🔌 CLIENT DISCONNECTED:", socket.id);

    // Clean up TTS preview process if present. Rate-limit history is keyed
    // on the user and deliberately kept, so a reconnect does not reset it.
    stopTtsProcess();

    // Clean up AgentCore WebSocket session if present, and abandon any start
    // that is still connecting so it doesn't open an orphaned session.
    voiceGeneration++;
    closeAgentWs();
  });
});

// ─── Start HTTP server on port 80 ─────────────────────────────────────────
const PORT = process.env.PORT || 80;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Socket server running on port ${PORT}`);
});
