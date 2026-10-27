import os
import json
import time
import boto3
from botocore.config import Config
import psycopg2
import logging
from datetime import datetime, timezone
from typing import NamedTuple

from helpers.vectorstore import update_vectorstore
from helpers.helper import is_db_auth_error, open_vectorstore, grant_readwrite_on_vectorstore_tables
from helpers.cohere_embeddings import CohereBedrockEmbeddings
from langchain_aws import BedrockEmbeddings

# Set up basic logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger()

# Environment variables
DB_SECRET_NAME = os.environ["SM_DB_CREDENTIALS"]
REGION = os.environ["REGION"]
DATA_INGESTION_BUCKET = os.environ["BUCKET"]
EMBEDDING_BUCKET_NAME = os.environ["EMBEDDING_BUCKET_NAME"]
RDS_PROXY_ENDPOINT = os.environ["RDS_PROXY_ENDPOINT"]
# RDS Proxy presents an ACM certificate; verify it (and the hostname) against
# the Amazon Trust Services roots in the OS trust store.
# https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-proxy.howitworks.html#rds-proxy-security.tls
DB_SSL_ROOT_CERT = os.environ.get("PGSSLROOTCERT", "/etc/pki/tls/certs/ca-bundle.crt")
EMBEDDING_MODEL_PARAM = os.environ["EMBEDDING_MODEL_PARAM"]

# Folders embedded into the persona collection the student chat retrieves from.
# answer_key is instructor-only and deliberately excluded (see
# processing/documents.py EMBEDDED_FOLDERS).
EMBEDDED_CATEGORIES = ("documents", "info")
# Folders whose embeddings are removed on file delete. Includes answer_key so
# chunks embedded by earlier versions are still cleaned up.
EMBEDDING_CLEANUP_CATEGORIES = ("documents", "info", "answer_key")

# AWS Clients
secrets_manager_client = boto3.client("secretsmanager")
ssm_client = boto3.client("ssm")
# Cohere Embed v4 cross-region inference (us.*) requires a US source region.
# When deployed outside the US (e.g. ca-central-1), route embedding calls to us-east-1.
BEDROCK_EMBEDDING_REGION = os.environ.get("BEDROCK_EMBEDDING_REGION", "us-east-1")
bedrock_runtime = boto3.client("bedrock-runtime", region_name=BEDROCK_EMBEDDING_REGION, config=Config(retries={"mode": "adaptive", "total_max_attempts": 10}))

# Cached resources
connection = None
db_secret = None
db_secret_loaded_at = 0.0
# The app_tc password in SM_DB_CREDENTIALS is rotated by the db_setup Lambda on
# every deploy, so the cached secret is re-read periodically and on auth failure.
DB_SECRET_TTL_SECONDS = 300
EMBEDDING_MODEL_ID = None
# Set once grant_readwrite_on_vectorstore_tables() has succeeded in this container.
readwrite_grants_applied = False

# Set up class to represent parsed file path
class ParsedFilePath(NamedTuple):
    simulation_group_id: str
    persona_id: str 
    file_category: str
    file_name: str
    file_type: str

def get_secret(force_refresh=False):
    """Return the DB secret, cached for DB_SECRET_TTL_SECONDS.

    force_refresh=True re-reads it immediately (used after an authentication
    failure, i.e. the password was rotated since it was cached).
    """
    global db_secret, db_secret_loaded_at
    expired = (time.monotonic() - db_secret_loaded_at) > DB_SECRET_TTL_SECONDS
    if db_secret is None or force_refresh or expired:
        try:
            response = secrets_manager_client.get_secret_value(SecretId=DB_SECRET_NAME)["SecretString"]
            db_secret = json.loads(response)
            db_secret_loaded_at = time.monotonic()
        except Exception as e:
            logger.error(f"Error fetching secret {DB_SECRET_NAME}: {e}")
            raise
    return db_secret

def get_parameter():
    """
    Fetch a parameter value from Systems Manager Parameter Store.
    """
    global EMBEDDING_MODEL_ID
    if EMBEDDING_MODEL_ID is None:
        try:
            response = ssm_client.get_parameter(Name=EMBEDDING_MODEL_PARAM, WithDecryption=True)
            EMBEDDING_MODEL_ID = response["Parameter"]["Value"]
        except Exception as e:
            logger.error(f"Error fetching parameter {EMBEDDING_MODEL_PARAM}: {e}")
            raise
    return EMBEDDING_MODEL_ID

def _open_connection():
    """Open a new psycopg2 connection to the RDS proxy.

    On an authentication failure (app_tc password rotated by db_setup since
    the secret was cached) the secret is re-read and the connect retried once.
    """
    def _connect(secret):
        connection_params = {
            'dbname': secret["dbname"],
            'user': secret["username"],
            'password': secret["password"],
            'host': RDS_PROXY_ENDPOINT,
            'port': secret["port"],
            'sslmode': 'verify-full',
            'sslrootcert': DB_SSL_ROOT_CERT,
        }
        conn = psycopg2.connect(**connection_params)
        conn.autocommit = True
        return conn

    try:
        return _connect(get_secret())
    except psycopg2.OperationalError as e:
        if not is_db_auth_error(e):
            raise
        logger.warning("DB authentication failed; re-reading rotated credentials and retrying once")
        return _connect(get_secret(force_refresh=True))

def _connection_is_alive(conn):
    """`conn.closed` only reflects client-side state, so also ping with SELECT 1
    to detect a session terminated server-side between warm invocations."""
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
    if _connection_is_alive(connection):
        return connection

    # Cached connection is closed/broken or missing: discard it and reconnect.
    if connection is not None:
        try:
            connection.close()
        except Exception:
            pass
        connection = None

    try:
        connection = _open_connection()
        logger.info("Connected to the database!")
    except Exception as e:
        logger.error(f"Failed to connect to database: {e}")
        raise
    return connection

def get_embedding_count(persona_id):
    """
    Queries the database for the number of embeddings associated with a specific persona.

    Args:
        persona_id (str): The persona ID (collection name in the vectorstore).

    Returns:
        int: The count of embeddings found for the persona.
    """
    connection = connect_to_db()
    if connection is None:
        logger.error("Database connection failed. Unable to query embeddings.")
        raise

    try:
        cur = connection.cursor()

        # Query to count embeddings for the persona
        query = """
        SELECT COUNT(*)
        FROM langchain_pg_embedding e
        JOIN langchain_pg_collection c ON e.collection_id = c.uuid
        WHERE c.name = %s;
        """
        cur.execute(query, (persona_id,))
        result = cur.fetchone()

        connection.commit()
        cur.close()

        if result and result[0] > 0:
            logger.info(f"Current embedding count for persona {persona_id}: {result[0]}")
            return result[0]
        else:
            logger.info(f"No embeddings found for persona {persona_id}. This may be a new collection.")
            return 0

    except psycopg2.errors.UndefinedTable as e:
        # Handles case where tables do not exist yet (first persona)
        connection.rollback()
        logger.warning(f"LangChain tables do not exist yet as this might be the first persona being created. Returning 0 embeddings for persona {persona_id}.")
        return 0

    except Exception as e:
        if cur:
            cur.close()
        connection.rollback()
        logger.error(f"Error retrieving embedding count for persona {persona_id}: {e}")
        raise

def update_ingestion_status(persona_id: str, file_path: str, status: str):
    """
    Updates the ingestion_status of a file in the persona_data table.

    Args:
        persona_id (str): The persona ID associated with the file.
        file_path (str): The full file path stored in the database.
        status (str): The status to update ('completed' or 'error').
    """
    connection = connect_to_db()
    if connection is None:
        logger.error("Database connection failed. Unable to update ingestion status.")
        return

    try:
        cur = connection.cursor()

        update_query = """
        UPDATE "persona_data"
        SET ingestion_status = %s
        WHERE persona_id = %s
        AND filepath = %s;
        """
        cur.execute(update_query, (status, persona_id, file_path))
        connection.commit()
        cur.close()

        logger.info(f"Ingestion status for {file_path} updated to '{status}' for persona {persona_id}.")

    except Exception as e:
        if cur:
            cur.close()
        connection.rollback()
        logger.error(f"Error updating ingestion status for persona {persona_id}, file {file_path}: {e}")
        raise

def mark_error_unless_completed(persona_id: str, file_path: str) -> bool:
    """Set ingestion_status to 'error' unless it is already 'completed'.

    A single conditional UPDATE, so it can't overwrite a concurrent run that
    completed the file. Returns True if the status was changed.
    """
    connection = connect_to_db()
    with connection.cursor() as cur:
        cur.execute(
            """
            UPDATE "persona_data"
            SET ingestion_status = 'error'
            WHERE persona_id = %s
            AND filepath = %s
            AND ingestion_status IS DISTINCT FROM 'completed';
            """,
            (persona_id, file_path),
        )
        changed = cur.rowcount > 0
    connection.commit()
    return changed

def parse_s3_file_path(file_key):
    # Assuming the file path is of the format: {simulation_group_id}/{persona_id}/{documents or info}/{file_name}.{file_type}
    try:
        # Split the path into components
        parts = file_key.split('/')
        
        # Validate that the path has the correct number of components
        if len(parts) != 4:
            raise ValueError(f"Unexpected file path format: {file_key}")

        simulation_group_id, persona_id, file_category, filename_with_ext = parts

        # Split filename and extension
        if '.' not in filename_with_ext:
            raise ValueError(f"Invalid filename format: {filename_with_ext}")

        file_name, file_type = filename_with_ext.rsplit('.', 1)

        return ParsedFilePath(
            simulation_group_id=simulation_group_id,
            persona_id=persona_id,
            file_category=file_category,
            file_name=file_name,
            file_type=file_type
        )
    except ValueError as e:
        logger.error(f"Error parsing S3 file path: {e}")
        return {
            "statusCode": 400,
            "body": json.dumps("Error parsing S3 file path.")
        }

def insert_file_into_db(persona_id, file_name, file_type, file_path, bucket_name, file_category):    
    connection = connect_to_db()
    if connection is None:
        logger.error("No database connection available.")
        return {
            "statusCode": 500,
            "body": json.dumps("Database connection failed.")
        }

    try:
        cur = connection.cursor()

        select_query = """
        SELECT * FROM "persona_data"
        WHERE persona_id = %s
        AND filename = %s
        AND filetype = %s;
        """
        cur.execute(select_query, (persona_id, file_name, file_type))
        existing_file = cur.fetchone()

        timestamp = datetime.now(timezone.utc)
        ingestion_status = "processing" if file_category in EMBEDDED_CATEGORIES else "not processing"

        if existing_file:
            # Update the existing record
            update_query = """
                UPDATE "persona_data"
                SET s3_bucket_reference = %s,
                    filepath = %s,
                    time_uploaded = %s,
                    ingestion_status = %s
                WHERE persona_id = %s
                AND filename = %s
                AND filetype = %s;
            """
            cur.execute(update_query, (
                bucket_name, file_path, timestamp, ingestion_status, persona_id, file_name, file_type
            ))
            logger.info(f"Successfully updated file {file_name}.{file_type} in database for persona {persona_id}, ingestion set to '{ingestion_status}'.")
        else:
            # Insert a new record
            insert_query = """
                INSERT INTO "persona_data" 
                (persona_id, filetype, s3_bucket_reference, filepath, filename, time_uploaded, metadata, ingestion_status)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s);
            """
            cur.execute(insert_query, (
                persona_id, file_type, bucket_name, file_path, file_name, timestamp, "", ingestion_status
            ))
            logger.info(f"Successfully inserted new file {file_name}.{file_type} for persona {persona_id}, ingestion set to '{ingestion_status}'.")

        connection.commit()
        cur.close()
        return None
    except Exception as e:
        if cur:
            cur.close()
        connection.rollback()
        logger.error(f"Error inserting file {file_name}.{file_type} into database: {e}")
        raise

def _vectorstore_config(persona_id, force_refresh=False):
    """PGVector / SQLRecordManager connection settings for a persona's collection."""
    secret = get_secret(force_refresh=force_refresh)
    return {
        'collection_name': f'{persona_id}',
        'dbname': secret["dbname"],
        'user': secret["username"],
        'password': secret["password"],
        'host': RDS_PROXY_ENDPOINT,
        'port': secret["port"]
    }

def _open_vectorstore_with_retry(persona_id, embeddings):
    """Open PGVector + SQLRecordManager, retrying once with a freshly read DB secret.

    PGVector and SQLRecordManager open their own SQLAlchemy connections, so a
    rotated app_tc password surfaces here rather than in connect_to_db().
    Only this setup step is retried: it changes no document state, unlike
    process_documents(), which is not safe to replay. Only authentication
    failures are retried; anything else raises as before.
    """
    try:
        return open_vectorstore(_vectorstore_config(persona_id), embeddings)
    except Exception as e:
        if not is_db_auth_error(e):
            raise
        logger.warning(f"Vector store DB authentication failed; retrying with refreshed DB credentials: {type(e).__name__}")
        return open_vectorstore(_vectorstore_config(persona_id, force_refresh=True), embeddings)

def _ensure_readwrite_grants(connection):
    """Narrow readwrite's access on the vectorstore tables once per container.

    open_vectorstore() may have just created them (fresh DB), owned by app_tc.
    """
    global readwrite_grants_applied
    if not readwrite_grants_applied:
        readwrite_grants_applied = grant_readwrite_on_vectorstore_tables(connection)

def _update_vectorstore_with_retry(bucket, simulation_group_id, persona_id, embeddings, connection):
    """Open the vectorstore (with the credential retry above), then ingest once."""
    vectorstore, record_manager = _open_vectorstore_with_retry(persona_id, embeddings)
    _ensure_readwrite_grants(connection)
    update_vectorstore(
        bucket=bucket,
        group=simulation_group_id,
        persona_id=persona_id,
        vectorstore=vectorstore,
        record_manager=record_manager,
        embeddings=embeddings,
        connection=connection
    )

def update_vectorstore_from_s3(bucket, simulation_group_id, persona_id, file_path):
    connection = connect_to_db()
    if connection is None:
        logger.error("Database connection failed. Unable to query embeddings.")
        raise
    
    embedding_model_id = get_parameter()
    if embedding_model_id.startswith("cohere.embed"):
        embeddings = CohereBedrockEmbeddings(
            model_id=embedding_model_id,
            client=bedrock_runtime,
            region_name=BEDROCK_EMBEDDING_REGION,
        )
    else:
        embeddings = BedrockEmbeddings(
            model_id=embedding_model_id, 
            client=bedrock_runtime,
            region_name=BEDROCK_EMBEDDING_REGION
        )

    try:
        _update_vectorstore_with_retry(bucket, simulation_group_id, persona_id, embeddings, connection)

    except Exception as e:
        error_message = str(e)
        if "An error occurred (404) when calling the HeadObject operation: Not Found" in error_message:
            # A concurrent invocation for the same persona consumed the temp
            # page files. Files are only marked "completed" after index(), so
            # this run marked nothing. Give the triggering file a terminal
            # status unless the other run already completed it. If that run
            # finishes later, it overwrites "error" with "completed".
            logger.warning(f"Temporary page file not found while updating vectorstore for persona {persona_id}; "
                           f"another invocation is likely processing these files.")
            try:
                if mark_error_unless_completed(persona_id, file_path):
                    logger.warning(f"ingestion_status set to 'error' for {file_path}; re-upload if it does not complete.")
                else:
                    logger.info(f"{file_path} is already 'completed'; leaving its status unchanged.")
            except Exception as status_error:
                logger.error(f"Could not update ingestion_status for {file_path}: {status_error}")
        else:
            logger.error(f"Error updating vectorstore for persona {persona_id}: {e}")
            # A failure writing the status must not mask the original error.
            try:
                update_ingestion_status(persona_id, file_path, "error")
                logger.error(f"ingestion_status set to 'error' for {file_path}.")
            except Exception as status_error:
                logger.error(f"Could not set ingestion_status to 'error' for {file_path}: {status_error}")
            raise e

def handler(event, context):
    records = event.get('Records', [])
    if not records:
        return {
            "statusCode": 400,
            "body": json.dumps("No valid S3 event found.")
        }

    # REVIEW: This handler processes only the FIRST record and returns, even if the event
    # contains multiple S3 records. The early `return` inside the for-loop means subsequent
    # records are silently dropped. Either process all records or document that batch size
    # must be 1 in the S3 event source configuration.
    for record in records:
        event_name = record['eventName']
        bucket_name = record['s3']['bucket']['name']

        if bucket_name != DATA_INGESTION_BUCKET:
            logger.info(f"Ignoring event from non-target bucket: {bucket_name}")
            continue

        file_key = record['s3']['object']['key']
        parsed = parse_s3_file_path(file_key)
        simulation_group_id = parsed.simulation_group_id
        persona_id = parsed.persona_id
        file_category = parsed.file_category
        file_name = parsed.file_name
        file_type = parsed.file_type

        if not simulation_group_id or not persona_id or not file_name or not file_type:
            return {
                "statusCode": 400,
                "body": json.dumps("Error parsing S3 file path.")
            }
        
        # Get initial embedding count
        try:
            initial_count = get_embedding_count(persona_id)
            logger.info(f"Initial count of embeddings are {initial_count}")
        except Exception as e:
            initial_count = 0
            logger.error(f"Error getting initial count of embeddings: {e}")

        if event_name.startswith('ObjectCreated:'):
            try:
                insert_file_into_db(
                    persona_id=persona_id,
                    file_name=file_name,
                    file_type=file_type,
                    file_path=file_key,
                    bucket_name=bucket_name,
                    file_category=file_category
                )
                logger.info(f"File {file_name}.{file_type} inserted successfully.")
            except Exception as e:
                logger.error(f"Error inserting file {file_name}.{file_type} into database: {e}")
                return {
                    "statusCode": 500,
                    "body": json.dumps(f"Error inserting file {file_name}.{file_type}: {e}")
                }
        else:
            logger.info(f"File {file_name}.{file_type} is being deleted.")
            # Clean up embeddings for embeddable file types
            if file_category in EMBEDDING_CLEANUP_CATEGORIES:
                try:
                    connection = connect_to_db()
                    if connection is None:
                        logger.error("Database connection failed. Unable to delete embeddings.")
                    else:
                        cur = connection.cursor()

                        # Get the collection UUID for this persona
                        cur.execute(
                            'SELECT uuid FROM langchain_pg_collection WHERE name = %s',
                            (persona_id,)
                        )
                        collection = cur.fetchone()

                        if collection:
                            # Build the exact source string used during ingestion
                            file_source = f"s3://{EMBEDDING_BUCKET_NAME}/{simulation_group_id}/{persona_id}/{file_category}/{file_name}.{file_type}"

                            cur.execute(
                                """DELETE FROM langchain_pg_embedding
                                   WHERE collection_id = %s
                                   AND cmetadata->>'source' = %s""",
                                (collection[0], file_source)
                            )
                            deleted_count = cur.rowcount
                            connection.commit()
                            logger.info(f"Deleted {deleted_count} embeddings for {file_name}.{file_type} from persona {persona_id}.")
                        else:
                            logger.info(f"No embedding collection found for persona {persona_id}, skipping embedding cleanup.")

                        cur.close()
                except Exception as e:
                    logger.error(f"Error deleting embeddings for {file_name}.{file_type}: {e}")
            
            return {
                "statusCode": 200,
                "body": json.dumps(f"File {file_name}.{file_type} deleted, embeddings cleaned up.")
            }
        
        # Update embeddings for persona after the file is successfully inserted into the database. Only if document file
        if file_category in EMBEDDED_CATEGORIES:
            try:
                update_vectorstore_from_s3(bucket_name, simulation_group_id, persona_id, file_key)
                logger.info(f"Vectorstore updated successfully for persona {persona_id} in group {simulation_group_id}.")
            except Exception as e:
                logger.error(f"Error updating vectorstore for persona {persona_id} in group {simulation_group_id}: {e}")
                return {
                    "statusCode": 500,
                    "body": json.dumps(f"File inserted, but error updating vectorstore: {e}")
                }
        else:            
            logger.info(f"{file_name}.{file_type} in {file_category} folder is not ingested")
        
        # Get final embedding count
        try:
            final_count = get_embedding_count(persona_id)
            logger.info(f"Final count of embeddings are {final_count}")

            difference = final_count - initial_count

            if difference > 0:
                logger.info(f"{difference} embeddings were created for persona {persona_id}.")
                print(f"{difference} embeddings were created for persona {persona_id}.")
            elif difference == 0:
                logger.info(f"No change in embeddings for persona {persona_id}.")
                print(f"No change in embeddings for persona {persona_id}.")
            else:
                logger.info(f"{difference} embeddings were removed for persona {persona_id}.")
                print(f"{abs(difference)} embeddings were removed for persona {persona_id}.")
        except Exception as e:
            logger.error(f"Error getting final count of embeddings: {e}")

        return {
            "statusCode": 200,
            "body": json.dumps({
                "message": "New file inserted into database.",
                "location": f"s3://{bucket_name}/{file_key}"
            })
        }

    return {
        "statusCode": 400,
        "body": json.dumps("No new file upload or deletion event found.")
    }