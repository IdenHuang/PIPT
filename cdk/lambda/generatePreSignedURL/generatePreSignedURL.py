import os, json, re, uuid
import boto3
import psycopg2
from botocore.config import Config
from aws_lambda_powertools import Logger
from cors_helper import get_cors_headers

BUCKET = os.environ["BUCKET"]
REGION = os.environ["REGION"]
DB_SECRET_NAME = os.environ["SM_DB_CREDENTIALS"]
RDS_PROXY_ENDPOINT = os.environ["RDS_PROXY_ENDPOINT"]
# RDS Proxy presents an ACM certificate; verify it (and the hostname) against
# the Amazon Trust Services roots in the OS trust store.
# https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-proxy.howitworks.html#rds-proxy-security.tls
DB_SSL_ROOT_CERT = os.environ.get("PGSSLROOTCERT", "/etc/pki/tls/certs/ca-bundle.crt")

# Allow alphanumeric, spaces, hyphens, underscores, dots, parentheses, commas
SAFE_FILENAME = re.compile(r'^[a-zA-Z0-9_\-. (),]{1,200}$')
# Reserved by data ingestion for per-page temp keys ({file_name}_page_{n}.txt)
PAGE_SENTINEL = "_page"

s3 = boto3.client(
    "s3",
    endpoint_url=f"https://s3.{REGION}.amazonaws.com",
    config=Config(
        s3={"addressing_style": "virtual"}, region_name=REGION, signature_version="s3v4"
    ),
)
secrets_manager_client = boto3.client('secretsmanager')
logger = Logger()

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

def is_uuid(value):
    """True only for a canonical UUID string, so IDs cannot inject extra key segments."""
    try:
        return str(uuid.UUID(value)) == value.lower()
    except (ValueError, AttributeError, TypeError):
        return False

def s3_key_exists(bucket, key):
    try:
        s3.head_object(Bucket=bucket, Key=key)
        return True
    except Exception:
        return False

@logger.inject_lambda_context(log_event=True)
def lambda_handler(event, context):
    # Extract user identity from authorizer context
    user_email = event.get("requestContext", {}).get("authorizer", {}).get("email", "")

    # Use .get() to safely extract query string parameters
    query_params = event.get("queryStringParameters", {})

    if not query_params:
        return {
            'statusCode': 400,
            'body': json.dumps('Missing queries to generate pre-signed URL')
        }

    simulation_group_id = query_params.get("simulation_group_id", "")
    persona_id = query_params.get("patient_id", "")
    file_type = query_params.get("file_type", "")
    file_name = query_params.get("file_name", "")
    folder_type = query_params.get("folder_type", "")

    if not simulation_group_id:
        return {
            'statusCode': 400,
            'body': json.dumps('Missing required parameter: simulation_group_id')
        }

    if not persona_id:
        return {
            'statusCode': 400,
            'body': json.dumps('Missing required parameter: persona_id')
        }

    if not file_name:
        return {
            'statusCode': 400,
            'body': json.dumps('Missing required parameter: file_name')
        }

    # Both IDs are interpolated into the S3 key, so they must be plain UUIDs
    if not is_uuid(simulation_group_id) or not is_uuid(persona_id):
        return {
            'statusCode': 400,
            "headers": get_cors_headers(event),
            'body': json.dumps('Invalid simulation_group_id or patient_id')
        }

    # Validate file_name to prevent path traversal and special character issues
    if not SAFE_FILENAME.match(file_name):
        return {
            'statusCode': 400,
            "headers": get_cors_headers(event),
            'body': json.dumps('Invalid file name. Only alphanumeric characters, spaces, hyphens, underscores, dots, parentheses, and commas are allowed (max 200 chars).')
        }

    # Ingestion writes each page as "{file_name}_page_{n}.txt", so "_page" is a
    # reserved sentinel. Rejecting it keeps an upload from ever producing temp
    # keys that look like another document's pages.
    if PAGE_SENTINEL in file_name:
        return {
            'statusCode': 400,
            "headers": get_cors_headers(event),
            'body': json.dumps(f'Invalid file name. File names must not contain "{PAGE_SENTINEL}".')
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

    # The persona must belong to the verified group. Ingestion and retrieval key
    # the pgvector collection by persona_id alone, so without this an instructor of
    # group A could upload into a group-B persona's RAG collection.
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

    # Allowed file types for documents with their corresponding MIME types
    allowed_document_types = {
        "pdf": "application/pdf",
        "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "txt": "text/plain",
        "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "xps": "application/oxps",  # or "application/vnd.ms-xpsdocument" for legacy XPS
        "mobi": "application/x-mobipocket-ebook",
        "cbz": "application/vnd.comicbook+zip"
    }

    # Allowed file types for profile pictures with their corresponding MIME types
    allowed_profile_picture_types = {
        'bmp': 'image/bmp', 'gif': 'image/gif',
        'ico': 'image/vnd.microsoft.icon',
        'jpeg': 'image/jpeg', 'jpg': 'image/jpeg',
        'png': 'image/png',
        'svg': 'image/svg+xml',
        'tiff': 'image/tiff', 'tif': 'image/tiff',
        'webp': 'image/webp',
    }

    # Allowed file types for information and answer keys with their corresponding MIME types
    allowed_generic_types = {
        "pdf": "application/pdf",
        "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "txt": "text/plain",
        "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "xps": "application/oxps",  # or "application/vnd.ms-xpsdocument" for legacy XPS
        "mobi": "application/x-mobipocket-ebook",
        "cbz": "application/vnd.comicbook+zip",
        'bmp': 'image/bmp', 'eps': 'application/postscript', 'gif': 'image/gif',
        'icns': 'image/icns', 'ico': 'image/vnd.microsoft.icon', 'im': 'application/x-im',
        'jpeg': 'image/jpeg', 'jpg': 'image/jpeg', 'j2k': 'image/jp2', 'jp2': 'image/jp2',
        'msp': 'application/vnd.ms-paint', 'pcx': 'image/x-pcx', 'png': 'image/png',
        'ppm': 'image/x-portable-pixmap', 'pgm': 'image/x-portable-graymap',
        'pbm': 'image/x-portable-bitmap', 'sgi': 'image/sgi', 'tga': 'image/x-tga',
        'tiff': 'image/tiff', 'tif': 'image/tiff', 'webp': 'image/webp', 'xbm': 'image/x-xbitmap'
    }

    if folder_type == "documents" and file_type in allowed_document_types:
        key = f"{simulation_group_id}/{persona_id}/documents/{file_name}.{file_type}"
        content_type = allowed_document_types[file_type]
    elif folder_type == "info" and file_type in allowed_generic_types:
        key = f"{simulation_group_id}/{persona_id}/info/{file_name}.{file_type}"
        content_type = allowed_generic_types[file_type]
    elif folder_type == "answer_key" and file_type in allowed_generic_types:
        key = f"{simulation_group_id}/{persona_id}/answer_key/{file_name}.{file_type}"
        content_type = allowed_generic_types[file_type]
    elif folder_type == "profile_picture" and file_type in allowed_profile_picture_types:
        key = f"{simulation_group_id}/{persona_id}/profile_picture/{file_name}.{file_type}"
        content_type = allowed_profile_picture_types[file_type]
    else:
        return {
            'statusCode': 400,
            'body': json.dumps('Unsupported file type')
        }

    logger.info({
        "simulation_group_id": simulation_group_id,
        "persona_id": persona_id,
        "file_type": file_type,
        "file_name": file_name,
    })

    try:
        # Use presigned POST to enforce content-length limit (max 50 MB)
        presigned_post = s3.generate_presigned_post(
            Bucket=BUCKET,
            Key=key,
            Fields={
                "Content-Type": content_type,
                "success_action_status": "200",
            },
            Conditions=[
                ["content-length-range", 1, 52428800],  # 1 byte to 50 MB
                {"Content-Type": content_type},
                {"success_action_status": "200"},
            ],
            ExpiresIn=300,
        )

        return {
            "statusCode": 200,
            "headers": get_cors_headers(event),
            "body": json.dumps({
                "url": presigned_post["url"],
                "fields": presigned_post["fields"],
            }),
        }

    except Exception as e:
        logger.error(f"Error generating presigned POST: {e}")
        return {
            'statusCode': 500,
            'body': json.dumps('Internal server error')
        }