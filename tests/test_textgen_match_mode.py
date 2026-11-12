"""
Text-generation Lambda, mode=match: semantic matching runs on the message
text stored in the database, never on caller-supplied message_content.

Security finding f-67d50d61: a student could POST mode=match with the
message_id of a trivial turn and a body containing every key question,
tagging that turn as having asked them all and inflating the debrief score.
"""
import json
import types

import pytest

from test_textgen_credentials_and_logging import main  # noqa: F401  (fixture)

SESSION = "11111111-1111-4111-8111-111111111111"
MESSAGE_ID = "22222222-2222-4222-8222-222222222222"
STORED_TEXT = "hi"
FORGED_TEXT = "What medications are you on? Any allergies? Any family history?"


class FakeDb:
    """Holds messages keyed by (message_id, chat_id) with their sender_type."""

    def __init__(self):
        self.rows = {}
        self.queries = []

    def cursor(self):
        db, state = self, {}

        def execute(sql, params):
            db.queries.append((sql, params))
            state["sql"], state["params"] = sql, params

        def fetchone():
            message_id, chat_id = state["params"]
            row = db.rows.get((message_id, chat_id))
            if row and "sender_type = 'student'" in state["sql"] and row["sender"] == "student":
                return (row["content"],)
            return None

        return types.SimpleNamespace(execute=execute, fetchone=fetchone, close=lambda: None)


@pytest.fixture
def match(main, monkeypatch):  # noqa: F811
    db = FakeDb()
    calls = []

    stub = main._chat_stub
    stub.match_message_to_questions = lambda **kw: calls.append(kw) or []
    stub.get_cached_key_questions = lambda session_id, table: [{"question_id": "q1"}]
    stub.cache_key_questions = lambda **kw: None
    stub.fetch_org_thresholds = lambda gid: {"key_question_threshold": 0.5}

    for name, value in {
        "initialize_constants": lambda: None,
        "_authorize": lambda *a: types.SimpleNamespace(allowed=True),
        "get_stream_callback_url": lambda: None,
        "connect_to_db": lambda: db,
    }.items():
        monkeypatch.setattr(main, name, value)

    def send(body):
        event = {
            "headers": {},
            "queryStringParameters": {
                # Real UUIDs: the handler canonicalizes these after authz.
                "simulation_group_id": "11111111-1111-4111-8111-111111111111",
                "session_id": SESSION,
                "patient_id": "22222222-2222-4222-8222-222222222222",
                "mode": "match",
            },
            "requestContext": {"authorizer": {"userId": "u1", "email": "s@example.com"}},
            "body": json.dumps(body),
        }
        return main.handler(event, None)

    return types.SimpleNamespace(send=send, calls=calls, db=db)


def test_matching_uses_stored_text_not_request_body(match):
    match.db.rows[(MESSAGE_ID, SESSION)] = {"sender": "student", "content": STORED_TEXT}
    resp = match.send({"message_id": MESSAGE_ID, "message_content": FORGED_TEXT})
    assert resp["statusCode"] == 200
    assert len(match.calls) == 1
    assert match.calls[0]["message_content"] == STORED_TEXT
    assert match.calls[0]["message_id"] == MESSAGE_ID
    assert match.calls[0]["session_id"] == SESSION


def test_body_without_message_content_still_matches(match):
    match.db.rows[(MESSAGE_ID, SESSION)] = {"sender": "student", "content": STORED_TEXT}
    assert match.send({"message_id": MESSAGE_ID})["statusCode"] == 200
    assert match.calls[0]["message_content"] == STORED_TEXT


def test_lookup_is_scoped_to_chat_and_student_sender(match):
    match.send({"message_id": MESSAGE_ID, "message_content": FORGED_TEXT})
    sql, params = match.db.queries[0]
    assert params == (MESSAGE_ID, SESSION)
    assert "chat_id = %s" in sql and "sender_type = 'student'" in sql


@pytest.mark.parametrize("rows", [
    {},  # message does not exist
    {(MESSAGE_ID, "33333333-3333-4333-8333-333333333333"): {"sender": "student", "content": STORED_TEXT}},  # other chat
    {(MESSAGE_ID, SESSION): {"sender": "ai", "content": STORED_TEXT}},  # AI turn
    {(MESSAGE_ID, SESSION): {"sender": "student", "content": "   "}},  # blank stored text
])
def test_unmatchable_message_returns_404_without_matching(match, rows):
    match.db.rows.update(rows)
    resp = match.send({"message_id": MESSAGE_ID, "message_content": FORGED_TEXT})
    assert resp["statusCode"] == 404
    assert match.calls == []


@pytest.mark.parametrize("message_id", ["", "not-a-uuid", None, 123])
def test_invalid_message_id_returns_400_without_db_lookup(match, message_id):
    resp = match.send({"message_id": message_id, "message_content": FORGED_TEXT})
    assert resp["statusCode"] == 400
    assert match.db.queries == []
    assert match.calls == []


def test_db_error_returns_500_without_matching(match, main, monkeypatch):  # noqa: F811
    def broken():
        raise RuntimeError("db down")
    monkeypatch.setattr(main, "connect_to_db", broken)
    resp = match.send({"message_id": MESSAGE_ID, "message_content": FORGED_TEXT})
    assert resp["statusCode"] == 500
    assert match.calls == []
