"""Chat history persistence — DynamoDB + PostgreSQL.

Ported from cdk/socket-server/langchain_chat_history.py for the
agentcore voice agent container.
"""

import json
import os
import uuid
import logging
from datetime import datetime

import boto3
import psycopg2
from langchain_community.chat_message_histories import DynamoDBChatMessageHistory
from langchain_core.messages import AIMessage, HumanMessage

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

connection = None
db_secret = None

secrets_manager_client = boto3.client("secretsmanager")

RDS_PROXY_ENDPOINT = os.environ.get("RDS_PROXY_ENDPOINT")
# RDS Proxy presents an ACM certificate; verify it (and the hostname) against
# the Amazon Trust Services roots in the OS trust store (AL2023 image).
# https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-proxy.howitworks.html#rds-proxy-security.tls
DB_SSL_ROOT_CERT = os.environ.get("PGSSLROOTCERT", "/etc/pki/tls/certs/ca-bundle.crt")
DB_SECRET_NAME = os.environ.get("SM_DB_CREDENTIALS")
_TABLE_NAME = os.environ.get("TABLE_NAME")


def format_chat_history(
    session_id: str, table_name: str = None, patient_name: str = None
) -> str:
    """Render the recent transcript for injection into the system prompt.

    Speakers are labelled concretely ("Student:" and the patient's actual name)
    rather than with generic "User:"/"Assistant:" labels. On session resumption
    after an inactivity timeout the whole transcript re-enters as plain text,
    and its labelling is the model's only grounding for who said what — generic
    labels require it to hold a User->student / Assistant->patient mapping that
    nothing in the transcript itself reinforces.
    """
    table_name = table_name or _TABLE_NAME
    if not table_name:
        raise RuntimeError("TABLE_NAME environment variable is not set")
    history = DynamoDBChatMessageHistory(table_name=table_name, session_id=session_id)
    recent_messages = history.messages[-10:]

    student_label = "Student"
    patient_label = (patient_name or "").strip() or "Patient"

    lines = []
    for m in recent_messages:
        role = student_label if m.type == "human" else patient_label
        content = m.content.strip().replace("\n", " ")
        safe_content = json.dumps(content)[1:-1]
        lines.append(f"{role}: {safe_content}")
    return "\n".join(lines)


def add_message(
    session_id: str, role: str, content: str, table_name: str = None
):
    table_name = table_name or _TABLE_NAME
    if not table_name:
        raise RuntimeError("TABLE_NAME environment variable is not set")
    history = DynamoDBChatMessageHistory(table_name=table_name, session_id=session_id)
    if role == "user":
        history.add_message(HumanMessage(content=content))
    elif role == "ai":
        history.add_message(AIMessage(content=content))
    else:
        raise ValueError(f"Invalid role '{role}'. Must be 'user' or 'ai'.")


def get_secret(secret_name, expect_json=True):
    global db_secret
    if db_secret is None:
        response = secrets_manager_client.get_secret_value(SecretId=secret_name)["SecretString"]
        db_secret = json.loads(response) if expect_json else response
    return db_secret


def connect_to_db():
    global connection
    if connection is None or connection.closed:
        secret = get_secret(DB_SECRET_NAME)
        connection_params = {
            "dbname": secret["dbname"],
            "user": secret["username"],
            "password": secret["password"],
            "host": RDS_PROXY_ENDPOINT,
            "port": secret["port"],
            "sslmode": "verify-full",
            "sslrootcert": DB_SSL_ROOT_CERT,
        }
        connection_string = " ".join(f"{k}={v}" for k, v in connection_params.items())
        connection = psycopg2.connect(connection_string)
        logger.info("Connected to the database")
    return connection


def reset_db_connection():
    """Drop the cached secret and connection so the next connect_to_db re-reads
    the current app_rw password.

    db_setup rotates that password on every run; a long-lived container caches
    both the secret and the connection, so after a rotation it must rebuild both
    to recover.
    """
    global connection, db_secret
    stale = connection
    connection = None
    db_secret = None
    if stale is not None:
        try:
            stale.close()
        except Exception:
            pass


def _is_pg_auth_error(exc) -> bool:
    """Detect a DB authentication failure (wrong/rotated password).

    Postgres reports invalid passwords as SQLSTATE 28P01 / 28000; RDS Proxy
    surfaces it as "The password that was provided for the role X is wrong."
    """
    pgcode = getattr(exc, "pgcode", None)
    if pgcode in ("28P01", "28000"):
        return True
    msg = str(exc).lower()
    return "password" in msg and ("wrong" in msg or "authentication failed" in msg)


def insert_message_to_postgres(session_id: str, role: str, content: str):
    sender = "student" if role == "user" else "ai"

    def _insert():
        conn = connect_to_db()
        cursor = conn.cursor()
        cursor.execute(
            """INSERT INTO messages (message_id, chat_id, sender_type, message_content, sent_at)
               VALUES (%s, %s, %s, %s, %s)""",
            (str(uuid.uuid4()), session_id, sender, content, datetime.utcnow()),
        )
        conn.commit()
        cursor.close()

    for attempt in (1, 2):
        try:
            _insert()
            logger.info("Saved message to PostgreSQL (session=%s, role=%s)", session_id, role)
            return
        except Exception as e:
            # Roll back if we have a live connection; ignore if the failure was
            # establishing the connection itself.
            if connection is not None and not getattr(connection, "closed", 1):
                try:
                    connection.rollback()
                except Exception:
                    pass
            if attempt == 1 and _is_pg_auth_error(e):
                logger.warning(
                    "DB auth failed on message insert (credential rotation suspected); "
                    "resetting connection and retrying once."
                )
                reset_db_connection()
                continue
            logger.error("Failed to insert message: %s", e)
            return
