import os
import json
import re
import boto3
import psycopg2
from aws_lambda_powertools import Logger
from cors_helper import get_cors_headers

logger = Logger()

# Allow alphanumeric, spaces, hyphens, underscores, dots, parentheses, commas
SAFE_FILENAME = re.compile(r'^[a-zA-Z0-9_\-. (),]{1,200}$')

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

def delete_embeddings_for_file(persona_id, simulation_group_id, folder_type, file_name, file_type):
    """Delete embeddings from pgvector for a specific file."""
    connection = connect_to_db()
    if connection is None:
        logger.error("No database connection available for embedding deletion.")
        return

    try:
        cur = connection.cursor()

        # Get the collection UUID for this persona
        cur.execute(
            'SELECT uuid FROM langchain_pg_collection WHERE name = %s',
            (persona_id,)
        )
        collection = cur.fetchone()

        if not collection:
            logger.info(f"No embedding collection found for persona {persona_id}, skipping embedding cleanup.")
            cur.close()
            return

        # Source stored during ingestion: s3://{bucket}/{group}/{persona}/{folder}/{filename}.{ext}
        # Match on the path suffix since we don't have the embedding bucket name
        source_suffix = f"{simulation_group_id}/{persona_id}/{folder_type}/{file_name}.{file_type}"

        cur.execute(
            """DELETE FROM langchain_pg_embedding
               WHERE collection_id = %s
               AND cmetadata->>'source' LIKE %s""",
            (collection[0], f"%{source_suffix}")
        )
        deleted_count = cur.rowcount

        connection.commit()
        cur.close()
        logger.info(f"Deleted {deleted_count} embeddings for {file_name}.{file_type} from persona {persona_id}.")

    except Exception as e:
        if cur:
            cur.close()
        connection.rollback()
        logger.error(f"Error deleting embeddings for {file_name}.{file_type}: {e}")
        raise


def delete_file_from_db(persona_id, file_name, file_type):
    connection = connect_to_db()
    if connection is None:
        logger.error("No database connection available.")
        return {
            "statusCode": 500,
            "body": json.dumps("Database connection failed.")
        }
    
    try:
        cur = connection.cursor()

        delete_query = """
            DELETE FROM "persona_data" 
            WHERE persona_id = %s AND filename = %s AND filetype = %s;
        """
        cur.execute(delete_query, (persona_id, file_name, file_type))

        connection.commit()
        logger.info(f"Successfully deleted file {file_name}.{file_type} for persona {persona_id}.")

        cur.close()
        return None
    except Exception as e:
        if cur:
            cur.close()
        connection.rollback()
        logger.error(f"Error deleting file {file_name}.{file_type} from database: {e}")
        raise

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


def persona_in_group(persona_id, simulation_group_id):
    """True if the persona belongs to the simulation group. Fails closed."""
    conn = connect_to_db()
    cur = conn.cursor()
    try:
        cur.execute(
            'SELECT 1 FROM "personas" WHERE persona_id = %s AND simulation_group_id = %s',
            (persona_id, simulation_group_id)
        )
        result = cur.fetchone()
        cur.close()
        return result is not None
    except Exception as e:
        cur.close()
        conn.rollback()
        logger.error(f"Error verifying persona/group binding: {e}")
        return False


@logger.inject_lambda_context
def lambda_handler(event, context):
    # Extract user identity from authorizer context
    user_email = event.get("requestContext", {}).get("authorizer", {}).get("email", "")

    query_params = event.get("queryStringParameters", {})

    simulation_group_id = query_params.get("simulation_group_id", "")
    persona_id = query_params.get("persona_id", "")
    file_name = query_params.get("file_name", "")
    file_type = query_params.get("file_type", "")
    folder_type = query_params.get("folder_type", "")

    if not simulation_group_id or not persona_id or not file_name or not file_type or not folder_type:
        logger.error("Missing required parameters", extra={
            "simulation_group_id": simulation_group_id,
            "persona_id": persona_id,
            "file_name": file_name,
            "file_type": file_type,
            "folder_type": folder_type
        })
        return {
            'statusCode': 400,
            "headers": get_cors_headers(event),
            'body': json.dumps('Missing required parameters: simulation_group_id, persona_id, file_name, file_type, or folder_type')
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

    # The persona must belong to the verified group. persona_data rows are keyed
    # by persona_id only, so without this an instructor of group A could pass a
    # group-B persona_id and delete group B's file records.
    if not persona_in_group(persona_id, simulation_group_id):
        logger.warning("Persona does not belong to simulation group", extra={
            "user_email": user_email,
            "simulation_group_id": simulation_group_id,
            "persona_id": persona_id,
        })
        return {
            'statusCode': 403,
            "headers": get_cors_headers(event),
            'body': json.dumps('Forbidden: Patient does not belong to this simulation group')
        }

    # Validate file_name to prevent path traversal and special character issues
    if not SAFE_FILENAME.match(file_name):
        return {
            'statusCode': 400,
            "headers": get_cors_headers(event),
            'body': json.dumps('Invalid file name')
        }

    try:
        # Allowed file types for documents
        allowed_document_types = {"pdf", "docx", "pptx", "txt", "xlsx", "xps", "mobi", "cbz"}
        
        # Allowed file types for information
        allowed_generic_types = {
            'pdf', 'docx', 'pptx', 'txt', 'xlsx', 'xps', 'mobi', 'cbz',
            'bmp', 'eps', 'gif', 'icns', 'ico', 'im', 'jpeg', 'jpg', 'j2k', 'jp2', 'msp',
            'pcx', 'png', 'ppm', 'pgm', 'pbm', 'sgi', 'tga', 'tiff', 'tif', 'webp', 'xbm'
        }

        objects_to_delete = []

        # Determine the folder based on the file type
        if folder_type == "documents" and file_type in allowed_document_types:
            objects_to_delete.append({"Key": f"{simulation_group_id}/{persona_id}/documents/{file_name}.{file_type}"})
        elif folder_type == "info" and file_type in allowed_generic_types:
            objects_to_delete.append({"Key": f"{simulation_group_id}/{persona_id}/info/{file_name}.{file_type}"})
        elif folder_type == "answer_key" and file_type in allowed_generic_types:
            objects_to_delete.append({"Key": f"{simulation_group_id}/{persona_id}/answer_key/{file_name}.{file_type}"})
        elif folder_type == "profile_picture" and file_type in allowed_generic_types:
            objects_to_delete.append({"Key": f"{simulation_group_id}/{persona_id}/profile_picture/{file_name}.{file_type}"})
        else:
            return {
                'statusCode': 400,
                "headers": get_cors_headers(event),
                'body': json.dumps('Unsupported file type')
            }

        # Delete the file from S3
        response = s3.delete_objects(
            Bucket=BUCKET,
            Delete={
                "Objects": objects_to_delete,
                "Quiet": True,
            },
        )
        
        logger.info(f"S3 Response: {response}")
        logger.info(f"File {file_name}.{file_type} and any associated files deleted successfully from S3.")

        # Delete embeddings for embeddable file types
        if folder_type in ("documents", "info", "answer_key"):
            try:
                delete_embeddings_for_file(persona_id, simulation_group_id, folder_type, file_name, file_type)
                logger.info(f"Embeddings deleted for {file_name}.{file_type}.")
            except Exception as e:
                logger.error(f"Error deleting embeddings for {file_name}.{file_type}: {e}")
                return {
                    'statusCode': 500,
                    "headers": get_cors_headers(event),
                    'body': json.dumps(f"File deleted from S3 but error cleaning up embeddings for {file_name}.{file_type}")
                }

        # Delete the file from the database (skip for profile pictures — no persona_data row)
        if folder_type != "profile_picture":
            try:
                delete_file_from_db(persona_id, file_name, file_type)
                logger.info(f"File {file_name}.{file_type} deleted from the database.")
            except Exception as e:
                logger.error(f"Error deleting file {file_name}.{file_type} from the database: {e}")
                return {
                    'statusCode': 500,
                    "headers": get_cors_headers(event),
                    'body': json.dumps(f"Error deleting file {file_name}.{file_type} from the database")
                }

        return {
            'statusCode': 200,
            "headers": get_cors_headers(event),
            'body': json.dumps('File deleted successfully')
        }
        
    except Exception as e:
        logger.exception(f"Error deleting file: {e}")
        return {
            'statusCode': 500,
            "headers": get_cors_headers(event),
            'body': json.dumps('Internal server error')
        }