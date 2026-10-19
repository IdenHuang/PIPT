"""
Text-generation Lambda (cdk/text_generation/src/main.py):
  - DB secret caching survives the app_rw password rotation done by db_setup
    (TTL, refresh + single retry on authentication failure)
  - the handler never logs the caller's JWT or the raw event, and never reuses
    a previous invocation's token

main.py is loaded with its heavy dependencies (LangChain, chat helpers,
psycopg) replaced by stubs; helpers/authz.py is the real module.
"""
import importlib.util
import logging
import os
import sys
import types

import pytest

_SRC = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "cdk", "text_generation", "src")

SECRET_V1 = {"username": "app_rw", "password": "old-pass", "dbname": "db", "port": 5432}
SECRET_V2 = {"username": "app_rw", "password": "new-pass", "dbname": "db", "port": 5432}
JWT = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.c2lnbmF0dXJlLXNlY3JldA"


class FakeOperationalError(Exception):
    def __init__(self, msg, sqlstate=None):
        super().__init__(msg)
        self.sqlstate = sqlstate


class FakeSecrets:
    """Secrets Manager stub returning a queue of secret versions."""

    def __init__(self, versions):
        self.versions = list(versions)
        self.calls = 0

    def get_secret_value(self, SecretId):
        import json
        self.calls += 1
        value = self.versions[min(self.calls - 1, len(self.versions) - 1)]
        return {"SecretString": json.dumps(value)}


@pytest.fixture
def main(monkeypatch):
    for key, value in {
        "SM_DB_CREDENTIALS": "user-secret",
        "REGION": "us-east-1",
        "AWS_DEFAULT_REGION": "us-east-1",
        "RDS_PROXY_ENDPOINT": "proxy",
        "BEDROCK_LLM_PARAM": "p1",
        "EMBEDDING_MODEL_PARAM": "p2",
        "TABLE_NAME_PARAM": "p3",
    }.items():
        monkeypatch.setenv(key, value)

    psycopg = types.ModuleType("psycopg")
    psycopg.OperationalError = FakeOperationalError
    psycopg.connect = lambda **kw: None
    monkeypatch.setitem(sys.modules, "psycopg", psycopg)

    langchain_aws = types.ModuleType("langchain_aws")
    langchain_aws.BedrockEmbeddings = type("BedrockEmbeddings", (), {})
    monkeypatch.setitem(sys.modules, "langchain_aws", langchain_aws)

    def get_cognito_token():
        return getattr(get_cognito_token, "current_token", None)

    chat = types.ModuleType("helpers.chat")
    chat.get_cognito_token = get_cognito_token
    chat.get_default_system_prompt = lambda name: f"system prompt for {name}"
    for name in ("get_bedrock_llm", "get_initial_student_query", "get_student_query", "set_stream_callback_url"):
        setattr(chat, name, lambda *a, **kw: None)
    cohere = types.ModuleType("helpers.cohere_embeddings")
    cohere.CohereBedrockEmbeddings = type("CohereBedrockEmbeddings", (), {})
    seed = types.ModuleType("helpers.seed_prompt")
    seed.seed_prompt = lambda *a, **kw: None
    vectorstore = types.ModuleType("helpers.vectorstore")
    vectorstore.get_vectorstore_retriever = lambda **kw: "retriever"
    for name, mod in {
        "helpers.chat": chat,
        "helpers.cohere_embeddings": cohere,
        "helpers.seed_prompt": seed,
        "helpers.vectorstore": vectorstore,
    }.items():
        monkeypatch.setitem(sys.modules, name, mod)
    monkeypatch.syspath_prepend(_SRC)

    spec = importlib.util.spec_from_file_location("_textgen_main_under_test", os.path.join(_SRC, "main.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module._chat_stub = chat
    module._vectorstore_stub = vectorstore
    module._psycopg_stub = psycopg
    return module


# ── Secret caching ──────────────────────────────────────────────────────────

def test_secret_is_cached_within_ttl(main, monkeypatch):
    sm = FakeSecrets([SECRET_V1, SECRET_V2])
    monkeypatch.setattr(main, "secrets_manager_client", sm)
    assert main.get_secret("user-secret")["password"] == "old-pass"
    assert main.get_secret("user-secret")["password"] == "old-pass"
    assert sm.calls == 1


def test_secret_is_reread_after_ttl(main, monkeypatch):
    sm = FakeSecrets([SECRET_V1, SECRET_V2])
    monkeypatch.setattr(main, "secrets_manager_client", sm)
    main.get_secret("user-secret")
    monkeypatch.setattr(main, "db_secret_loaded_at", main.db_secret_loaded_at - main.DB_SECRET_TTL_SECONDS - 1)
    assert main.get_secret("user-secret")["password"] == "new-pass"


def test_force_refresh_rereads_immediately(main, monkeypatch):
    sm = FakeSecrets([SECRET_V1, SECRET_V2])
    monkeypatch.setattr(main, "secrets_manager_client", sm)
    main.get_secret("user-secret")
    assert main.get_secret("user-secret", force_refresh=True)["password"] == "new-pass"


# ── Connection retry on rotated password ────────────────────────────────────

def _fake_connect(accepted_password, attempts, error=None):
    def connect(**kw):
        attempts.append(kw["password"])
        if error is not None:
            raise error
        if kw["password"] != accepted_password:
            raise FakeOperationalError('password authentication failed for user "app_rw"', sqlstate="28P01")
        assert kw["sslmode"] == "require"
        return types.SimpleNamespace(closed=False)
    return connect


def test_open_connection_refreshes_secret_once_after_rotation(main, monkeypatch):
    monkeypatch.setattr(main, "secrets_manager_client", FakeSecrets([SECRET_V1, SECRET_V2]))
    attempts = []
    monkeypatch.setattr(main.psycopg, "connect", _fake_connect("new-pass", attempts))
    assert main._open_connection() is not None
    assert attempts == ["old-pass", "new-pass"]


def test_open_connection_gives_up_after_one_retry(main, monkeypatch):
    monkeypatch.setattr(main, "secrets_manager_client", FakeSecrets([SECRET_V1, SECRET_V1]))
    attempts = []
    monkeypatch.setattr(main.psycopg, "connect", _fake_connect("never", attempts))
    with pytest.raises(FakeOperationalError):
        main._open_connection()
    assert len(attempts) == 2


def test_open_connection_does_not_retry_non_auth_errors(main, monkeypatch):
    sm = FakeSecrets([SECRET_V1, SECRET_V2])
    monkeypatch.setattr(main, "secrets_manager_client", sm)
    attempts = []
    error = FakeOperationalError("connection timeout expired")
    monkeypatch.setattr(main.psycopg, "connect", _fake_connect("old-pass", attempts, error=error))
    with pytest.raises(FakeOperationalError):
        main._open_connection()
    assert attempts == ["old-pass"]
    assert sm.calls == 1


@pytest.mark.parametrize(
    "error,expected",
    [
        (FakeOperationalError("x", sqlstate="28P01"), True),
        (FakeOperationalError("x", sqlstate="28000"), True),
        (FakeOperationalError("The password that was provided for the role app_rw is wrong."), True),
        (FakeOperationalError("connection refused"), False),
        (FakeOperationalError("x", sqlstate="57P01"), False),
    ],
)
def test_is_auth_error(main, error, expected):
    assert main._is_auth_error(error) is expected


def test_retriever_retries_with_refreshed_secret(main, monkeypatch):
    monkeypatch.setattr(main, "secrets_manager_client", FakeSecrets([SECRET_V1, SECRET_V2]))
    seen = []

    def retriever(llm, vectorstore_config_dict, embeddings):
        seen.append(vectorstore_config_dict["password"])
        if vectorstore_config_dict["password"] != "new-pass":
            raise TypeError("cannot unpack non-iterable NoneType object")  # get_vectorstore returned None
        return "retriever"

    monkeypatch.setattr(main._vectorstore_stub, "get_vectorstore_retriever", retriever)
    assert main._get_history_aware_retriever("llm", "persona-1") == "retriever"
    assert seen == ["old-pass", "new-pass"]


# ── Logging and token handling ──────────────────────────────────────────────

def _event(headers):
    # Missing ids → the handler returns 400 right after the token handling.
    return {"headers": headers, "queryStringParameters": {}, "requestContext": {"authorizer": {}}}


@pytest.mark.parametrize("header_value", [JWT, f"Bearer {JWT}"])
def test_handler_never_logs_the_token_or_raw_event(main, monkeypatch, caplog, header_value):
    monkeypatch.setattr(main, "initialize_constants", lambda: None)
    caplog.set_level(logging.DEBUG)
    resp = main.handler(_event({"Authorization": header_value, "origin": "x"}), None)
    assert resp["statusCode"] == 400
    logged = "\n".join(r.getMessage() for r in caplog.records)
    for fragment in (JWT[:12], JWT[-12:], "eyJ"):
        assert fragment not in logged
    assert "FULL EVENT" not in logged
    assert main._chat_stub.get_cognito_token() == f"Bearer {JWT}"


def test_handler_clears_token_from_previous_invocation(main, monkeypatch):
    monkeypatch.setattr(main, "initialize_constants", lambda: None)
    main._chat_stub.get_cognito_token.current_token = "Bearer someone-elses-token"
    main.handler(_event({}), None)
    assert main._chat_stub.get_cognito_token() is None


def test_handler_tolerates_missing_headers(main, monkeypatch):
    monkeypatch.setattr(main, "initialize_constants", lambda: None)
    resp = main.handler({"queryStringParameters": {}, "requestContext": {}}, None)
    assert resp["statusCode"] == 400


def test_pgvector_does_not_issue_create_extension():
    """app_rw has no DDL rights; the extension comes from the db_setup baseline migration."""
    with open(os.path.join(_SRC, "helpers", "helper.py"), encoding="utf-8") as fh:
        assert "create_extension=False" in fh.read()
