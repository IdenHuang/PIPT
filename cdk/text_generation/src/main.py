# Force CodePipeline rebuild - cohere embed v4 region fix
import os
import re
import json
import time
import boto3
import logging
import psycopg
from botocore.config import Config
from botocore.exceptions import ClientError
from langchain_aws import BedrockEmbeddings
from helpers.cohere_embeddings import CohereBedrockEmbeddings

from helpers.chat import get_bedrock_llm, get_initial_student_query, get_student_query, set_stream_callback_url, get_default_system_prompt
from helpers.seed_prompt import seed_prompt
from helpers.authz import AuthzDecision, authorize_request, is_valid_uuid, playground_history_key

# Set up basic logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger()
logger.setLevel(logging.INFO)

# Environment variables
DB_SECRET_NAME = os.environ["SM_DB_CREDENTIALS"]
REGION = os.environ["REGION"]

# CORS: Use ALLOWED_ORIGINS env var (comma-separated) instead of wildcard.
# Entries may contain "*" for subdomains (e.g. "https://*.amplifyapp.com").
# Matching mirrors cdk/layers/cors/python/cors_helper.py,
# cdk/lambda/lib/cors.js, cdk/lambda/adminFunction/cors.js and
# cdk/socket-server/server.js; this container-image Lambda cannot use the layer.
# Unset/empty fails closed (no origin allowed); only an explicit "*" allows all.
_ALLOWED_ORIGINS = [o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "").split(",") if o.strip()]

# "*" matches one or more DNS labels (letters, digits, hyphens joined by dots), so
# it can never span a scheme, port, userinfo or path delimiter (":", "@", "/").
_WILDCARD_HOST_LABELS = r"[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*"


def _origin_pattern(pattern):
    """Compile an allowed-origin entry; "*" matches one or more DNS labels."""
    return re.compile("^" + re.escape(pattern).replace(r"\*", _WILDCARD_HOST_LABELS) + "$")


_ALLOWED_ORIGIN_PATTERNS = [_origin_pattern(o) for o in _ALLOWED_ORIGINS if o != "*"]


def _get_cors_origin(event):
    """Return the Access-Control-Allow-Origin value based on the request origin."""
    if not _ALLOWED_ORIGINS:
        return ""  # misconfigured: fail closed, browsers reject an empty origin
    if "*" in _ALLOWED_ORIGINS:
        return "*"
    headers = event.get("headers") or {}
    origin = headers.get("origin") or headers.get("Origin") or ""
    if origin and any(p.fullmatch(origin) for p in _ALLOWED_ORIGIN_PATTERNS):
        return origin
    # Fallback: return first allowed origin (won't match but is safe)
    return _ALLOWED_ORIGINS[0]
RDS_PROXY_ENDPOINT = os.environ["RDS_PROXY_ENDPOINT"]
# RDS Proxy presents an ACM certificate; verify it (and the hostname) against
# the Amazon Trust Services roots in the OS trust store.
# https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-proxy.howitworks.html#rds-proxy-security.tls
DB_SSL_ROOT_CERT = os.environ.get("PGSSLROOTCERT", "/etc/pki/tls/certs/ca-bundle.crt")
BEDROCK_LLM_PARAM = os.environ["BEDROCK_LLM_PARAM"]
EMBEDDING_MODEL_PARAM = os.environ["EMBEDDING_MODEL_PARAM"]
TABLE_NAME_PARAM = os.environ["TABLE_NAME_PARAM"]
APPSYNC_GRAPHQL_URL = os.environ.get("APPSYNC_GRAPHQL_URL", "")
STREAM_CALLBACK_URL_PARAM = os.environ.get("STREAM_CALLBACK_URL_PARAM", "")

# AWS Clients
secrets_manager_client = boto3.client("secretsmanager")
ssm_client = boto3.client("ssm", region_name=REGION)
bedrock_runtime = boto3.client("bedrock-runtime", region_name=REGION)
# Cohere Embed v4 cross-region inference (us.*) requires a US source region.
# When deployed outside the US (e.g. ca-central-1), route embedding calls to us-east-1.
BEDROCK_EMBEDDING_REGION = os.environ.get("BEDROCK_EMBEDDING_REGION", "us-east-1")
bedrock_embedding_client = boto3.client(
    "bedrock-runtime",
    region_name=BEDROCK_EMBEDDING_REGION,
    config=Config(
        retries={"max_attempts": 8, "mode": "adaptive"},
        read_timeout=120,
    ),
)

# Cached resources
connection = None
db_secret = None
db_secret_loaded_at = 0.0
# The app_rw password in SM_DB_CREDENTIALS is rotated by the db_setup Lambda on
# every deploy, so the cached secret is re-read periodically and on auth failure.
DB_SECRET_TTL_SECONDS = 300
BEDROCK_LLM_ID = None
EMBEDDING_MODEL_ID = None
TABLE_NAME = None
STREAM_CALLBACK_URL = None

# Cached embeddings instance
embeddings = None

# Default prompts used when DB values are null/empty
DEFAULT_SYSTEM_PROMPT = get_default_system_prompt("{patient_name}")

DEFAULT_PERSONA_PROMPT = """You are a patient visiting a pharmacy. Use ONLY the information provided in your uploaded case documents to describe your symptoms, medical history, and concerns. Do not invent or fabricate any symptoms, medications, diagnoses, or history beyond what is in the documents. If asked about something not covered in the documents, respond as a patient who genuinely does not know or has not experienced that issue."""

def get_secret(secret_name, expect_json=True, force_refresh=False):
    """Return the DB secret, cached for DB_SECRET_TTL_SECONDS.

    force_refresh=True re-reads it immediately (used after an authentication
    failure, i.e. the password was rotated since it was cached).
    """
    global db_secret, db_secret_loaded_at
    expired = (time.monotonic() - db_secret_loaded_at) > DB_SECRET_TTL_SECONDS
    if db_secret is None or force_refresh or expired:
        try:
            response = secrets_manager_client.get_secret_value(SecretId=secret_name)["SecretString"]
            db_secret = json.loads(response) if expect_json else response
            db_secret_loaded_at = time.monotonic()
        except json.JSONDecodeError as e:
            logger.error(f"Failed to decode JSON for secret {secret_name}: {e}")
            raise ValueError(f"Secret {secret_name} is not properly formatted as JSON.")
        except Exception as e:
            logger.error(f"Error fetching secret {secret_name}: {e}")
            raise
    return db_secret


def get_parameter(param_name, cached_var):
    """
    Fetch a parameter value from Systems Manager Parameter Store.
    """
    if cached_var is None:
        try:
            response = ssm_client.get_parameter(Name=param_name, WithDecryption=True)
            cached_var = response["Parameter"]["Value"]
        except Exception as e:
            logger.error(f"Error fetching parameter {param_name}: {e}")
            raise
    return cached_var

def get_stream_callback_url():
    """
    Return the trusted socket server callback base URL from SSM, or None.

    The URL is deliberately sourced from deployment config rather than the
    request: the callback carries the x-callback-token secret, so a
    caller-chosen URL would leak it (and give blind SSRF from the VPC).
    Only successful lookups are cached, so a missing parameter (e.g. API stack
    deployed before EcsSocket) is retried on the next invocation. Returning
    None makes publish_to_appsync fall back to the AppSync path.
    """
    global STREAM_CALLBACK_URL
    if STREAM_CALLBACK_URL is None and STREAM_CALLBACK_URL_PARAM:
        try:
            response = ssm_client.get_parameter(Name=STREAM_CALLBACK_URL_PARAM)
            STREAM_CALLBACK_URL = response["Parameter"]["Value"].rstrip("/") or None
        except Exception as e:
            logger.error(f"Error fetching stream callback URL parameter {STREAM_CALLBACK_URL_PARAM}: {e}")
    return STREAM_CALLBACK_URL

_STREAM_NONCE_RE = re.compile(r"^[0-9a-f]{64}$")

def _get_stream_nonce(headers):
    """Return the socket server's X-Stream-Nonce header if well-formed, else None."""
    for key, value in (headers or {}).items():
        if isinstance(key, str) and key.lower() == "x-stream-nonce":
            if isinstance(value, str) and _STREAM_NONCE_RE.fullmatch(value):
                return value
            return None
    return None

def initialize_constants():
    global BEDROCK_LLM_ID, EMBEDDING_MODEL_ID, TABLE_NAME, embeddings
    BEDROCK_LLM_ID = get_parameter(BEDROCK_LLM_PARAM, BEDROCK_LLM_ID)
    EMBEDDING_MODEL_ID = get_parameter(EMBEDDING_MODEL_PARAM, EMBEDDING_MODEL_ID)
    TABLE_NAME = get_parameter(TABLE_NAME_PARAM, TABLE_NAME)

    if embeddings is None:
        if EMBEDDING_MODEL_ID.startswith("cohere.embed"):
            embeddings = CohereBedrockEmbeddings(
                model_id=EMBEDDING_MODEL_ID,
                client=bedrock_embedding_client,
                region_name=BEDROCK_EMBEDDING_REGION,
            )
        else:
            embeddings = BedrockEmbeddings(
                model_id=EMBEDDING_MODEL_ID,
                client=bedrock_embedding_client,
                region_name=BEDROCK_EMBEDDING_REGION,
            )
    


def _open_connection():
    """Open a fresh psycopg connection to the RDS proxy.

    autocommit=True is deliberate: this Lambda only runs read-only SELECTs.
    With autocommit disabled, every SELECT implicitly opened a transaction
    that was never committed, leaving the session "idle in transaction".
    Because the connection is cached across warm Lambda invocations, the
    database (or RDS proxy) eventually terminated that idle-in-transaction
    session, and the next reuse failed with "the connection is lost".
    autocommit=True means no open transaction lingers between invocations.

    On an authentication failure (app_rw password rotated by db_setup since
    the secret was cached) the secret is re-read and the connect retried once.
    """
    def _connect(secret):
        return psycopg.connect(
            host=RDS_PROXY_ENDPOINT,
            port=secret["port"],
            dbname=secret["dbname"],
            user=secret["username"],
            password=secret["password"],
            autocommit=True,
            sslmode="verify-full",
            sslrootcert=DB_SSL_ROOT_CERT,
        )

    try:
        conn = _connect(get_secret(DB_SECRET_NAME))
    except psycopg.OperationalError as e:
        if not _is_auth_error(e):
            raise
        logger.warning("DB authentication failed; re-reading rotated credentials and retrying once")
        conn = _connect(get_secret(DB_SECRET_NAME, force_refresh=True))
    logger.info("Connected to the database!")
    return conn


def _is_auth_error(error):
    """True for a wrong/rotated password (SQLSTATE 28P01/28000, or RDS Proxy's message)."""
    if getattr(error, "sqlstate", None) in ("28P01", "28000"):
        return True
    msg = str(error).lower()
    return "password" in msg and ("authentication failed" in msg or "wrong" in msg)


def _vectorstore_config(persona_id, force_refresh=False):
    """PGVector connection settings for a persona's collection."""
    secret = get_secret(DB_SECRET_NAME, force_refresh=force_refresh)
    return {
        'collection_name': persona_id,
        'dbname': secret["dbname"],
        'user': secret["username"],
        'password': secret["password"],
        'host': RDS_PROXY_ENDPOINT,
        'port': secret["port"],
    }


def _get_history_aware_retriever(llm, persona_id):
    """Build the RAG retriever, retrying once with a freshly read DB secret.

    PGVector opens its own connection, so a rotated app_rw password surfaces
    here rather than in connect_to_db(); the retry picks up the new password.
    """
    from helpers.vectorstore import get_vectorstore_retriever
    try:
        return get_vectorstore_retriever(
            llm=llm, vectorstore_config_dict=_vectorstore_config(persona_id), embeddings=embeddings
        )
    except Exception as e:
        logger.warning(f"Vector store setup failed; retrying with refreshed DB credentials: {type(e).__name__}")
        return get_vectorstore_retriever(
            llm=llm,
            vectorstore_config_dict=_vectorstore_config(persona_id, force_refresh=True),
            embeddings=embeddings,
        )


def _connection_is_alive(conn):
    """Cheap liveness probe. `conn.closed` only reflects client-side state and
    won't detect a server-side termination (idle timeout, proxy reaping, etc.),
    so we actively ping with SELECT 1."""
    if conn is None or conn.closed:
        return False
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT 1")
            cur.fetchone()
        return True
    except Exception:
        return False


def connect_to_db():
    global connection
    # Reuse the cached connection only if it's actually alive. This guards
    # against stale connections that were terminated server-side between warm
    # Lambda invocations (the root cause of intermittent "connection is lost").
    if _connection_is_alive(connection):
        return connection

    # Cached connection is dead or missing — discard and reconnect.
    if connection is not None:
        try:
            connection.close()
        except Exception:
            pass
        connection = None

    try:
        connection = _open_connection()
    except Exception as e:
        logger.error(f"Failed to connect to database: {e}")
        if connection:
            try:
                connection.close()
            except Exception:
                pass
            connection = None
        raise
    return connection

def _safe_cleanup_after_error(cur):
    """Close the cursor and drop the cached connection if it has died.

    On a lost/terminated connection we must clear the module-level cache so the
    next connect_to_db() call opens a fresh one instead of reusing a dead socket.
    """
    global connection
    if cur is not None:
        try:
            cur.close()
        except Exception:
            pass
    if not _connection_is_alive(connection):
        if connection is not None:
            try:
                connection.close()
            except Exception:
                pass
        connection = None


def _authorize(mode, caller_email, session_id, persona_id, simulation_group_id):
    """Run the authorization policy in helpers/authz.py; fail closed on DB errors."""
    cur = None
    try:
        cur = connect_to_db().cursor()
        decision = authorize_request(
            cur,
            mode=mode,
            email=caller_email,
            session_id=session_id,
            persona_id=persona_id,
            simulation_group_id=simulation_group_id,
        )
        cur.close()
        return decision
    except Exception as e:
        logger.error(f"Authorization check failed: {e}")
        _safe_cleanup_after_error(cur)
        return AuthzDecision(False, 500, "Authorization check failed")


# One-time marker for a chat's opening AI turn (the empty-message request).
# It lives in the conversation table, which is keyed only on SessionId and
# already holds prefixed items such as QCACHE#, so no schema change is needed.
# The conditional put makes the claim atomic across concurrent requests.
INITIAL_PROMPT_KEY_PREFIX = "INIT#"
_INITIAL_PROMPT_FAILED = "failed"
# A claim older than this is treated as abandoned and can be taken again, so a
# chat whose opening turn died without releasing the claim recovers on its own.
# Must exceed the text-gen Lambda timeout (300s in api-service-stack.ts) so an
# in-flight generation is never overtaken.
INITIAL_PROMPT_CLAIM_STALE_SECONDS = 360
_dynamodb_resource = None


def _conversation_table():
    global _dynamodb_resource
    if _dynamodb_resource is None:
        _dynamodb_resource = boto3.resource("dynamodb", region_name=REGION)
    return _dynamodb_resource.Table(TABLE_NAME)


def claim_initial_prompt(session_id):
    """Atomically claim the chat's single opening turn.

    Returns True if this request won the claim, False if it is already held.
    A claim that was released (failed generation) or is older than
    INITIAL_PROMPT_CLAIM_STALE_SECONDS can be taken again so the student can
    retry the greeting. Other DynamoDB errors propagate (callers fail closed).
    """
    now = int(time.time())
    try:
        _conversation_table().put_item(
            Item={
                "SessionId": f"{INITIAL_PROMPT_KEY_PREFIX}{session_id}",
                "claim_status": "claimed",
                "claimed_at": now,
            },
            ConditionExpression=(
                "attribute_not_exists(SessionId) OR claim_status = :failed OR claimed_at < :stale"
            ),
            ExpressionAttributeValues={
                ":failed": _INITIAL_PROMPT_FAILED,
                ":stale": now - INITIAL_PROMPT_CLAIM_STALE_SECONDS,
            },
        )
        return True
    except ClientError as e:
        if e.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
            return False
        raise


def release_initial_prompt(session_id):
    """Mark the opening-turn claim as failed so it can be retried."""
    try:
        _conversation_table().update_item(
            Key={"SessionId": f"{INITIAL_PROMPT_KEY_PREFIX}{session_id}"},
            UpdateExpression="SET claim_status = :failed",
            ExpressionAttributeValues={":failed": _INITIAL_PROMPT_FAILED},
        )
    except Exception as e:
        logger.error(f"Failed to release initial-prompt claim for session {session_id}: {e}")


def _chat_has_ai_turn(session_id):
    """True if the chat has a persisted AI message; False if not or unknown.

    get_response() swallows generation errors and save_message_to_db() swallows
    insert errors, so a 200 does not prove the opening turn was saved.
    """
    try:
        cur = connect_to_db().cursor()
        cur.execute(
            """SELECT EXISTS (SELECT 1 FROM "messages" WHERE chat_id = %s AND sender_type = 'ai')""",
            (session_id,),
        )
        row = cur.fetchone()
        cur.close()
        return bool(row and row[0])
    except Exception as e:
        logger.error(f"Could not verify opening turn for session {session_id}: {e}")
        return False


def _stored_student_message(message_id, session_id):
    """Return the stored text of a student message in this chat, or None.

    mode=match grades whatever text it is given, so it must use the persisted
    content, never the request body. Scoping to
    sender_type='student' matches fetch_tagged_messages, which only scores
    student rows. DB errors propagate so the caller returns 500.
    """
    cur = connect_to_db().cursor()
    try:
        cur.execute(
            """SELECT message_content FROM "messages"
               WHERE message_id = %s AND chat_id = %s AND sender_type = 'student'""",
            (message_id, session_id),
        )
        row = cur.fetchone()
    finally:
        cur.close()
    return row[0] if row else None


def get_system_prompt(simulation_group_id):
    connection = connect_to_db()
    if connection is None:
        logger.error("No database connection available.")
        return {
            "statusCode": 500,
            "body": json.dumps("Database connection failed.")
        }
    
    try:
        cur = connection.cursor()
        
        cur.execute("""
            SELECT system_prompt
            FROM "simulation_groups"
            WHERE simulation_group_id = %s;
        """, (simulation_group_id,))

        result = cur.fetchone()
        system_prompt = result[0] if result else None

        cur.close()

        if system_prompt and system_prompt.strip():
            # Log metadata only, never the instructor-authored prompt text.
            logger.info(f"System prompt for simulation_group_id {simulation_group_id} found: prompt_chars={len(system_prompt)}")
            return system_prompt
        else:
            logger.warning(f"No system prompt configured for simulation_group_id={simulation_group_id}, using default")
            return DEFAULT_SYSTEM_PROMPT

    except Exception as e:
        logger.error(f"Error fetching system prompt: {e}")
        _safe_cleanup_after_error(locals().get("cur"))
        return None


def get_persona_details(persona_id):
    connection = connect_to_db()
    if connection is None:
        logger.error("No database connection available.")
        return {
            "statusCode": 500,
            "body": json.dumps("Database connection failed.")
        }
    
    try:
        cur = connection.cursor()
        logger.info("Connected to RDS instance!")
        cur.execute("""
            SELECT persona_name, persona_age, persona_prompt
            FROM "personas"
            WHERE persona_id = %s;
        """, (persona_id,))

        result = cur.fetchone()

        cur.close()

        if result:
            persona_name, persona_age, persona_prompt = result
            persona_prompt = seed_prompt(persona_prompt, DEFAULT_PERSONA_PROMPT)
            llm_completion = True
            # Log metadata only: the persona prompt is instructor-authored
            # configuration and must not be copied into CloudWatch.
            logger.info(f"persona details found for persona_id {persona_id}: "
                        f"prompt_chars={len(persona_prompt or '')}, LLM Completion: {llm_completion}")
            return persona_name, persona_age, persona_prompt, llm_completion
        else:
            logger.warning(f"No details found for persona_id {persona_id}")
            return None, None, None, None

    except Exception as e:
        logger.error(f"Error fetching persona details: {e}")
        _safe_cleanup_after_error(locals().get("cur"))
        return None, None, None, None




def handler(event, context):
    # Version: 2024-01-15-empathy-fix-v2 - Force new deployment
    # Never log the raw event or headers: they carry the caller's Cognito JWT
    # (Authorization) and the request body (student messages).
    logger.info("🚀 STREAMING FUNCTION STARTED - Text Generation Lambda function is called!")
    initialize_constants()

    # The caller's Cognito token is not kept: AppSync publishes are SigV4-signed
    # with this Lambda's role (publish_to_appsync in helpers/chat.py), because
    # publishTextStream is IAM-only.
    headers = event.get('headers') or {}

    # TODO(refactor): Extract parameter extraction and validation into a helper function
    query_params = event.get("queryStringParameters", {})
    simulation_group_id = query_params.get("simulation_group_id", "")
    session_id = query_params.get("session_id", "")
    persona_id = query_params.get("patient_id", "")
    student_user_id = event.get('requestContext', {}).get('authorizer', {}).get('userId', '')

    # When the ECS socket server calls us with stream=true, POST streaming
    # chunks to its /stream-callback route instead of going through AppSync.
    # The destination always comes from SSM config; any caller-supplied
    # stream_callback_url query parameter is intentionally ignored.
    # The socket server also sends a per-request X-Stream-Nonce, echoed on every
    # callback; the socket server rejects callbacks whose nonce doesn't match
    # its registration. A malformed nonce is dropped rather than forwarded.
    # (The frontend only listens on the socket, so there is no useful AppSync
    # fallback for stream=true requests.)
    wants_socket_stream = query_params.get("stream", "false").lower() == "true"
    stream_nonce = _get_stream_nonce(headers) if wants_socket_stream else None
    set_stream_callback_url(
        get_stream_callback_url() if wants_socket_stream else None,
        stream_nonce,
    )

    if not simulation_group_id or not session_id or not persona_id:
        return {
            'statusCode': 400,
            "headers": {
                "Content-Type": "application/json",
                "Access-Control-Allow-Headers": "*",
                "Access-Control-Allow-Origin": _get_cors_origin(event),
                "Access-Control-Allow-Methods": "*",
            },
            'body': json.dumps("Missing required parameters: simulation_group_id, session_id, or persona_id")
        }

    # =========================================================================
    # MODE BRANCHING: "debrief" vs default "chat"
    # =========================================================================
    # TODO(refactor): Extract mode branching into a helper function that dispatches to mode-specific handlers
    mode = query_params.get("mode", "chat")
    # TODO(refactor): Extract mode branching into a helper function that dispatches to mode-specific handlers
    mode = query_params.get("mode", "chat")

    # =========================================================================
    # AUTHORIZATION — the API Gateway authorizer only authenticates the JWT.
    # Verify the caller may act on this session/persona/group before any mode
    # reads history, writes messages/debriefs, or publishes stream events.
    # =========================================================================
    caller_email = event.get('requestContext', {}).get('authorizer', {}).get('email', '')
    decision = _authorize(mode, caller_email, session_id, persona_id, simulation_group_id)
    if not decision.allowed:
        logger.warning(
            f"Authorization denied: mode={mode} status={decision.status_code} "
            f"reason={decision.reason} session={session_id} user={student_user_id}"
        )
        return {
            'statusCode': decision.status_code,
            "headers": {
                "Content-Type": "application/json",
                "Access-Control-Allow-Headers": "*",
                "Access-Control-Allow-Origin": _get_cors_origin(event),
                "Access-Control-Allow-Methods": "*",
            },
            'body': json.dumps({"error": decision.reason}),
        }
    if mode == "test_system_prompt":
        # Bind playground history to the caller. The client ID is only a suffix,
        # so another instructor replaying it lands on a different DynamoDB key.
        session_id = playground_history_key(caller_email, session_id)
    if mode == "debrief":
        # TODO(refactor): Extract debrief mode handling into a helper function
        logger.info(f"📋 DEBRIEF MODE — generating debrief for session={session_id}")
        from helpers.chat import generate_debrief
        patient_mode = query_params.get("patient_mode", "interview_practice")
        try:
            llm = get_bedrock_llm(bedrock_llm_id=BEDROCK_LLM_ID, streaming=False)
            debrief_result = generate_debrief(
                session_id=session_id,
                simulation_group_id=simulation_group_id,
                persona_id=persona_id,
                llm=llm,
                embeddings_model=embeddings,
                ddb_table_name=TABLE_NAME,
                patient_mode=patient_mode,
            )
            return {
                "statusCode": 200,
                "headers": {
                    "Content-Type": "application/json",
                    "Access-Control-Allow-Headers": "*",
                    "Access-Control-Allow-Origin": _get_cors_origin(event),
                    "Access-Control-Allow-Methods": "*",
                },
                "body": json.dumps(debrief_result, default=str),
            }
        except Exception as e:
            logger.error(f"Debrief generation failed: {e}")
            logger.exception("Full debrief error:")
            return {
                "statusCode": 500,
                "headers": {
                    "Content-Type": "application/json",
                    "Access-Control-Allow-Headers": "*",
                    "Access-Control-Allow-Origin": _get_cors_origin(event),
                    "Access-Control-Allow-Methods": "*",
                },
                "body": json.dumps({"error": "Internal server error"}),
            }

    if mode == "match":
        # TODO(refactor): Extract match mode handling into a helper function
        logger.info(f"🔄 MATCH MODE — running semantic matching for session={session_id}")
        try:
            body = {} if event.get("body") is None else json.loads(event.get("body"))
            message_id = body.get("message_id", "")
            # Any message_content in the body is ignored: matching runs on the
            # stored text so a caller can't tag a message with questions it
            # never asked (security finding f-67d50d61).

            if not is_valid_uuid(message_id):
                return {
                    "statusCode": 400,
                    "headers": {
                        "Content-Type": "application/json",
                        "Access-Control-Allow-Headers": "*",
                        "Access-Control-Allow-Origin": _get_cors_origin(event),
                        "Access-Control-Allow-Methods": "*",
                    },
                    "body": json.dumps("Missing or invalid field: message_id"),
                }

            message_content = _stored_student_message(message_id, session_id)
            if not message_content or not message_content.strip():
                return {
                    "statusCode": 404,
                    "headers": {
                        "Content-Type": "application/json",
                        "Access-Control-Allow-Headers": "*",
                        "Access-Control-Allow-Origin": _get_cors_origin(event),
                        "Access-Control-Allow-Methods": "*",
                    },
                    "body": json.dumps({"error": "Message not found"}),
                }

            from helpers.chat import match_message_to_questions, get_cached_key_questions, cache_key_questions, fetch_org_thresholds
            
            # Fetch org-level thresholds once per request
            org_thresholds = fetch_org_thresholds(simulation_group_id)

            # Check cache first to save time and Bedrock API costs.
            # Use explicit None check — an empty list [] means the cache was
            # populated but there are no key questions for this patient, which
            # is a valid state and should not trigger a re-cache.
            try:
                cached = get_cached_key_questions(session_id, TABLE_NAME)
                if cached is None:
                    cache_key_questions(
                        session_id=session_id,
                        simulation_group_id=simulation_group_id,
                        persona_id=persona_id,
                        embeddings_model=embeddings,
                        table_name=TABLE_NAME,
                    )
            except Exception as e:
                logger.warning(f"Failed to handle key questions cache: {e}")

            # Run SYNCHRONOUSLY so Lambda actually writes to the DB before freezing
            match_message_to_questions(
                message_content=message_content,
                session_id=session_id,
                message_id=message_id,
                embeddings_model=embeddings,
                table_name=TABLE_NAME,
                bedrock_llm_id=BEDROCK_LLM_ID,
                key_question_threshold=org_thresholds["key_question_threshold"],
            )

            return {
                "statusCode": 200,
                "headers": {
                    "Content-Type": "application/json",
                    "Access-Control-Allow-Headers": "*",
                    "Access-Control-Allow-Origin": _get_cors_origin(event),
                    "Access-Control-Allow-Methods": "*",
                },
                "body": json.dumps({"status": "matching_started"}),
            }
        except Exception as e:
            logger.error(f"Match mode failed: {e}")
            return {
                "statusCode": 500,
                "headers": {
                    "Content-Type": "application/json",
                    "Access-Control-Allow-Headers": "*",
                    "Access-Control-Allow-Origin": _get_cors_origin(event),
                    "Access-Control-Allow-Methods": "*",
                },
                "body": json.dumps({"error": "Internal server error"}),
            }

    if mode == "test_debrief":
        # TODO(refactor): Extract test_debrief mode handling into a helper function
        logger.info(f"🧪 TEST DEBRIEF MODE — generating test debrief for session={session_id}")
        from helpers.chat import generate_test_debrief
        try:
            body = json.loads(event.get("body") or "{}")
            debrief_prompt = body.get("debrief_prompt", "").strip()
            if not debrief_prompt:
                return {
                    "statusCode": 400,
                    "headers": {
                        "Content-Type": "application/json",
                        "Access-Control-Allow-Headers": "*",
                        "Access-Control-Allow-Origin": _get_cors_origin(event),
                        "Access-Control-Allow-Methods": "*",
                    },
                    "body": json.dumps({"error": "debrief_prompt is required"}),
                }

            llm = get_bedrock_llm(bedrock_llm_id=BEDROCK_LLM_ID, streaming=False)
            result = generate_test_debrief(
                session_id=session_id,
                simulation_group_id=simulation_group_id,
                persona_id=persona_id,
                llm=llm,
                debrief_prompt=debrief_prompt,
                embeddings_model=embeddings,
                ddb_table_name=TABLE_NAME,
            )
            return {
                "statusCode": 200,
                "headers": {
                    "Content-Type": "application/json",
                    "Access-Control-Allow-Headers": "*",
                    "Access-Control-Allow-Origin": _get_cors_origin(event),
                    "Access-Control-Allow-Methods": "*",
                },
                "body": json.dumps(result, default=str),
            }
        except Exception as e:
            logger.error(f"Test debrief generation failed: {e}")
            logger.exception("Full test debrief error:")
            return {
                "statusCode": 500,
                "headers": {
                    "Content-Type": "application/json",
                    "Access-Control-Allow-Headers": "*",
                    "Access-Control-Allow-Origin": _get_cors_origin(event),
                    "Access-Control-Allow-Methods": "*",
                },
                "body": json.dumps({"error": "Internal server error"}),
            }

    if mode == "test_system_prompt":
        logger.info(f"🧪 TEST SYSTEM PROMPT MODE — chat with custom system prompt for persona={persona_id}")
        from helpers.chat import get_response
        try:
            body = json.loads(event.get("body") or "{}")
            custom_system_prompt = body.get("system_prompt", "").strip()
            message_content = body.get("message_content", "").strip()

            if not custom_system_prompt:
                custom_system_prompt = DEFAULT_SYSTEM_PROMPT

            patient_name, patient_age, patient_prompt, llm_completion = get_persona_details(persona_id)
            if patient_name is None:
                return {
                    "statusCode": 400,
                    "headers": {
                        "Content-Type": "application/json",
                        "Access-Control-Allow-Headers": "*",
                        "Access-Control-Allow-Origin": _get_cors_origin(event),
                        "Access-Control-Allow-Methods": "*",
                    },
                    "body": json.dumps({"error": "Persona not found"}),
                }

            # Allow overriding the patient prompt from the request body
            custom_patient_prompt = body.get("patient_prompt", "").strip()
            if custom_patient_prompt:
                patient_prompt = custom_patient_prompt

            if not message_content:
                student_query = get_initial_student_query(patient_name)
                is_playground_initial = True
            else:
                student_query = get_student_query(message_content)
                is_playground_initial = False

            llm = get_bedrock_llm(bedrock_llm_id=BEDROCK_LLM_ID, streaming=False)

            history_aware_retriever = _get_history_aware_retriever(llm, persona_id)

            response = get_response(
                query=student_query,
                patient_name=patient_name,
                llm=llm,
                history_aware_retriever=history_aware_retriever,
                table_name=TABLE_NAME,
                session_id=session_id,
                system_prompt=custom_system_prompt,
                patient_age=patient_age,
                patient_prompt=patient_prompt,
                llm_completion=llm_completion,
                stream=False,
                student_user_id=student_user_id,
                persona_id=persona_id,
                embeddings_model=embeddings,
                ddb_table_name=TABLE_NAME,
                raw_prompt_mode=True,
                is_initial_prompt=is_playground_initial,
                # Playground IDs are "test-..." scratch keys, not chat UUIDs:
                # never write them to the graded "messages" table.
                persist_messages=False,
            )

            return {
                "statusCode": 200,
                "headers": {
                    "Content-Type": "application/json",
                    "Access-Control-Allow-Headers": "*",
                    "Access-Control-Allow-Origin": _get_cors_origin(event),
                    "Access-Control-Allow-Methods": "*",
                },
                "body": json.dumps({
                    "llm_output": response.get("llm_output", "LLM failed to create response"),
                }),
            }
        except Exception as e:
            logger.error(f"Test system prompt chat failed: {e}")
            logger.exception("Full test system prompt error:")
            return {
                "statusCode": 500,
                "headers": {
                    "Content-Type": "application/json",
                    "Access-Control-Allow-Headers": "*",
                    "Access-Control-Allow-Origin": _get_cors_origin(event),
                    "Access-Control-Allow-Methods": "*",
                },
                "body": json.dumps({"error": "Internal server error"}),
            }

    # =========================================================================
    # DEFAULT CHAT MODE — existing flow below
    # =========================================================================

    # Lazy imports for chat mode
    from helpers.chat import get_response, cache_key_questions, fetch_org_thresholds

    # Fetch org-level thresholds once per request for key question matching
    org_thresholds = fetch_org_thresholds(simulation_group_id)

    # TODO(refactor): Extract system prompt and persona detail fetching into a helper function
    system_prompt = get_system_prompt(simulation_group_id)
    if system_prompt is None:
        logger.error(f"Error fetching system prompt for simulation_group_id: {simulation_group_id}")
        return {
            'statusCode': 400,
            "headers": {
                "Content-Type": "application/json",
                "Access-Control-Allow-Headers": "*",
                "Access-Control-Allow-Origin": _get_cors_origin(event),
                "Access-Control-Allow-Methods": "*",
            },
            'body': json.dumps('Error fetching system prompt')
        }

    patient_name, patient_age, patient_prompt, llm_completion = get_persona_details(persona_id)
    if patient_name is None or patient_age is None or patient_prompt is None or llm_completion is None:
        logger.error(f"Error fetching persona details for persona_id: {persona_id}")
        return {
            'statusCode': 400,
            "headers": {
                "Content-Type": "application/json",
                "Access-Control-Allow-Headers": "*",
                "Access-Control-Allow-Origin": _get_cors_origin(event),
                "Access-Control-Allow-Methods": "*",
            },
            'body': json.dumps('Error fetching persona details')
        }

    body = {} if event.get("body") is None else json.loads(event.get("body"))
    question = body.get("message_content", "")
    
    logger.info(f"Received message ({len(question)} chars)")

    # An empty message asks for the AI patient's opening turn. That is allowed
    # once per chat: the limit check below rejects it once an AI turn exists,
    # and claim_initial_prompt() closes the race between concurrent requests.
    is_initial_prompt = not question
    if is_initial_prompt:
        logger.info(f"Start of conversation requested for session {session_id}.")
        student_query = get_initial_student_query(patient_name)
    else:
        # Student messages are educational records: log their size, never their text.
        logger.info(f"Processing student question: question_chars={len(question or '')}")
        student_query = get_student_query(question)
        
    logger.info(f"🔍 FINAL STUDENT QUERY built: query_chars={len(student_query or '')}")

    # ── Message Limit Check ──────────────────────────────────────────────
    # Runs on every request, including the opening turn, so an empty message
    # can never skip the cap.
    try:
        conn = connect_to_db()
        cur = conn.cursor()
        # Resolve the cap from the group that owns this chat, never from the
        # caller-supplied simulation_group_id. Fail closed if unresolvable.
        cur.execute("""
            SELECT sg.max_messages_per_chat
            FROM "chats" c
            JOIN "student_interactions" si ON si.student_interaction_id = c.student_interaction_id
            JOIN "enrollments" e ON e.enrollment_id = si.enrollment_id
            JOIN "simulation_groups" sg ON sg.simulation_group_id = e.simulation_group_id
            WHERE c.chat_id = %s
        """, (session_id,))
        group_result = cur.fetchone()
        if group_result is None:
            logger.warning(f"Message limit check: chat {session_id} has no owning group; rejecting")
            cur.close()
            return {
                'statusCode': 403,
                "headers": {
                    "Content-Type": "application/json",
                    "Access-Control-Allow-Headers": "*",
                    "Access-Control-Allow-Origin": _get_cors_origin(event),
                    "Access-Control-Allow-Methods": "*",
                },
                'body': json.dumps({"error": "Forbidden"})
            }
        # NULL cap on an existing group means "unlimited"
        max_messages = group_result[0]

        cur.execute("""
            SELECT COUNT(*) FILTER (WHERE sender_type = 'student')::int,
                   COUNT(*) FILTER (WHERE sender_type = 'ai')::int
            FROM "messages"
            WHERE chat_id = %s
        """, (session_id,))
        count_result = cur.fetchone()
        student_count, ai_count = count_result if count_result else (0, 0)
        cur.close()

        # The opening turn happens once: if the chat already has an AI turn,
        # an empty message is a replay, not a start of conversation.
        if is_initial_prompt and ai_count > 0:
            logger.info(f"Rejecting repeated initial prompt for session {session_id} (ai_count={ai_count})")
            return {
                'statusCode': 409,
                "headers": {
                    "Content-Type": "application/json",
                    "Access-Control-Allow-Headers": "*",
                    "Access-Control-Allow-Origin": _get_cors_origin(event),
                    "Access-Control-Allow-Methods": "*",
                },
                'body': json.dumps({"error": "Conversation already started"})
            }

        if max_messages is not None and student_count >= max_messages:
            logger.info(f"Message limit reached: {student_count}/{max_messages} for session {session_id}")
            return {
                'statusCode': 403,
                "headers": {
                    "Content-Type": "application/json",
                    "Access-Control-Allow-Headers": "*",
                    "Access-Control-Allow-Origin": _get_cors_origin(event),
                    "Access-Control-Allow-Methods": "*",
                },
                'body': json.dumps({
                    "error": "Message limit reached",
                    "message": f"You have reached the maximum of {max_messages} messages for this conversation.",
                    "max_messages": max_messages,
                })
            }
    except Exception as e:
        # Fail closed — do not invoke the LLM if the limit cannot be verified
        logger.error(f"Error checking message limit (failing closed): {e}")
        return {
            'statusCode': 500,
            "headers": {
                "Content-Type": "application/json",
                "Access-Control-Allow-Headers": "*",
                "Access-Control-Allow-Origin": _get_cors_origin(event),
                "Access-Control-Allow-Methods": "*",
            },
            'body': json.dumps({"error": "Unable to verify message limit"})
        }

    # Check if streaming is requested
    query_params = event.get("queryStringParameters", {})
    stream = query_params.get("stream", "false").lower() == "true"
    
    try:
        logger.info("Creating Bedrock LLM instance.")
        llm = get_bedrock_llm(bedrock_llm_id=BEDROCK_LLM_ID, streaming=stream)
    except Exception as e:
        logger.error(f"Error getting LLM from Bedrock: {e}")
        return {
            'statusCode': 500,
            "headers": {
                "Content-Type": "application/json",
                "Access-Control-Allow-Headers": "*",
                "Access-Control-Allow-Origin": _get_cors_origin(event),
                "Access-Control-Allow-Methods": "*",
            },
            'body': json.dumps('Error getting LLM from Bedrock')
        }

    try:
        logger.info("Creating history-aware retriever.")
        history_aware_retriever = _get_history_aware_retriever(llm, persona_id)
    except Exception as e:
        logger.error(f"Error creating history-aware retriever: {e}")
        return {
            'statusCode': 500,
            "headers": {
                "Content-Type": "application/json",
                "Access-Control-Allow-Headers": "*",
                "Access-Control-Allow-Origin": _get_cors_origin(event),
                "Access-Control-Allow-Methods": "*",
            },
            'body': json.dumps('Error creating history-aware retriever')
        }

    if is_initial_prompt:
        try:
            claimed = claim_initial_prompt(session_id)
        except Exception as e:
            # Fail closed — without the claim, concurrent replays could each generate
            logger.error(f"Error claiming initial prompt (failing closed): {e}")
            return {
                'statusCode': 500,
                "headers": {
                    "Content-Type": "application/json",
                    "Access-Control-Allow-Headers": "*",
                    "Access-Control-Allow-Origin": _get_cors_origin(event),
                    "Access-Control-Allow-Methods": "*",
                },
                'body': json.dumps({"error": "Unable to start conversation"})
            }
        if not claimed:
            logger.info(f"Initial prompt already claimed for session {session_id}")
            return {
                'statusCode': 409,
                "headers": {
                    "Content-Type": "application/json",
                    "Access-Control-Allow-Headers": "*",
                    "Access-Control-Allow-Origin": _get_cors_origin(event),
                    "Access-Control-Allow-Methods": "*",
                },
                'body': json.dumps({"error": "Conversation already started"})
            }
        # Cache key questions once, on the opening turn, for real-time matching
        try:
            cache_key_questions(
                session_id=session_id,
                simulation_group_id=simulation_group_id,
                persona_id=persona_id,
                embeddings_model=embeddings,
                table_name=TABLE_NAME,
            )
        except Exception as e:
            logger.error(f"Failed to cache key questions: {e}")

    try:
        logger.info("Generating response from the LLM.")
        
        logger.info(f"🚀 CALLING get_response: query_chars={len(student_query or '')}")
        response = get_response(
            query=student_query,
            patient_name=patient_name,
            llm=llm,
            history_aware_retriever=history_aware_retriever,
            table_name=TABLE_NAME,
            session_id=session_id,
            system_prompt=system_prompt,
            patient_age=patient_age,
            patient_prompt=patient_prompt,
            llm_completion=llm_completion,
            stream=stream,
            student_user_id=student_user_id,
            persona_id=persona_id,
            embeddings_model=embeddings,
            ddb_table_name=TABLE_NAME,
            is_initial_prompt=is_initial_prompt,
            key_question_threshold=org_thresholds["key_question_threshold"],
        )
    except Exception as e:
        logger.error(f"Error getting response: {e}")
        logger.exception("Full error details:")
        if is_initial_prompt:
            release_initial_prompt(session_id)
        return {
            'statusCode': 500,
            "headers": {
                "Content-Type": "application/json",
                "Access-Control-Allow-Headers": "*",
                "Access-Control-Allow-Origin": _get_cors_origin(event),
                "Access-Control-Allow-Methods": "*",
            },
            'body': json.dumps("Internal server error")
        }

    # Generation and persistence errors are swallowed inside get_response, so
    # release the claim whenever no AI turn was saved; otherwise the student
    # could never retry the greeting.
    if is_initial_prompt and not _chat_has_ai_turn(session_id):
        logger.warning(f"Opening turn for session {session_id} was not persisted; releasing claim")
        release_initial_prompt(session_id)

    # TODO(refactor): Extract response formatting into a helper function
    if stream:
        logger.info("Returning streaming response.")
        return {
            "statusCode": 200,
            "headers": {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "Access-Control-Allow-Headers": "*",
                "Access-Control-Allow-Origin": _get_cors_origin(event),
                "Access-Control-Allow-Methods": "*",
            },
            "body": json.dumps(response),
            "isBase64Encoded": False
        }
    else:
        logger.info("Returning the generated response.")
        return {
            "statusCode": 200,
            "headers": {
                "Content-Type": "application/json",
                "Access-Control-Allow-Headers": "*",
                "Access-Control-Allow-Origin": _get_cors_origin(event),
                "Access-Control-Allow-Methods": "*",
            },
            "body": json.dumps({
                "llm_output": response.get("llm_output", "LLM failed to create response"),
                "llm_verdict": response.get("llm_verdict", "LLM failed to create verdict"),
            })
        }
