"""
DELETE /student/delete_last_message must refuse concluded chats
(security finding f-ce3bad91).

cdk/lambda/deleteLastMessage/deleteLastMessage.py is loaded with its
Lambda-layer imports stubbed; the DB and DynamoDB calls are replaced by
in-memory fakes and the handler is invoked end to end.
"""
import importlib.util
import json
import os
import sys
import types

import pytest

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_MODULE_PATH = os.path.join(_REPO_ROOT, "cdk", "lambda", "deleteLastMessage", "deleteLastMessage.py")

CHAT = "55555555-5555-4555-8555-555555555555"
STUDENT = "student@example.edu"
ADMIN = "admin@example.edu"


class FakeCursor:
    def __init__(self, db):
        self.db = db
        self._rows = []

    def execute(self, sql, params):
        for value in params:
            assert str(value) not in sql, "caller value interpolated into SQL"
        sql = " ".join(sql.split())
        if self.db.fail_status and "SELECT status FROM chats" in sql:
            raise RuntimeError("db down")
        if 'SELECT roles FROM "users"' in sql:
            self._rows = [(["admin"],)] if params[0] == ADMIN else [(["student"],)]
        elif "SELECT c.chat_id FROM chats c" in sql:
            self._rows = [(CHAT,)] if params == (CHAT, STUDENT) and self.db.status else []
        elif "SELECT status FROM chats" in sql:
            self._rows = [(self.db.status,)] if params[0] == CHAT and self.db.status else []
        elif 'SELECT message_id FROM "messages"' in sql:
            self._rows = [(m,) for m in self.db.messages[-2:][::-1]]
        elif 'DELETE FROM "messages"' in sql:
            self.db.deleted.extend(params[0])
            self.db.messages = [m for m in self.db.messages if m not in params[0]]
        else:
            raise AssertionError(f"unexpected query: {sql}")

    def fetchone(self):
        return self._rows[0] if self._rows else None

    def fetchall(self):
        return self._rows

    def close(self):
        pass


class FakeDb:
    def __init__(self, status):
        self.status = status
        self.fail_status = False
        self.messages = ["m1", "m2", "m3", "m4"]
        self.deleted = []
        self.closed = False

    def cursor(self):
        return FakeCursor(self)

    def commit(self):
        pass

    def rollback(self):
        pass


class FakeDynamo:
    def __init__(self):
        self.history = [{"M": {}} for _ in range(4)]
        self.updates = 0

    def get_item(self, **_kw):
        return {"Item": {"History": {"L": list(self.history)}}}

    def update_item(self, **kw):
        self.updates += 1
        self.history = kw["ExpressionAttributeValues"][":history"]["L"]


def _load(monkeypatch):
    cors = types.ModuleType("cors_helper")
    cors.get_cors_headers = lambda event: {}
    psycopg2 = types.ModuleType("psycopg2")
    psycopg2.connect = lambda *_a, **_kw: None
    boto3 = types.ModuleType("boto3")
    boto3.client = lambda *_a, **_kw: types.SimpleNamespace()
    for name, mod in {"cors_helper": cors, "psycopg2": psycopg2, "boto3": boto3}.items():
        monkeypatch.setitem(sys.modules, name, mod)
    for key, value in {
        "SM_DB_CREDENTIALS": "secret",
        "RDS_PROXY_ENDPOINT": "proxy",
        "TABLE_NAME_PARAM": "param",
    }.items():
        monkeypatch.setenv(key, value)
    spec = importlib.util.spec_from_file_location("_under_test_deleteLastMessage", _MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def make_handler(monkeypatch):
    def factory(status):
        mod = _load(monkeypatch)
        db = FakeDb(status)
        dynamo = FakeDynamo()
        monkeypatch.setattr(mod, "connect_to_db", lambda: db)
        monkeypatch.setattr(mod, "get_parameter", lambda _name: "table")
        monkeypatch.setattr(mod, "dynamodb_client", dynamo)
        return mod, db, dynamo

    return factory


def _event(email, session_id=CHAT):
    return {
        "requestContext": {"authorizer": {"email": email}},
        "queryStringParameters": {"session_id": session_id},
    }


@pytest.mark.parametrize("email", [STUDENT, ADMIN])
def test_concluded_chat_is_refused_without_mutation(make_handler, email):
    mod, db, dynamo = make_handler("concluded")
    resp = mod.lambda_handler(_event(email), None)
    assert resp["statusCode"] == 409
    assert json.loads(resp["body"]) == "Session already concluded."
    assert dynamo.updates == 0
    assert db.deleted == []


def test_active_chat_still_deletes_last_two(make_handler):
    mod, db, dynamo = make_handler("active")
    resp = mod.lambda_handler(_event(STUDENT), None)
    assert resp["statusCode"] == 200
    assert dynamo.updates == 1
    assert len(dynamo.history) == 2
    assert sorted(db.deleted) == ["m3", "m4"]


def test_status_lookup_error_fails_closed(make_handler):
    mod, db, dynamo = make_handler("active")
    db.fail_status = True
    resp = mod.lambda_handler(_event(STUDENT), None)
    assert resp["statusCode"] == 500
    assert dynamo.updates == 0
    assert db.deleted == []


def test_admin_on_unknown_chat_gets_404(make_handler):
    mod, db, dynamo = make_handler("active")
    resp = mod.lambda_handler(_event(ADMIN, session_id="missing"), None)
    assert resp["statusCode"] == 404
    assert dynamo.updates == 0
