const crypto = require("crypto");
const express = require("express");
const { createServer } = require("http");
const { Server } = require("socket.io");
const { spawn } = require("child_process");
const WebSocket = require("ws");
const { verifyToken } = require("./auth");
const { verifySessionScope } = require("./session-auth");
const { authorizeSessionRequest } = require("./session-guard");
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
// Maps sessionId → Socket.IO socket so we can relay chunks to the right client.
const textStreamSockets = new Map(); // sessionId -> socket

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
  if (req.headers["x-callback-token"] !== streamCallbackToken) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { session_id, data } = req.body;
  if (!session_id || !data) {
    return res.status(400).json({ error: "session_id and data required" });
  }

  const socket = textStreamSockets.get(session_id);
  if (socket && socket.connected) {
    socket.emit("text-stream", data);
  } else {
    console.warn(`⚠️ No socket found for session ${session_id}`);
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

// ─── Voice Preview Rate Limiting ──────────────────────────────────────────────
const voicePreviewTimestamps = new Map(); // socket.id → number[]
const RATE_LIMIT_MAX = 3;
const RATE_LIMIT_WINDOW_MS = 60000;
const TTS_TIMEOUT_MS = 90000;

function isRateLimited(socketId) {
  const now = Date.now();
  const timestamps = voicePreviewTimestamps.get(socketId) || [];
  const recent = timestamps.filter(t => now - t < RATE_LIMIT_WINDOW_MS);
  voicePreviewTimestamps.set(socketId, recent);
  return recent.length >= RATE_LIMIT_MAX;
}

function recordVoicePreview(socketId) {
  const timestamps = voicePreviewTimestamps.get(socketId) || [];
  timestamps.push(Date.now());
  voicePreviewTimestamps.set(socketId, timestamps);
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
    console.log("🔐 User authenticated:", socket.userEmail);
    next();
  } catch (err) {
    console.error("🔐 Authentication failed:", err.message);
    next(new Error("Authentication failed"));
  }
});

io.on("connection", (socket) => {
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
    if (now - lastNovaSonicStart < 2000) return;
    lastNovaSonicStart = now;
    console.log("🚀 Starting Nova Sonic session for client:", socket.id);

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
      socket.emit("nova-error", { error: novaAuthz.error });
      return;
    }

    audioStarted = false;

    // Clean up any previous session
    if (socket.agentWs) {
      try { socket.agentWs.close(); } catch {}
      socket.agentWs = null;
    }
    if (novaProcess) {
      novaProcess.kill();
      novaProcess = null;
    }
    novaReady = false;

    // ── AgentCore WebSocket path ──────────────────────────────────────────
    if (VOICE_AGENT_ARN) {
      console.log("🔀 Using AgentCore WebSocket for ARN:", VOICE_AGENT_ARN);

      // Fetch full patient context from the API if we have IDs
      let patientContext = {};
      if (config.patient_id && config.simulation_group_id && process.env.TEXT_GENERATION_ENDPOINT) {
        try {
          const ctxUrl = `${process.env.TEXT_GENERATION_ENDPOINT}/student/patient_context?simulation_group_id=${encodeURIComponent(config.simulation_group_id)}&patient_id=${encodeURIComponent(config.patient_id)}`;
          console.log("📋 Fetching patient context:", ctxUrl);
          const ctxResp = await fetch(ctxUrl, {
            headers: { Authorization: socket.handshake.auth.token || "" },
          });
          if (ctxResp.ok) {
            patientContext = await ctxResp.json();
            console.log("📋 Patient context loaded:", patientContext.patient_name);
          } else {
            console.warn("⚠️ Patient context fetch failed:", ctxResp.status);
          }
        } catch (err) {
          console.warn("⚠️ Patient context fetch error:", err.message);
        }
      }

      try {
        // For voice mode, prefer voice_persona_prompt when available, fall back to persona_prompt
        const effectiveVoicePrompt = patientContext.voice_persona_prompt || patientContext.persona_prompt || config.patient_prompt || "";

        const agentWs = await connectToVoiceAgent({
          session_id: sessionId,
          voice_id: config.voice_id || "",
          user_id: socket.userId || "anonymous",
          patient_name: patientContext.patient_name || config.patient_name || "",
          patient_prompt: effectiveVoicePrompt,
          patient_id: config.patient_id || "",
          simulation_group_id: config.simulation_group_id || "",
          llm_completion: patientContext.llm_completion || config.llm_completion || false,
          system_prompt: patientContext.system_prompt || config.system_prompt || "",
          cognito_token: socket.handshake.auth.token || "",
          text_generation_endpoint: process.env.TEXT_GENERATION_ENDPOINT || "",
          // The voice agent runs outside CDK, so pass the guardrail it must apply.
          // It fails closed (withholds AI text) if neither this nor its own
          // BEDROCK_GUARDRAIL_ID env var is set.
          guardrail_id: process.env.BEDROCK_GUARDRAIL_ID || "",
          guardrail_region: process.env.BEDROCK_GUARDRAIL_REGION || process.env.AWS_REGION || "",
        });

        socket.agentWs = agentWs;

        // Relay messages from agent back to the frontend
        agentWs.on("message", (data) => {
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
          socket.emit("nova-error", { error: err.message });
        });

      } catch (error) {
        console.error("❌ Failed to connect to voice agent:", error.message);
        socket.emit("nova-error", { error: "Failed to connect to voice agent" });
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
      // For voice mode, prefer voice_persona_prompt when available, fall back to persona_prompt
      const effectiveLocalVoicePrompt = patientContext.voice_persona_prompt || patientContext.persona_prompt || config.patient_prompt || "";

      novaProcess = spawn(pythonCmd, ["nova_sonic.py"], {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          SESSION_ID: sessionId,
          VOICE_ID: config.voice_id || "",
          USER_ID: socket.userId || "anonymous",
          SM_DB_CREDENTIALS: process.env.SM_DB_CREDENTIALS || "",
          RDS_PROXY_ENDPOINT: process.env.RDS_PROXY_ENDPOINT || "",
          PATIENT_NAME: config.patient_name || "",
          PATIENT_PROMPT: effectiveLocalVoicePrompt,
          PATIENT_ID: config.patient_id || "",
          SIMULATION_GROUP_ID: config.simulation_group_id || "",
          LLM_COMPLETION: config.llm_completion ? "true" : "false",
          EXTRA_SYSTEM_PROMPT: config.system_prompt || "",
          APPSYNC_GRAPHQL_URL: process.env.APPSYNC_GRAPHQL_URL || "",
          COGNITO_TOKEN: socket.handshake.auth.token || "",
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
              PATIENT_NAME: config.patient_name || "",
              PATIENT_PROMPT: effectiveLocalVoicePrompt,
              PATIENT_ID: config.patient_id || "",
              SIMULATION_GROUP_ID: config.simulation_group_id || "",
              LLM_COMPLETION: config.llm_completion ? "true" : "false",
              EXTRA_SYSTEM_PROMPT: config.system_prompt || "",
              APPSYNC_GRAPHQL_URL: process.env.APPSYNC_GRAPHQL_URL || "",
              COGNITO_TOKEN: socket.handshake.auth.token || "",
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

    novaProcess.on("close", (code) => {
      console.log("🔚 Nova process closed with code:", code);
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
    console.log("🚀 Text generation request:", data);

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

    // Register this socket so /stream-callback can find it. With stream=true the
    // Lambda POSTs chunks back to this server's internal NLB URL, which it reads
    // from SSM — the callback destination is never sent in the request.
    textStreamSockets.set(sessionId, socket);

    try {
      const response = await fetch(
        `${process.env.TEXT_GENERATION_ENDPOINT}/student/text_generation?simulation_group_id=${encodeURIComponent(data.simulation_group_id)}&session_id=${encodeURIComponent(sessionId)}&patient_id=${encodeURIComponent(data.patient_id)}&session_name=${encodeURIComponent(data.session_name || "")}&stream=true`,
        {
          method: "POST",
          headers: {
            Authorization: data.token,
            "Content-Type": "application/json",
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
      textStreamSockets.delete(sessionId);
      textGenInFlight = false;
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

  socket.on("voice-preview", (config = {}) => {
    console.log("🎙️ Voice preview requested:", config.voice_id);

    // Rate limit check
    if (isRateLimited(socket.id)) {
      console.log("⚠️ Voice preview rate limited for:", socket.id);
      socket.emit("nova-error", { error: "Rate limit exceeded. Please wait before starting another voice preview." });
      return;
    }

    // Kill any previous TTS process for this socket
    if (ttsProcess) {
      if (ttsTimeout) { clearTimeout(ttsTimeout); ttsTimeout = null; }
      ttsProcess.kill();
      ttsProcess = null;
    }
    ttsReady = false;

    // Record this voice preview request for rate limiting
    recordVoicePreview(socket.id);

    const pythonCmd = process.env.PYTHON_CMD || "python3";

    try {
      ttsProcess = spawn(pythonCmd, ["voice_preview_tts.py"], {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
        },
      });
    } catch (error) {
      console.error("❌ Failed to spawn TTS process:", error.message);
      socket.emit("nova-error", { error: "Failed to start voice preview" });
      return;
    }

    // Send initial config (voice_id) — stdin stays open for audio
    ttsProcess.stdin.write(
      JSON.stringify({ voice_id: config.voice_id || "amy" }) + "\n",
    );

    // Start 90s session timeout
    ttsTimeout = setTimeout(() => {
      if (ttsProcess) {
        ttsProcess.kill();
        ttsProcess = null;
        ttsReady = false;
        socket.emit("voice-preview-done", {});
        console.log("⏰ Voice preview TTS process killed by 90s timeout");
      }
      ttsTimeout = null;
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
            if (ttsProcess) {
              ttsProcess.kill();
              ttsProcess = null;
              ttsReady = false;
            }
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
      socket.emit("nova-error", { error: "Voice preview failed" });
    });

    ttsProcess.on("close", (code) => {
      if (ttsTimeout) { clearTimeout(ttsTimeout); ttsTimeout = null; }
      console.log("🎙️ TTS process exited with code:", code);
      ttsProcess = null;
      ttsReady = false;
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
    if (ttsTimeout) { clearTimeout(ttsTimeout); ttsTimeout = null; }
    if (ttsProcess) {
      ttsProcess.kill();
      ttsProcess = null;
      ttsReady = false;
      console.log("🛑 Voice preview stopped by client");
    }
  });

  // ─── Optional Stop event ────────────────────────────────────────────────
  socket.on("stop-nova-sonic", () => {
    console.log("🛑 Stop requested by client");
    // ── AgentCore WebSocket path ──────────────────────────────────────────
    if (socket.agentWs) {
      try {
        socket.agentWs.send(JSON.stringify({ type: "end_session" }));
        socket.agentWs.close();
      } catch {}
      socket.agentWs = null;
      novaReady = false;
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

    // Clean up TTS preview process if present
    if (ttsTimeout) { clearTimeout(ttsTimeout); ttsTimeout = null; }
    if (ttsProcess) {
      ttsProcess.kill();
      ttsProcess = null;
    }

    // Clean up rate limit state for this connection
    voicePreviewTimestamps.delete(socket.id);

    // Clean up AgentCore WebSocket session if present
    if (socket.agentWs) {
      try {
        socket.agentWs.send(JSON.stringify({ type: "end_session" }));
        socket.agentWs.close();
      } catch {}
      socket.agentWs = null;
    }
  });
});

// ─── Start HTTP server on port 80 ─────────────────────────────────────────
const PORT = process.env.PORT || 80;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Socket server running on port ${PORT}`);
});
