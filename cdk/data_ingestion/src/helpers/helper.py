import logging
import os
import boto3
from typing import Dict, Optional, Tuple
import psycopg2

from langchain_aws import BedrockEmbeddings
from langchain_postgres import PGVector
from langchain_classic.indexes import SQLRecordManager, index

from processing.documents import process_documents
s3 = boto3.client('s3')

# Setup logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# RDS Proxy presents an ACM certificate; verify it (and the hostname) against
# the Amazon Trust Services roots in the OS trust store.
# https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-proxy.howitworks.html#rds-proxy-security.tls
DB_SSL_ROOT_CERT = os.environ.get("PGSSLROOTCERT", "/etc/pki/tls/certs/ca-bundle.crt")

# SQLSTATE invalid_password / invalid_authorization_specification
_AUTH_SQLSTATES = ("28P01", "28000")

def is_db_auth_error(error) -> bool:
    """True for a wrong/rotated DB password.

    Works for psycopg2/psycopg OperationalErrors and SQLAlchemy's wrapper
    (whose .orig is the driver error); falls back to the message, since
    connection-time errors (and RDS Proxy's) often carry no SQLSTATE.
    """
    for err in (error, getattr(error, "orig", None)):
        if err is None:
            continue
        if getattr(err, "sqlstate", None) in _AUTH_SQLSTATES or getattr(err, "pgcode", None) in _AUTH_SQLSTATES:
            return True
    msg = str(error).lower()
    return "password" in msg and ("authentication failed" in msg or "wrong" in msg)

# Run as app_tc right after the vectorstore tables exist. On a fresh DB this
# Lambda creates langchain_pg_collection / langchain_pg_embedding /
# upsertion_record, so app_tc owns them and only it can grant on them. They
# start with SELECT for readwrite (db_setup's default privileges); this sets
# each app_tc-owned table to exactly what the app_rw Lambdas need:
#   langchain_pg_collection: SELECT, INSERT (text_generation PGVector get-or-create)
#   langchain_pg_embedding:  SELECT, DELETE (RAG retrieval, deleteFile)
#   anything else (upsertion_record): nothing
# Only tables owned by app_tc are touched, so on databases where the master
# user created these tables this is a no-op.
# Keep in sync with grantReadwriteOnTableCreatorObjects in cdk/lambda/db_setup/index.js.
READWRITE_GRANTS_SQL = """
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.relname,
           CASE c.relname
             WHEN 'langchain_pg_collection' THEN 'SELECT, INSERT'
             WHEN 'langchain_pg_embedding'  THEN 'SELECT, DELETE'
           END AS privs
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p')
      AND c.relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
  LOOP
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM readwrite', r.relname);
    IF r.privs IS NOT NULL THEN
      EXECUTE format('GRANT %s ON TABLE public.%I TO readwrite', r.privs, r.relname);
    END IF;
  END LOOP;
END$$;
"""

# Privileges readwrite must NOT hold on the vectorstore tables, whoever owns them.
# Keep in sync with READWRITE_FORBIDDEN_PRIVILEGES_SQL in cdk/lambda/db_setup/index.js.
READWRITE_FORBIDDEN_PRIVILEGES_SQL = """
SELECT f.tbl, f.priv
FROM (VALUES
  ('langchain_pg_collection', 'UPDATE'), ('langchain_pg_collection', 'DELETE'),
  ('langchain_pg_embedding',  'UPDATE'), ('langchain_pg_embedding',  'INSERT'),
  ('upsertion_record', 'SELECT'), ('upsertion_record', 'INSERT'),
  ('upsertion_record', 'UPDATE'), ('upsertion_record', 'DELETE')
) AS f(tbl, priv)
WHERE to_regclass('public.' || f.tbl) IS NOT NULL
  AND has_table_privilege('readwrite', to_regclass('public.' || f.tbl), f.priv);
"""

# Logged when readwrite still holds forbidden privileges after narrowing. A
# CloudWatch metric filter in cdk/lib/api-service-stack.ts matches this exact
# string and drives the ReadwritePrivilegeCheck alarm; don't change it alone.
READWRITE_PRIVILEGE_CHECK_FAILED = "READWRITE_PRIVILEGE_CHECK_FAILED"

def grant_readwrite_on_vectorstore_tables(connection) -> bool:
    """Apply READWRITE_GRANTS_SQL on the app_tc psycopg2 connection, then
    confirm readwrite holds none of READWRITE_FORBIDDEN_PRIVILEGES_SQL.

    A REVOKE only removes grants made by the revoking role or the owner, so
    the end state is checked rather than assumed.

    A failure is logged, not raised: ingestion itself is unaffected, and
    readwrite keeps SELECT from the default privileges, so RAG retrieval still
    works. Only deleteFile's DELETE would be missing until the next deploy,
    when db_setup re-runs the same grants (and fails the deploy if forbidden
    privileges remain).

    Leftover forbidden privileges are logged with READWRITE_PRIVILEGE_CHECK_FAILED
    so the CloudWatch alarm fires instead of the failure only reaching the logs.

    Returns True only if the grants were applied and the check is clean, so
    main.py tries again on the next invocation otherwise.
    """
    try:
        with connection.cursor() as cur:
            cur.execute(READWRITE_GRANTS_SQL)
            cur.execute(READWRITE_FORBIDDEN_PRIVILEGES_SQL)
            leftover = cur.fetchall()
        if not connection.autocommit:
            connection.commit()
        if leftover:
            logger.error(
                f"{READWRITE_PRIVILEGE_CHECK_FAILED}: readwrite still holds privileges "
                f"it should not have on vectorstore tables: {leftover}"
            )
            return False
        return True
    except Exception as e:
        try:
            connection.rollback()
        except Exception:
            pass
        logger.error(f"Could not apply readwrite grants on vectorstore tables: {e}")
        return False

def get_vectorstore(
    collection_name: str, 
    embeddings: BedrockEmbeddings, 
    dbname: str, 
    user: str, 
    password: str, 
    host: str, 
    port: int
) -> Optional[PGVector]:
    """
    Initialize and return a PGVector instance.
    
    Args:
    collection_name (str): The name of the collection.
    embeddings (BedrockEmbeddings): The embeddings instance.
    dbname (str): The name of the database.
    user (str): The database user.
    password (str): The database password.
    host (str): The database host.
    port (int): The database port.
    
    Returns:
    Optional[PGVector]: The initialized PGVector instance, or None if an error occurred.
    """
    try:
        connection_string = (
            f"postgresql+psycopg://{user}:{password}@{host}:{port}/{dbname}"
            f"?sslmode=verify-full&sslrootcert={DB_SSL_ROOT_CERT}"
        )

        logger.info("Initializing the VectorStore")
        # create_extension=False: the vector extension is created by the db_setup
        # baseline migration, and this Lambda connects as the least-privilege
        # app_tc user, which should not issue CREATE EXTENSION.
        vectorstore = PGVector(
            embeddings=embeddings,
            collection_name=collection_name,
            connection=connection_string,
            use_jsonb=True,
            create_extension=False,
        )

        logger.info("VectorStore initialized")
        return vectorstore, connection_string

    except Exception as e:
        logger.error(f"Error initializing vector store: {e}")
        # Let a rotated-password failure reach main.py, which re-reads the
        # secret and retries once; other errors keep the existing behaviour.
        if is_db_auth_error(e):
            raise
        return None
    
def open_vectorstore(
    vectorstore_config_dict: Dict[str, str],
    embeddings: BedrockEmbeddings
) -> Tuple[PGVector, SQLRecordManager]:
    """
    Open the PGVector store and SQLRecordManager for a collection.

    This is the only credential-dependent setup step, and it changes no
    document state, so main.py can safely retry it with a refreshed secret.
    Both objects connect here (PGVector creates its tables/collection,
    create_schema() creates upsertion_record), so a rotated password fails
    here rather than later inside index().

    Returns:
    (vectorstore, record_manager).

    Raises:
    RuntimeError if the vectorstore could not be initialized for a
    non-authentication reason (get_vectorstore() has already logged it), so
    the caller marks the file "error" instead of leaving it "processing".
    """
    result = get_vectorstore(
        collection_name=vectorstore_config_dict['collection_name'],
        embeddings=embeddings,
        dbname=vectorstore_config_dict['dbname'],
        user=vectorstore_config_dict['user'],
        password=vectorstore_config_dict['password'],
        host=vectorstore_config_dict['host'],
        port=int(vectorstore_config_dict['port'])
    )
    if result is None:
        raise RuntimeError("VectorStore could not be initialized")
    vectorstore, connection_string = result

    namespace = f"pgvector/{vectorstore_config_dict['collection_name']}"
    record_manager = SQLRecordManager(
        namespace, db_url=connection_string
    )
    record_manager.create_schema()
    return vectorstore, record_manager

def store_group_data(
    bucket: str, 
    group: str, 
    persona_id: str, 
    vectorstore: Optional[PGVector],
    record_manager: Optional[SQLRecordManager],
    embeddings: BedrockEmbeddings,
    connection
) -> None:
    """
    Store group data from an S3 bucket into the vectorstore.
    
    Args:
    bucket (str): The name of the S3 bucket.
    group (str): The group name/folder in the S3 bucket.
    vectorstore (PGVector): The vectorstore opened by open_vectorstore().
    record_manager (SQLRecordManager): The record manager opened by open_vectorstore().
    embeddings (BedrockEmbeddings): The embeddings instance.
    """
    if not vectorstore:
        logger.error("VectorStore could not be initialized")
        return

    # Process all files in the "documents" folder
    process_documents(
        bucket=bucket,
        group=group,
        persona_id=persona_id,
        vectorstore=vectorstore,
        embeddings=embeddings,
        record_manager=record_manager,
        connection=connection
    )
