"""AgentCore voice agent entry point.

This is the container's main process. It runs on Bedrock AgentCore (not ECS)
and exposes the three required AgentCore endpoints:

  GET  /ping          — health check (AgentCore uses this to know we're alive)
  POST /invocations   — HTTP request handler (returns agent info; not used for voice)
  WS   /ws            — bidirectional audio streaming via WebSocket

The socket server (server.js on ECS) connects to /ws via a SigV4-signed
WebSocket through the AgentCore runtime proxy. Each WebSocket connection
maps to one voice chat session with one patient.

Flow:
  socket server → AgentCore proxy → /ws → websocket_handler() → NovaSonic
"""

import logging
from bedrock_agentcore import BedrockAgentCoreApp
from nova_sonic import NovaSonic, require_session_id

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = BedrockAgentCoreApp()


@app.entrypoint
async def handle_invocation(payload, context):
    """HTTP /invocations handler — returns agent status."""
    return {"status": "healthy", "agent": "voice-agent", "model": "amazon.nova-2-sonic-v1:0"}


@app.websocket
async def websocket_handler(websocket, context):
    """WebSocket /ws handler — bidirectional audio streaming.

    Protocol:
    1. Client sends an init message with session config:
       {"type": "init", "session_id": "...", "voice_id": "...",
        "patient_name": "...", "patient_prompt": "...", "patient_id": "...",
        "llm_completion": false, "system_prompt": "...", "user_id": "...",
        "guardrail_id": "...", "guardrail_region": "..."}
    2. Client sends audio frames:
       {"type": "start_audio"}
       {"type": "audio", "data": "<base64 PCM>"}
       {"type": "end_audio"}
    3. Agent sends back:
       {"type": "text", "text": "Nova Sonic ready"}
       {"type": "audio", "data": "<base64 PCM>"}
       {"type": "text", "text": "...transcription..."}
       {"type": "diagnosis_complete", "text": "..."}
    4. Client sends {"type": "end_session"} to close.
    """
    await websocket.accept()
    logger.info("WebSocket connection accepted")

    try:
        # 1. Wait for init message with session config
        init_msg = await websocket.receive_json()

        if init_msg.get("type") != "init":
            await websocket.send_json({"type": "error", "text": "Expected init message"})
            await websocket.close()
            return

        # session_id is the sole conversation-history partition key. Reject a
        # missing/invalid one instead of falling back to a shared key; the
        # socket server has already verified the caller owns this chat.
        try:
            session_id = require_session_id(init_msg.get("session_id"))
        except ValueError as e:
            logger.warning("Rejected init message: %s", e)
            await websocket.send_json({"type": "error", "text": str(e)})
            await websocket.close()
            return

        logger.info("Session init: session_id=%s, patient=%s",
                     session_id, init_msg.get("patient_name"))

        # 2. Create NovaSonic client with config from init message
        nova = NovaSonic(
            websocket=websocket,
            voice_id=init_msg.get("voice_id"),
            session_id=session_id,
            patient_name=init_msg.get("patient_name", ""),
            patient_prompt=init_msg.get("patient_prompt", ""),
            patient_id=init_msg.get("patient_id", ""),
            simulation_group_id=init_msg.get("simulation_group_id", ""),
            llm_completion=init_msg.get("llm_completion", False),
            extra_system_prompt=init_msg.get("system_prompt", ""),
            user_id=init_msg.get("user_id"),
            cognito_token=init_msg.get("cognito_token", ""),
            text_generation_endpoint=init_msg.get("text_generation_endpoint", ""),
            # Used only when the runtime has no BEDROCK_GUARDRAIL_ID /
            # BEDROCK_GUARDRAIL_REGION env vars (runtime config takes precedence).
            guardrail_id=init_msg.get("guardrail_id", ""),
            guardrail_region=init_msg.get("guardrail_region", ""),
        )

        # 3. Start the Nova Sonic session (opens Bedrock stream)
        await nova.start_session()

        # 4. Handle audio frames until the client disconnects
        await nova.handle_websocket()

    except Exception as e:
        logger.error("WebSocket session error: %s", e)
    finally:
        try:
            await websocket.close()
        except Exception:
            pass  # WebSocket may already be disconnected
        logger.info("WebSocket connection closed")


if __name__ == "__main__":
    app.run(log_level="info")
