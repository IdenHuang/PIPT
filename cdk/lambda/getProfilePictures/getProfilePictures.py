import os
import json
import boto3
from botocore.config import Config
from botocore.signers import CloudFrontSigner
import rsa
from datetime import datetime, timedelta
import psycopg2
from aws_lambda_powertools import Logger
from cors_helper import get_cors_headers

logger = Logger()

# Environment variables
REGION = os.environ["REGION"]
BUCKET = os.environ["BUCKET"]
DB_SECRET_NAME = os.environ["SM_DB_CREDENTIALS"]
RDS_PROXY_ENDPOINT = os.environ["RDS_PROXY_ENDPOINT"]
# RDS Proxy presents an ACM certificate; verify it (and the hostname) against
# the Amazon Trust Services roots in the OS trust store.
# https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-proxy.howitworks.html#rds-proxy-security.tls
DB_SSL_ROOT_CERT = os.environ.get("PGSSLROOTCERT", "/etc/pki/tls/certs/ca-bundle.crt")
CLOUDFRONT_DOMAIN = os.environ["CLOUDFRONT_DOMAIN"]
CLOUDFRONT_KEY_PAIR_ID = os.environ["CLOUDFRONT_KEY_PAIR_ID"]
SM_CLOUDFRONT_PRIVATE_KEY = os.environ["SM_CLOUDFRONT_PRIVATE_KEY"]

# AWS Clients
secrets_manager_client = boto3.client('secretsmanager')

s3 = boto3.client(
    "s3",
    endpoint_url=f"https://s3.{REGION}.amazonaws.com",
    config=Config(
        s3={"addressing_style": "virtual"}, region_name=REGION, signature_version="s3v4"
    ),
)

# Global variables for caching
connection = None
db_secret = None
cf_private_key = None

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

def fetch_persona_ids(simulation_group_id):
    connection = connect_to_db()
    if not connection:
        logger.error("No database connection available.")
        return []

    try:
        cur = connection.cursor()
        query = """
            SELECT persona_id
            FROM personas
            WHERE simulation_group_id = %s;
        """
        cur.execute(query, (simulation_group_id,))
        persona_ids = [row[0] for row in cur.fetchall()]
        cur.close()
        
        return persona_ids
    except Exception as e:
        logger.error(f"Error fetching persona IDs: {e}")
        if cur:
            cur.close()
        connection.rollback()
        return []

def get_cf_private_key():
    """Fetch and cache the CloudFront signing private key from Secrets Manager."""
    global cf_private_key
    if cf_private_key is None:
        response = secrets_manager_client.get_secret_value(SecretId=SM_CLOUDFRONT_PRIVATE_KEY)["SecretString"]
        cf_private_key = rsa.PrivateKey.load_pkcs1(response.encode('utf-8'))
    return cf_private_key

def rsa_signer(message):
    """Sign a message with the CloudFront private key (used by CloudFrontSigner)."""
    private_key = get_cf_private_key()
    return rsa.sign(message, private_key, 'SHA-1')

def generate_presigned_url(bucket, key):
    """Generate a CloudFront signed URL for the given S3 key."""
    try:
        cf_signer = CloudFrontSigner(CLOUDFRONT_KEY_PAIR_ID, rsa_signer)
        # URL-encode path segments (preserve /) for keys with spaces or special chars
        encoded_key = "/".join(
            __import__("urllib.parse", fromlist=["quote"]).quote(segment, safe="")
            for segment in key.split("/")
        )
        url = f"https://{CLOUDFRONT_DOMAIN}/{encoded_key}"
        expire_date = datetime.utcnow() + timedelta(seconds=300)  # 5 minutes
        signed_url = cf_signer.generate_presigned_url(url, date_less_than=expire_date)
        return signed_url
    except Exception as e:
        logger.exception(f"Error generating CloudFront signed URL for {key}: {e}")
        return None

def has_group_access(user_email, simulation_group_id):
    """
    True if the caller is an admin, an instructor of this group (creator,
    group_instructors, or 'instructor' enrollment — same rule as authz.js
    verifyGroupOwnership), or enrolled in the group. Fails closed.
    """
    if not user_email:
        return False
    conn = connect_to_db()
    cur = conn.cursor()
    try:
        cur.execute(
            """SELECT 1 FROM "users" u
               WHERE u.user_email = %s
                 AND (
                   'admin' = ANY(u.roles)
                   OR EXISTS (SELECT 1 FROM "simulation_groups" sg
                              WHERE sg.simulation_group_id = %s AND sg.created_by = u.user_id)
                   OR EXISTS (SELECT 1 FROM "group_instructors" gi
                              WHERE gi.simulation_group_id = %s AND gi.user_id = u.user_id)
                   OR EXISTS (SELECT 1 FROM "enrollments" e
                              WHERE e.simulation_group_id = %s AND e.user_id = u.user_id)
                 )""",
            (user_email, simulation_group_id, simulation_group_id, simulation_group_id),
        )
        allowed = cur.fetchone() is not None
        cur.close()
        return allowed
    except Exception as e:
        cur.close()
        conn.rollback()
        logger.error(f"Error verifying group access: {e}")
        return False


@logger.inject_lambda_context
def lambda_handler(event, context):
    # Caller identity from the API Gateway authorizer context
    user_email = (event.get("requestContext") or {}).get("authorizer", {}).get("email", "")
    query_params = event.get("queryStringParameters") or {}
    simulation_group_id = query_params.get("simulation_group_id")

    if not simulation_group_id:
        return {
            'statusCode': 400,
            "headers": get_cors_headers(event),
            'body': json.dumps("Missing required parameter: simulation_group_id"),
        }

    if not has_group_access(user_email, simulation_group_id):
        logger.warning("Unauthorized access attempt to getProfilePictures", extra={
            "user_email": user_email,
            "simulation_group_id": simulation_group_id,
        })
        return {
            'statusCode': 403,
            "headers": get_cors_headers(event),
            'body': json.dumps("Forbidden: You do not have access to this simulation group"),
        }

    # Get persona_ids from database
    persona_ids = fetch_persona_ids(simulation_group_id)

    if not persona_ids:
        return {
            'statusCode': 400,
            "headers": get_cors_headers(event),
            'body': json.dumps("No persona IDs found"),
        }

    profile_pics = {}
    for persona_id in persona_ids:
        key = f"{simulation_group_id}/{persona_id}/profile_picture/{persona_id}_profile_pic.png"
        url = generate_presigned_url(BUCKET, key)
        if url:
            profile_pics[persona_id] = url

    return {
        'statusCode': 200,
        "headers": get_cors_headers(event),
        'body': json.dumps(profile_pics)
    }