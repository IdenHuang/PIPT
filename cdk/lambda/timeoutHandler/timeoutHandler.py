import os
import json
import boto3
import logging
import psycopg2
from aws_lambda_powertools import Logger

logger = Logger()

# Environment Variables
DB_SECRET_NAME = os.environ["SM_DB_CREDENTIALS"]
RDS_PROXY_ENDPOINT = os.environ["RDS_PROXY_ENDPOINT"]
# RDS Proxy presents an ACM certificate; verify it (and the hostname) against
# the Amazon Trust Services roots in the OS trust store.
# https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-proxy.howitworks.html#rds-proxy-security.tls
DB_SSL_ROOT_CERT = os.environ.get("PGSSLROOTCERT", "/etc/pki/tls/certs/ca-bundle.crt")
# Name of the data-ingestion timeout alarm; any other alarm is ignored.
TIMEOUT_ALARM_NAME = os.environ["TIMEOUT_ALARM_NAME"]
# A row is only treated as stuck once it has been 'processing' this long.
# Set from the data-ingestion Lambda timeout (minus a small margin) in CDK, so
# rows owned by an invocation that is still running are left alone.
STUCK_AFTER_SECONDS = int(os.environ["STUCK_AFTER_SECONDS"])

# AWS Clients
secrets_manager_client = boto3.client('secretsmanager')

# Global variables for caching
connection = None
db_secret = None

def get_secret(secret_name):
    global db_secret
    if db_secret is None:
        try:
            response = secrets_manager_client.get_secret_value(SecretId=secret_name)["SecretString"]
            db_secret = json.loads(response)
        except json.JSONDecodeError as e:
            logger.error(f"Failed to decode JSON for secret {secret_name}: {e}")
            raise ValueError(f"Secret {secret_name} is not properly formatted as JSON.")
        except Exception as e:
            logger.error(f"Error fetching secret {secret_name}: {e}")
            raise
    return db_secret

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

def update_ingestion_status():
    """
    Marks files that are stuck in "processing" as "error".

    Only rows that have been processing for at least STUCK_AFTER_SECONDS are
    touched. time_uploaded is set when the ingestion Lambda registers the file
    (data_ingestion/src/main.py), so a younger row belongs to an invocation that
    has not yet hit its timeout and may still complete.
    """
    connection = connect_to_db()
    if connection is None:
        logger.error("No database connection available.")
        return False

    cur = None
    try:
        cur = connection.cursor()

        # time_uploaded is "timestamp without time zone" holding UTC, so compare
        # against UTC "now". A single UPDATE ... RETURNING avoids a gap between
        # reading and writing the rows.
        cur.execute(
            """
            UPDATE "persona_data"
            SET ingestion_status = 'error'
            WHERE ingestion_status = 'processing'
            AND time_uploaded < (now() AT TIME ZONE 'UTC') - make_interval(secs => %s)
            RETURNING filename;
            """,
            (STUCK_AFTER_SECONDS,),
        )
        filenames = [row[0] for row in cur.fetchall()]

        connection.commit()
        cur.close()

        logger.info(f"Updated {len(filenames)} stuck file(s) to 'error' status: {filenames}")
        return True

    except Exception as e:
        if cur:
            cur.close()
        connection.rollback()
        logger.error(f"Error updating ingestion_status: {e}")
        return False

def is_expected_alarm_event(event) -> bool:
    """True only for the data-ingestion timeout alarm entering ALARM."""
    if not isinstance(event, dict):
        return False
    detail = event.get("detail")
    if not isinstance(detail, dict):
        return False
    state = detail.get("state")
    return (
        event.get("source") == "aws.cloudwatch"
        and event.get("detail-type") == "CloudWatch Alarm State Change"
        and detail.get("alarmName") == TIMEOUT_ALARM_NAME
        and isinstance(state, dict)
        and state.get("value") == "ALARM"
    )

def lambda_handler(event, context):
    if not is_expected_alarm_event(event):
        detail = event.get("detail") if isinstance(event, dict) else None
        alarm_name = detail.get("alarmName") if isinstance(detail, dict) else None
        logger.warning(f"Ignoring event that is not the ingestion timeout alarm entering ALARM (alarmName={alarm_name!r}).")
        return {
            'statusCode': 200,
            'body': json.dumps("Ignored: not the ingestion timeout alarm.")
        }

    try:
        if update_ingestion_status():
            return {
                'statusCode': 200,
                'body': json.dumps("Successfully updated ingestion_status for stuck LLM files.")
            }
        else:
            return {
                'statusCode': 500,
                'body': json.dumps("Error updating ingestion_status.")
            }

    except Exception as e:
        logger.error(f"Unexpected error in timeout handler: {e}")
        return {
            'statusCode': 500,
            'body': json.dumps(f"Error: {str(e)}")
        }