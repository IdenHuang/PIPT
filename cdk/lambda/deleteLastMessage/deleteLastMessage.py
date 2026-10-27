import os
import boto3
import json
import logging
import psycopg2
from cors_helper import get_cors_headers

logger = logging.getLogger()
logger.setLevel(logging.INFO)

# AWS Clients
dynamodb_client = boto3.client('dynamodb')
secrets_manager_client = boto3.client('secretsmanager')
ssm_client = boto3.client("ssm")

# Global variables for caching
connection = None
db_secret = None
TABLE_NAME = None

DB_SECRET_NAME = os.environ["SM_DB_CREDENTIALS"]
RDS_PROXY_ENDPOINT = os.environ["RDS_PROXY_ENDPOINT"]
# RDS Proxy presents an ACM certificate; verify it (and the hostname) against
# the Amazon Trust Services roots in the OS trust store.
# https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-proxy.howitworks.html#rds-proxy-security.tls
DB_SSL_ROOT_CERT = os.environ.get("PGSSLROOTCERT", "/etc/pki/tls/certs/ca-bundle.crt")

def get_secret(secret_name, expect_json=True):
    global db_secret
    if db_secret is None:
        try:
            response = secrets_manager_client.get_secret_value(SecretId=secret_name)["SecretString"]
            db_secret = json.loads(response) if expect_json else response
        except json.JSONDecodeError as e:
            logger.error(f"Failed to decode JSON for secret {secret_name}: {e}")
            raise ValueError(f"Secret {secret_name} is not properly formatted as JSON.")
        except Exception as e:
            logger.error(f"Error fetching secret {secret_name}: {e}")
            raise
    return db_secret

def get_parameter(param_name):
    """
    Fetch a parameter value from Systems Manager Parameter Store.
    """
    global TABLE_NAME
    if TABLE_NAME is None:
        try:
            response = ssm_client.get_parameter(Name=param_name, WithDecryption=True)
            TABLE_NAME = response["Parameter"]["Value"]
        except Exception as e:
            logger.error(f"Error fetching parameter {param_name}: {e}")
            raise
    return TABLE_NAME

def connect_to_db():
    global connection
    if connection is None or connection.closed:
        try:
            secret = get_secret(DB_SECRET_NAME)
            connection_params = {
                'dbname': secret["dbname"],
                'user': secret["username"],
                'password': secret["password"],
                'host': RDS_PROXY_ENDPOINT,
                'port': secret["port"],
                'sslmode': 'verify-full',
                'sslrootcert': DB_SSL_ROOT_CERT,
            }
            connection_string = " ".join([f"{key}={value}" for key, value in connection_params.items()])
            connection = psycopg2.connect(connection_string)
            logger.info("Connected to the database!")
        except Exception as e:
            logger.error(f"Failed to connect to database: {e}")
            if connection:
                connection.rollback()
                connection.close()
            raise
    return connection

def delete_last_two_db_messages(session_id):
    connection = connect_to_db()
    if connection is None:
        logger.error("No database connection available.")
        return None
    try:
        cur = connection.cursor()

        cur.execute("""
            SELECT message_id 
            FROM "messages" 
            WHERE chat_id = %s
            ORDER BY sent_at DESC
            LIMIT 2;
        """, (session_id,))
        
        messages = cur.fetchall()

        if len(messages) < 2:
            logger.info(f"Not enough messages to delete for session_id: {session_id}")
            cur.close()
            return False
        
        message_ids = tuple([msg[0] for msg in messages])
        
        cur.execute("""
            DELETE FROM "messages"
            WHERE message_id IN %s;
        """, (message_ids,))
        
        connection.commit()
        cur.close()
        logger.info(f"Successfully deleted the last two messages for session_id: {session_id}")
        return True

    except Exception as e:
        logger.error(f"Error deleting messages from database: {e}")
        if cur:
            cur.close()
        connection.rollback()
        return False

def verify_session_ownership(session_id, user_email):
    """Return True if user_email owns the session, False otherwise."""
    conn = connect_to_db()
    try:
        cur = conn.cursor()
        cur.execute("""
            SELECT c.chat_id
            FROM chats c
            JOIN student_interactions si ON c.student_interaction_id = si.student_interaction_id
            JOIN enrollments e ON si.enrollment_id = e.enrollment_id
            JOIN users u ON e.user_id = u.user_id
            WHERE c.chat_id = %s AND u.user_email = %s
        """, (session_id, user_email))
        row = cur.fetchone()
        cur.close()
        return row is not None
    except Exception as e:
        logger.error(f"Error verifying session ownership: {e}")
        return False


def lambda_handler(event, context):
    query_params = event.get("queryStringParameters", {})

    session_id = query_params.get("session_id", "")

    if not session_id:
        logger.error("Missing required parameter: session_id")
        return {
            'statusCode': 400,
            "headers": get_cors_headers(event),
            'body': json.dumps('Missing required parameter: session_id')
        }

    authorizer = event.get("requestContext", {}).get("authorizer", {})
    user_email = authorizer.get("email", "")

    # Check admin role from the database (single source of truth for roles)
    is_admin = False
    if user_email:
        conn = connect_to_db()
        cur = conn.cursor()
        try:
            cur.execute(
                """SELECT roles FROM "users" WHERE user_email = %s""",
                (user_email,)
            )
            row = cur.fetchone()
            cur.close()
            if row and row[0] and "admin" in row[0]:
                is_admin = True
        except Exception as e:
            cur.close()
            logger.error(f"Error checking admin role: {e}")

    if not is_admin:
        if not user_email:
            return {
                'statusCode': 403,
                "headers": get_cors_headers(event),
                'body': json.dumps('Forbidden')
            }
        if not verify_session_ownership(session_id, user_email):
            logger.warning(f"Ownership check failed: user={user_email} session={session_id}")
            return {
                'statusCode': 403,
                "headers": get_cors_headers(event),
                'body': json.dumps('Forbidden')
            }

    try:
        # Fetch the conversation history from DynamoDB
        table_name = get_parameter(os.environ["TABLE_NAME_PARAM"])
        response = dynamodb_client.get_item(
            TableName=table_name,
            Key={
                'SessionId': {
                    'S': session_id
                }
            }
        )

        if 'Item' not in response or 'History' not in response['Item']:
            logger.error(f"No conversation history found for session_id: {session_id}")
            return {
                'statusCode': 400,
                "headers": get_cors_headers(event),
                'body': json.dumps(f"No conversation history found for session_id: {session_id}")
            }

        history = response['Item']['History']['L']
        
        # There must be 2 messages in the history, 1 from AI and 1 from student
        if len(history) < 2:
            logger.info("Not enough messages to delete.")
            return {
                'statusCode': 400,
                "headers": get_cors_headers(event),
                'body': json.dumps(f"Not enough messages to delete for session_id: {session_id}")
            }

        # Remove the last AI and human messages by popping the last two elements
        history.pop()
        history.pop()

        # Update the conversation history in DynamoDB
        dynamodb_client.update_item(
            TableName=table_name,
            Key={
                'SessionId': {
                    'S': session_id
                }
            },
            UpdateExpression="SET History = :history",
            ExpressionAttributeValues={
                ":history": {"L": history}
            }
        )

        logger.info(f"Successfully deleted the last human and AI messages in DynamoDB for session_id: {session_id}")

        if delete_last_two_db_messages(session_id):
            logger.info(f"Successfully deleted the last human and AI messages in RDS for session_id: {session_id}")
            return {
                'statusCode': 200,
                "headers": get_cors_headers(event),
                'body': json.dumps(f"Successfully deleted the last human and AI messages for session_id: {session_id}")
            }
        else:
            logger.error(f"Failed to delete the last human and AI messages in RDS for session_id: {session_id}")
            return {
                'statusCode': 500,
                "headers": get_cors_headers(event),
                'body': json.dumps(f"Error deleting last messages from the database for session_id: {session_id}")
            }

    except Exception as e:
        logger.error(f"Error deleting last message: {e}")
        return {
            'statusCode': 500,
            "headers": get_cors_headers(event),
            'body': json.dumps("Internal server error")
        }