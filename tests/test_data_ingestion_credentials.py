"""
Data-ingestion Lambda (cdk/data_ingestion/src/main.py): DB secret caching
survives the app_tc password rotation done by db_setup on every deploy.

  - the cached secret expires after DB_SECRET_TTL_SECONDS and can be force-refreshed
  - an authentication failure on a new connection triggers exactly one forced
    secret refresh + retry, both for the direct psycopg2 connection and for the
    PGVector / SQLRecordManager (SQLAlchemy) connection built in helpers/helper.py
  - non-auth errors are not retried, and a second auth failure propagates
  - a closed or broken cached connection is replaced

main.py, helpers/vectorstore.py and helpers/helper.py are the real modules;
psycopg2, LangChain, PGVector, SQLRecordManager and the document processor are stubs.
"""
import importlib.util
import json
import logging
import os
import sys
import types

import pytest

_SRC = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "cdk", "data_ingestion", "src")

SECRET_V1 = {"username": "app_tc", "password": "old-pass", "dbname": "db", "port": 5432}
SECRET_V2 = {"username": "app_tc", "password": "new-pass", "dbname": "db", "port": 5432}
AUTH_MESSAGE = 'connection failed: FATAL:  password authentication failed for user "app_tc"'


class FakeOperationalError(Exception):
    """Stands in for psycopg2/psycopg OperationalError."""

    def __init__(self, msg, sqlstate=None, pgcode=None):
        super().__init__(msg)
        self.sqlstate = sqlstate
        self.pgcode = pgcode


class FakeSAOperationalError(Exception):
    """Stands in for sqlalchemy.exc.OperationalError (driver error in .orig)."""

    def __init__(self, orig):
        super().__init__(f"(psycopg.OperationalError) {orig}")
        self.orig = orig


class FakeSecrets:
    """Secrets Manager stub returning a queue of secret versions."""

    def __init__(self, versions):
        self.versions = list(versions)
        self.calls = 0

    def get_secret_value(self, SecretId):
        self.calls += 1
        value = self.versions[min(self.calls - 1, len(self.versions) - 1)]
        return {"SecretString": json.dumps(value)}


class FakeCursor:
    def __init__(self, conn):
        self.conn = conn

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, *args):
        if self.conn.broken:
            raise FakeOperationalError("server closed the connection unexpectedly")

    def fetchone(self):
        return (1,)

    def fetchall(self):
        return self.conn.leftover_privileges


class FakeConn:
    def __init__(self, password, closed=0, broken=False):
        self.password = password
        self.closed = closed
        self.broken = broken
        self.autocommit = False
        self.close_calls = 0
        self.leftover_privileges = []

    def cursor(self):
        return FakeCursor(self)

    def commit(self):
        pass

    def rollback(self):
        pass

    def close(self):
        self.close_calls += 1
        self.closed = 1


def _password_from_url(url):
    # postgresql+psycopg://user:password@host:port/db?sslmode=verify-full&sslrootcert=...
    return url.split("://", 1)[1].split("@", 1)[0].split(":", 1)[1]


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def stubs(monkeypatch):
    """Install dependency stubs; tests tune their behaviour via the returned namespace."""
    for key, value in {
        "SM_DB_CREDENTIALS": "tc-secret",
        "REGION": "us-east-1",
        "AWS_DEFAULT_REGION": "us-east-1",
        "BUCKET": "ingest-bucket",
        "EMBEDDING_BUCKET_NAME": "embedding-bucket",
        "RDS_PROXY_ENDPOINT": "proxy",
        "EMBEDDING_MODEL_PARAM": "embedding-param",
    }.items():
        monkeypatch.setenv(key, value)

    state = types.SimpleNamespace(
        db_password="new-pass",      # password the DB currently accepts
        connect_attempts=[],         # passwords used for psycopg2.connect
        connect_error=None,          # force a specific psycopg2.connect error
        pgvector_attempts=[],        # passwords used to construct PGVector
        pgvector_error=None,         # force a specific PGVector error
        record_manager_urls=[],
        record_manager_fail_auth=False,
        processed=[],
    )

    def connect(**kw):
        state.connect_attempts.append(kw["password"])
        assert kw["sslmode"] == "verify-full"
        assert kw["sslrootcert"]
        if state.connect_error is not None:
            raise state.connect_error
        if kw["password"] != state.db_password:
            raise FakeOperationalError(AUTH_MESSAGE)
        return FakeConn(kw["password"])

    psycopg2 = types.ModuleType("psycopg2")
    psycopg2.OperationalError = FakeOperationalError
    psycopg2.connect = connect
    psycopg2.errors = types.SimpleNamespace(UndefinedTable=type("UndefinedTable", (Exception,), {}))

    class PGVector:
        def __init__(self, embeddings, collection_name, connection, use_jsonb, create_extension):
            password = _password_from_url(connection)
            state.pgvector_attempts.append(password)
            if state.pgvector_error is not None:
                raise state.pgvector_error
            if password != state.db_password:
                raise FakeSAOperationalError(FakeOperationalError(AUTH_MESSAGE))
            self.collection_name = collection_name

    class SQLRecordManager:
        def __init__(self, namespace, db_url):
            self.db_url = db_url
            state.record_manager_urls.append(_password_from_url(db_url))

        def create_schema(self):
            if state.record_manager_fail_auth and _password_from_url(self.db_url) != state.db_password:
                raise FakeSAOperationalError(FakeOperationalError("x", sqlstate="28P01"))

    langchain_aws = types.ModuleType("langchain_aws")
    langchain_aws.BedrockEmbeddings = lambda **kw: types.SimpleNamespace(**kw)
    langchain_postgres = types.ModuleType("langchain_postgres")
    langchain_postgres.PGVector = PGVector
    langchain_classic = types.ModuleType("langchain_classic")
    indexes = types.ModuleType("langchain_classic.indexes")
    indexes.SQLRecordManager = SQLRecordManager
    indexes.index = lambda *a, **kw: None
    processing = types.ModuleType("processing")
    documents = types.ModuleType("processing.documents")
    documents.process_documents = lambda **kw: state.processed.append(kw["vectorstore"].collection_name)
    cohere = types.ModuleType("helpers.cohere_embeddings")
    cohere.CohereBedrockEmbeddings = lambda **kw: types.SimpleNamespace(**kw)
    # Package stub so "helpers.*" resolves to data_ingestion (text_generation also has helpers/).
    helpers_pkg = types.ModuleType("helpers")
    helpers_pkg.__path__ = [os.path.join(_SRC, "helpers")]

    for name, mod in {
        "psycopg2": psycopg2,
        "langchain_aws": langchain_aws,
        "langchain_postgres": langchain_postgres,
        "langchain_classic": langchain_classic,
        "langchain_classic.indexes": indexes,
        "processing": processing,
        "processing.documents": documents,
        "helpers": helpers_pkg,
        "helpers.cohere_embeddings": cohere,
    }.items():
        monkeypatch.setitem(sys.modules, name, mod)
    return state


@pytest.fixture
def main(stubs, monkeypatch):
    helper = _load("helpers.helper", os.path.join(_SRC, "helpers", "helper.py"))
    monkeypatch.setitem(sys.modules, "helpers.helper", helper)
    vectorstore = _load("helpers.vectorstore", os.path.join(_SRC, "helpers", "vectorstore.py"))
    monkeypatch.setitem(sys.modules, "helpers.vectorstore", vectorstore)
    module = _load("_ingest_main_under_test", os.path.join(_SRC, "main.py"))
    module._helper = helper
    return module


def _use_secrets(main, monkeypatch, *versions):
    sm = FakeSecrets(versions)
    monkeypatch.setattr(main, "secrets_manager_client", sm)
    return sm


def _logged(caplog):
    return "\n".join(r.getMessage() for r in caplog.records)


# ── Secret caching ──────────────────────────────────────────────────────────

def test_secret_is_cached_within_ttl(main, monkeypatch):
    sm = _use_secrets(main, monkeypatch, SECRET_V1, SECRET_V2)
    assert main.get_secret()["password"] == "old-pass"
    assert main.get_secret()["password"] == "old-pass"
    assert sm.calls == 1


def test_secret_is_reread_after_ttl(main, monkeypatch):
    sm = _use_secrets(main, monkeypatch, SECRET_V1, SECRET_V2)
    main.get_secret()
    monkeypatch.setattr(main, "db_secret_loaded_at", main.db_secret_loaded_at - main.DB_SECRET_TTL_SECONDS - 1)
    assert main.get_secret()["password"] == "new-pass"
    assert sm.calls == 2


def test_force_refresh_rereads_immediately(main, monkeypatch):
    sm = _use_secrets(main, monkeypatch, SECRET_V1, SECRET_V2)
    main.get_secret()
    assert main.get_secret(force_refresh=True)["password"] == "new-pass"
    assert sm.calls == 2


def test_ttl_matches_text_generation(main):
    assert main.DB_SECRET_TTL_SECONDS == 300


# ── Direct psycopg2 connection ──────────────────────────────────────────────

def test_connect_refreshes_secret_once_after_rotation(main, stubs, monkeypatch, caplog):
    caplog.set_level(logging.DEBUG)
    sm = _use_secrets(main, monkeypatch, SECRET_V1, SECRET_V2)
    conn = main.connect_to_db()
    assert conn.password == "new-pass"
    assert conn.autocommit is True
    assert stubs.connect_attempts == ["old-pass", "new-pass"]
    assert sm.calls == 2
    assert main.connection is conn
    logged = _logged(caplog)
    assert "old-pass" not in logged and "new-pass" not in logged


def test_connect_second_auth_failure_propagates(main, stubs, monkeypatch):
    stubs.db_password = "never"
    sm = _use_secrets(main, monkeypatch, SECRET_V1, SECRET_V2)
    with pytest.raises(FakeOperationalError):
        main.connect_to_db()
    assert stubs.connect_attempts == ["old-pass", "new-pass"]
    assert sm.calls == 2
    assert main.connection is None


def test_connect_does_not_retry_non_auth_errors(main, stubs, monkeypatch):
    stubs.connect_error = FakeOperationalError("connection timeout expired")
    sm = _use_secrets(main, monkeypatch, SECRET_V1, SECRET_V2)
    with pytest.raises(FakeOperationalError):
        main.connect_to_db()
    assert stubs.connect_attempts == ["old-pass"]
    assert sm.calls == 1


def test_live_cached_connection_is_reused(main, stubs, monkeypatch):
    _use_secrets(main, monkeypatch, SECRET_V2)
    cached = FakeConn("new-pass")
    monkeypatch.setattr(main, "connection", cached)
    assert main.connect_to_db() is cached
    assert stubs.connect_attempts == []


@pytest.mark.parametrize("cached", [
    FakeConn("old-pass", closed=1),                 # closed client-side
    FakeConn("old-pass", closed=0, broken=True),    # terminated server-side
], ids=["closed", "broken"])
def test_dead_cached_connection_reconnects_with_refreshed_secret(main, stubs, monkeypatch, cached):
    sm = _use_secrets(main, monkeypatch, SECRET_V1, SECRET_V2)
    main.get_secret()  # warm container: old password cached, still within TTL
    monkeypatch.setattr(main, "connection", cached)
    conn = main.connect_to_db()
    assert conn is not cached and conn.password == "new-pass"
    assert main.connection is conn
    assert stubs.connect_attempts == ["old-pass", "new-pass"]
    assert sm.calls == 2
    assert cached.closed


# ── PGVector / SQLRecordManager connection ──────────────────────────────────

def test_vectorstore_retries_once_with_refreshed_secret(main, stubs, monkeypatch, caplog):
    caplog.set_level(logging.DEBUG)
    sm = _use_secrets(main, monkeypatch, SECRET_V1, SECRET_V2)
    main._update_vectorstore_with_retry("bucket", "group-1", "persona-1", "emb", FakeConn("new-pass"))
    assert stubs.pgvector_attempts == ["old-pass", "new-pass"]
    assert stubs.record_manager_urls == ["new-pass"]
    assert stubs.processed == ["persona-1"]
    assert sm.calls == 2
    logged = _logged(caplog)
    assert "old-pass" not in logged and "new-pass" not in logged


def test_record_manager_auth_failure_is_retried_once(main, stubs, monkeypatch):
    stubs.record_manager_fail_auth = True
    # PGVector accepts any password here so the failure surfaces in create_schema().
    monkeypatch.setattr(main._helper, "PGVector", lambda **kw: types.SimpleNamespace(collection_name=kw["collection_name"]))
    sm = _use_secrets(main, monkeypatch, SECRET_V1, SECRET_V2)
    main._update_vectorstore_with_retry("bucket", "group-1", "persona-1", "emb", FakeConn("new-pass"))
    assert stubs.record_manager_urls == ["old-pass", "new-pass"]
    assert stubs.processed == ["persona-1"]
    assert sm.calls == 2


def test_vectorstore_second_auth_failure_propagates(main, stubs, monkeypatch):
    stubs.db_password = "never"
    sm = _use_secrets(main, monkeypatch, SECRET_V1, SECRET_V2)
    with pytest.raises(FakeSAOperationalError):
        main._update_vectorstore_with_retry("bucket", "group-1", "persona-1", "emb", FakeConn("x"))
    assert stubs.pgvector_attempts == ["old-pass", "new-pass"]
    assert stubs.processed == []
    assert sm.calls == 2


def test_vectorstore_non_auth_error_is_not_retried(main, stubs, monkeypatch):
    stubs.pgvector_error = FakeSAOperationalError(FakeOperationalError("could not translate host name"))
    sm = _use_secrets(main, monkeypatch, SECRET_V1, SECRET_V2)
    with pytest.raises(Exception):
        main._update_vectorstore_with_retry("bucket", "group-1", "persona-1", "emb", FakeConn("x"))
    assert stubs.pgvector_attempts == ["old-pass"]
    assert stubs.processed == []
    assert sm.calls == 1


def test_auth_failure_during_ingest_is_not_replayed(main, stubs, monkeypatch):
    """Only setup is retried. process_documents() changes ingestion_status and
    deletes temp page objects, so replaying it after a mid-ingest auth failure
    could skip every file and report success (finding f-2ded25ae)."""
    stubs.db_password = "old-pass"  # setup authenticates fine
    calls = []

    def failing_process_documents(**kw):
        calls.append(kw["vectorstore"].collection_name)
        raise FakeSAOperationalError(FakeOperationalError(AUTH_MESSAGE))

    monkeypatch.setattr(main._helper, "process_documents", failing_process_documents)
    sm = _use_secrets(main, monkeypatch, SECRET_V1, SECRET_V2)
    with pytest.raises(FakeSAOperationalError):
        main._update_vectorstore_with_retry("bucket", "group-1", "persona-1", "emb", FakeConn("old-pass"))
    assert calls == ["persona-1"]                # ingest ran exactly once
    assert stubs.pgvector_attempts == ["old-pass"]
    assert sm.calls == 1                         # no forced refresh + replay


def test_vectorstore_init_failure_raises(main, stubs, monkeypatch):
    """get_vectorstore() returning None (non-auth failure) must surface as an
    error so the handler marks the file "error" instead of leaving it "processing"."""
    stubs.pgvector_error = ValueError("bad collection")
    _use_secrets(main, monkeypatch, SECRET_V1)
    stubs.db_password = "old-pass"
    with pytest.raises(RuntimeError, match="VectorStore could not be initialized"):
        main._update_vectorstore_with_retry("bucket", "group-1", "persona-1", "emb", FakeConn("old-pass"))
    assert stubs.processed == []


def test_readwrite_grants_applied_once_per_container(main, stubs, monkeypatch):
    """Fresh DB: tables created as app_tc are narrowed for readwrite right after
    open_vectorstore(), once per warm container (finding f-92cde84f)."""
    stubs.db_password = "old-pass"
    executed = []
    monkeypatch.setattr(main, "grant_readwrite_on_vectorstore_tables", lambda conn: executed.append(conn) or True)
    _use_secrets(main, monkeypatch, SECRET_V1)
    conn = FakeConn("old-pass")
    main._update_vectorstore_with_retry("bucket", "group-1", "persona-1", "emb", conn)
    main._update_vectorstore_with_retry("bucket", "group-1", "persona-1", "emb", conn)
    assert executed == [conn]
    assert stubs.processed == ["persona-1", "persona-1"]


def test_readwrite_grants_retried_after_failure(main, stubs, monkeypatch):
    stubs.db_password = "old-pass"
    results = [False, True]
    calls = []
    monkeypatch.setattr(main, "grant_readwrite_on_vectorstore_tables", lambda conn: calls.append(1) or results[len(calls) - 1])
    _use_secrets(main, monkeypatch, SECRET_V1)
    for _ in range(3):
        main._update_vectorstore_with_retry("bucket", "group-1", "persona-1", "emb", FakeConn("old-pass"))
    assert len(calls) == 2  # failed once, succeeded, then skipped


def test_grant_sql_never_grants_update_or_touches_upsertion_record(main):
    sql = main._helper.READWRITE_GRANTS_SQL
    assert "UPDATE" not in sql
    assert "'SELECT, INSERT'" in sql and "'SELECT, DELETE'" in sql
    assert "upsertion_record" not in sql          # unlisted -> REVOKE ALL, no grant
    assert "REVOKE ALL ON TABLE" in sql
    assert "c.relowner" in sql                    # only app_tc-owned tables


def test_grant_failure_is_logged_not_raised(main):
    class BadCursor(FakeCursor):
        def execute(self, *args):
            raise RuntimeError("must be owner of table")

    class BadConn(FakeConn):
        def cursor(self):
            return BadCursor(self)

    assert main._helper.grant_readwrite_on_vectorstore_tables(BadConn("x")) is False


def test_grant_reports_failure_when_forbidden_privileges_remain(main, caplog):
    """REVOKE only drops grants made by the revoking role, so the end state is
    checked; leftover privileges mean "not applied" (finding f-00728bf7)."""
    conn = FakeConn("x")
    assert main._helper.grant_readwrite_on_vectorstore_tables(conn) is True
    conn.leftover_privileges = [("langchain_pg_embedding", "UPDATE")]
    assert main._helper.grant_readwrite_on_vectorstore_tables(conn) is False
    logged = _logged(caplog)
    assert "langchain_pg_embedding" in logged
    # The CloudWatch alarm's metric filter keys on this exact marker.
    assert main._helper.READWRITE_PRIVILEGE_CHECK_FAILED == "READWRITE_PRIVILEGE_CHECK_FAILED"
    assert "READWRITE_PRIVILEGE_CHECK_FAILED" in logged


def test_privilege_check_marker_not_logged_when_clean(main, caplog):
    assert main._helper.grant_readwrite_on_vectorstore_tables(FakeConn("x")) is True
    assert "READWRITE_PRIVILEGE_CHECK_FAILED" not in _logged(caplog)


def test_forbidden_privileges_check_covers_write_paths(main):
    sql = main._helper.READWRITE_FORBIDDEN_PRIVILEGES_SQL
    for pair in [
        "('langchain_pg_embedding',  'UPDATE')",
        "('langchain_pg_embedding',  'INSERT')",
        "('langchain_pg_collection', 'UPDATE')",
        "('upsertion_record', 'INSERT')",
    ]:
        assert pair in sql


def test_temp_page_404_marks_file_error_unless_completed(main, stubs, monkeypatch):
    """A concurrent run consumed the temp pages: this run marked nothing, so the
    triggering file gets a terminal status (finding f-4cbaf78d)."""
    stubs.db_password = "old-pass"
    marked = []
    monkeypatch.setattr(main, "mark_error_unless_completed", lambda p, f: marked.append((p, f)) or True)
    monkeypatch.setattr(main, "get_parameter", lambda: "amazon.titan-embed-text-v2:0")

    def raise_404(*a, **kw):
        raise RuntimeError("An error occurred (404) when calling the HeadObject operation: Not Found")

    monkeypatch.setattr(main, "_update_vectorstore_with_retry", raise_404)
    _use_secrets(main, monkeypatch, SECRET_V1)
    main.update_vectorstore_from_s3("ingest-bucket", "group-1", "persona-1", "group-1/persona-1/documents/a.pdf")
    assert marked == [("persona-1", "group-1/persona-1/documents/a.pdf")]


def test_ingest_failure_marks_file_error(main, stubs, monkeypatch):
    stubs.db_password = "old-pass"
    statuses = []
    monkeypatch.setattr(main, "update_ingestion_status", lambda p, f, s: statuses.append((p, f, s)))
    monkeypatch.setattr(main, "get_parameter", lambda: "amazon.titan-embed-text-v2:0")
    stubs.pgvector_error = ValueError("bad collection")
    _use_secrets(main, monkeypatch, SECRET_V1)
    with pytest.raises(RuntimeError, match="VectorStore could not be initialized"):
        main.update_vectorstore_from_s3("ingest-bucket", "group-1", "persona-1", "group-1/persona-1/documents/a.pdf")
    assert statuses == [("persona-1", "group-1/persona-1/documents/a.pdf", "error")]


def test_status_write_failure_does_not_mask_original_error(main, stubs, monkeypatch):
    stubs.db_password = "old-pass"

    def broken_status_write(*args):
        raise TypeError("status write failed")

    monkeypatch.setattr(main, "update_ingestion_status", broken_status_write)
    monkeypatch.setattr(main, "get_parameter", lambda: "amazon.titan-embed-text-v2:0")
    stubs.pgvector_error = ValueError("bad collection")
    _use_secrets(main, monkeypatch, SECRET_V1)
    with pytest.raises(RuntimeError, match="VectorStore could not be initialized"):
        main.update_vectorstore_from_s3("ingest-bucket", "group-1", "persona-1", "group-1/persona-1/documents/a.pdf")


def test_update_vectorstore_from_s3_uses_retry(main, stubs, monkeypatch):
    """End-to-end through the S3 handler's vectorstore step after a rotation."""
    sm = _use_secrets(main, monkeypatch, SECRET_V1, SECRET_V2)
    monkeypatch.setattr(main, "get_parameter", lambda: "amazon.titan-embed-text-v2:0")
    main.update_vectorstore_from_s3("ingest-bucket", "group-1", "persona-1", "group-1/persona-1/documents/a.pdf")
    # psycopg2 connect: old -> refresh -> new; PGVector then uses the refreshed (cached) secret.
    assert stubs.connect_attempts == ["old-pass", "new-pass"]
    assert stubs.pgvector_attempts == ["new-pass"]
    assert stubs.processed == ["persona-1"]
    assert sm.calls == 2


# ── Auth-error classification ───────────────────────────────────────────────

@pytest.mark.parametrize("error,expected", [
    (FakeOperationalError(AUTH_MESSAGE), True),
    (FakeOperationalError("x", sqlstate="28P01"), True),
    (FakeOperationalError("x", pgcode="28000"), True),
    (FakeSAOperationalError(FakeOperationalError("x", sqlstate="28P01")), True),
    (FakeSAOperationalError(FakeOperationalError(AUTH_MESSAGE)), True),
    (FakeOperationalError("The password that was provided for the role app_tc is wrong."), True),
    (FakeOperationalError("connection refused"), False),
    (FakeOperationalError("x", sqlstate="57P01"), False),
    (FakeSAOperationalError(FakeOperationalError("timeout expired")), False),
])
def test_is_db_auth_error(main, error, expected):
    assert main.is_db_auth_error(error) is expected
