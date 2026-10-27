import os
import json
import boto3
import psycopg2
from aws_lambda_powertools import Logger
from cors_helper import get_cors_headers

logger = Logger()

s3 = boto3.client('s3')
BUCKET = os.environ["BUCKET"]
DB_SECRET_NAME = os.environ["SM_DB_CREDENTIALS"]
RDS_PROXY_ENDPOINT = os.environ["RDS_PROXY_ENDPOINT"]
# RDS Proxy presents an ACM certificate; verify it (and the hostname) against
# the Amazon Trust Services roots in the OS trust store.
# https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-proxy.howitworks.html#rds-proxy-security.tls
DB_SSL_ROOT_CERT = os.environ.get("PGSSLROOTCERT", "/etc/pki/tls/certs/ca-bundle.crt")

# AWS Clients
secrets_manager_client = boto3.client('secretsmanager')

# Global variables for caching
connection = None
db_secret = None

def get_secret():
    global db_secret
    if not db_secret:
        response = secrets_manager_client.get_secret_value(SecretId=DB_SECRET_NAME)["SecretString"]
        db_secret = json.loads(response)
    return db_secret

def connect_to_db():
    global connection
    if connection is None or connection.closed:
        try:
            secret = get_secret()
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

def verify_instructor_ownership(user_email, simulation_group_id):
    """Verify the requesting user is an instructor of the target simulation group or an admin."""
    conn = connect_to_db()
    cur = conn.cursor()
    try:
        cur.execute(
            """SELECT 1 FROM "users" u
               WHERE u.user_email = %s
               AND (
                 'admin' = ANY(u.roles)
                 OR EXISTS (
                   SELECT 1 FROM "enrollments" e
                   WHERE e.user_id = u.user_id AND e.simulation_group_id = %s AND e.enrollment_type = 'instructor'
                 )
               )""",
            (user_email, simulation_group_id)
        )
        result = cur.fetchone()
        cur.close()
        return result is not None
    except Exception as e:
        cur.close()
        logger.error(f"Error verifying instructor ownership: {e}")
        return False

@logger.inject_lambda_context
def lambda_handler(event, context):
    # Extract user identity from authorizer context
    user_email = event.get("requestContext", {}).get("authorizer", {}).get("email", "")

    query_params = event.get("queryStringParameters", {})
    simulation_group_id = query_params.get("simulation_group_id", "")
    persona_id = query_params.get("persona_id", "")

    if not simulation_group_id or not persona_id:
        logger.error("Missing required parameters", extra={
            "simulation_group_id": simulation_group_id,
            "persona_id": persona_id
        })
        return {
            'statusCode': 400,
            "headers": get_cors_headers(event),
            'body': json.dumps("Missing required parameters: simulation_group_id or persona_id")
        }

    # Verify the requesting instructor owns this simulation group
    if not verify_instructor_ownership(user_email, simulation_group_id):
        logger.warning("Unauthorized access attempt", extra={
            "user_email": user_email,
            "simulation_group_id": simulation_group_id
        })
        return {
            'statusCode': 403,
            "headers": get_cors_headers(event),
            'body': json.dumps('Forbidden: You are not an instructor of this simulation group')
        }

    try:
        # Define the prefix for the persona's files
        persona_prefix = f"{simulation_group_id}/{persona_id}/"

        objects_to_delete = []
        continuation_token = None

        # Fetch all objects in the persona's directory, handling pagination
        while True:
            if continuation_token:
                response = s3.list_objects_v2(
                    Bucket=BUCKET,
                    Prefix=persona_prefix,
                    ContinuationToken=continuation_token
                )
            else:
                response = s3.list_objects_v2(Bucket=BUCKET, Prefix=persona_prefix)

            if 'Contents' in response:
                objects_to_delete.extend([{'Key': obj['Key']} for obj in response['Contents']])

            # Check if there's more data to fetch
            if response.get('IsTruncated'):
                continuation_token = response.get('NextContinuationToken')
            else:
                break

        if objects_to_delete:
            # Delete all objects in the persona's directory
            delete_response = s3.delete_objects(
                Bucket=BUCKET,
                Delete={'Objects': objects_to_delete}
            )
            logger.info(f"Deleted objects: {delete_response}")
            return {
                'statusCode': 200,
                "headers": get_cors_headers(event),
                'body': json.dumps(f"Deleted persona directory: {persona_prefix}")
            }
        else:
            logger.info(f"No objects found in persona directory: {persona_prefix}")
            return {
                'statusCode': 200,
                "headers": get_cors_headers(event),
                'body': json.dumps(f"No objects found in persona directory: {persona_prefix}")
            }

    except Exception as e:
        logger.exception(f"Error deleting persona directory: {e}")
        return {
            'statusCode': 500,
            "headers": get_cors_headers(event),
            'body': json.dumps("Internal server error")
        }