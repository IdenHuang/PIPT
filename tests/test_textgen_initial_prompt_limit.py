"""
Text-generation Lambda: an empty message_content (the AI patient's opening
turn) is allowed once per chat and never skips max_messages_per_chat.

Security finding f-7a056453: replaying {"message_content": ""} bypassed the
per-chat cap and generated a new LLM turn on every call.
"""
import json
import types

import pytest
from botocore.exceptions import ClientError

from test_textgen_credentials_and_logging import main  # noqa: F401  (fixture)

# A real UUID: the handler canonicalizes session_id after authz (f-5e543e74).
SESSION = "33333333-3333-4333-8333-333333333333"


class FakeTable:
    """Conversation table stub implementing the INIT# conditional put."""

    def __init__(self):
        self.items = {}

    def put_item(self, Item, ConditionExpression, ExpressionAttributeValues):
        existing = self.items.get(Item["SessionId"])
        retakeable = existing is None or (
            existing.get("claim_status") == ExpressionAttributeValues[":failed"]
            or existing["claimed_at"] < ExpressionAttributeValues[":stale"]
        )
        if not retakeable:
            raise ClientError({"Error": {"Code": "ConditionalCheckFailedException"}}, "PutItem")
        self.items[Item["SessionId"]] = dict(Item)

    def update_item(self, Key, UpdateExpression, ExpressionAttributeValues):
        self.items[Key["SessionId"]]["claim_status"] = ExpressionAttributeValues[":failed"]


class FakeDb:
    """Answers the cap lookup and the student/ai message counts."""

    def __init__(self, max_messages=None, student=0, ai=0):
        self.max_messages, self.student, self.ai = max_messages, student, ai

    def cursor(self):
        db, state = self, {}

        def execute(sql, params):
            state["sql"] = sql

        def fetchone():
            if "max_messages_per_chat" in state["sql"]:
                return (db.max_messages,)
            if "EXISTS" in state["sql"]:
                return (db.ai > 0,)
            return (db.student, db.ai)

        return types.SimpleNamespace(execute=execute, fetchone=fetchone, close=lambda: None)


@pytest.fixture
def chat(main, monkeypatch):  # noqa: F811
    """Handler wired for chat mode; records generations and key-question caching."""
    # fail: get_response raises. swallow: it returns 200 but saves no AI turn,
    # like chat.py does when Bedrock or the message insert fails.
    calls = {"generate": 0, "cache": 0, "fail": False, "swallow": False}
    db, table = FakeDb(), FakeTable()

    def get_response(**kw):
        if calls["fail"]:
            raise RuntimeError("bedrock down")
        if calls["swallow"]:
            return {"llm_output": "I'm sorry, I cannot provide a response to that query."}
        calls["generate"] += 1
        db.ai += 1  # chat.py persists the AI turn
        if not kw["is_initial_prompt"]:
            db.student += 1
        return {"llm_output": "hi"}

    def cache_key_questions(**kw):
        calls["cache"] += 1

    stub = main._chat_stub
    stub.get_response = get_response
    stub.cache_key_questions = cache_key_questions
    stub.fetch_org_thresholds = lambda gid: {"key_question_threshold": 0.5}

    for name, value in {
        "initialize_constants": lambda: None,
        "_authorize": lambda *a: types.SimpleNamespace(allowed=True),
        "get_system_prompt": lambda gid: "system",
        "get_persona_details": lambda pid: ("Pat", 40, "prompt", "completion"),
        "get_initial_student_query": lambda name: "start",
        "get_student_query": lambda q: q,
        "get_bedrock_llm": lambda **kw: object(),
        "_get_history_aware_retriever": lambda llm, pid: object(),
        "get_stream_callback_url": lambda: None,
        "connect_to_db": lambda: db,
        "_conversation_table": lambda: table,
    }.items():
        monkeypatch.setattr(main, name, value)

    def send(message="", stream="false"):
        event = {
            "headers": {},
            "queryStringParameters": {
                # Real UUIDs: the handler canonicalizes these after authz.
                "simulation_group_id": "11111111-1111-4111-8111-111111111111",
                "session_id": SESSION,
                "patient_id": "22222222-2222-4222-8222-222222222222",
                "stream": stream,
            },
            "requestContext": {"authorizer": {"userId": "u1", "email": "s@example.com"}},
            "body": json.dumps({"message_content": message}),
        }
        return main.handler(event, None)

    return types.SimpleNamespace(send=send, calls=calls, db=db, table=table)


@pytest.mark.parametrize("stream", ["false", "true"])
def test_initial_prompt_runs_once_then_replays_are_rejected(chat, stream):
    assert chat.send(stream=stream)["statusCode"] == 200
    for _ in range(3):
        resp = chat.send(stream=stream)
        assert resp["statusCode"] == 409
    assert chat.calls["generate"] == 1
    assert chat.calls["cache"] == 1


def test_concurrent_initial_prompt_loses_the_claim(chat, main):  # noqa: F811
    # Another request holds a fresh claim but has not written its AI turn yet.
    chat.table.items[f"INIT#{SESSION}"] = {
        "SessionId": f"INIT#{SESSION}", "claim_status": "claimed", "claimed_at": int(main.time.time()),
    }
    assert chat.send()["statusCode"] == 409
    assert chat.calls["generate"] == 0
    assert chat.calls["cache"] == 0


@pytest.mark.parametrize("message", ["", "What brings you in?"])
def test_chat_at_cap_rejects_empty_and_real_messages(chat, message):
    chat.db.max_messages, chat.db.student = 2, 2
    resp = chat.send(message)
    assert resp["statusCode"] == 403
    assert json.loads(resp["body"])["error"] == "Message limit reached"
    assert chat.calls["generate"] == 0


def test_failed_generation_releases_the_claim_for_retry(chat):
    chat.calls["fail"] = True
    assert chat.send()["statusCode"] == 500
    chat.calls["fail"] = False
    assert chat.send()["statusCode"] == 200
    assert chat.calls["generate"] == 1


def test_swallowed_failure_with_no_ai_turn_releases_the_claim(chat):
    chat.calls["swallow"] = True
    assert chat.send()["statusCode"] == 200  # get_response hides the error
    chat.calls["swallow"] = False
    assert chat.send()["statusCode"] == 200
    assert chat.calls["generate"] == 1


def test_stale_claim_can_be_retaken(chat, main):  # noqa: F811
    # A claim left behind by a request that died mid-generation.
    key = f"INIT#{SESSION}"
    chat.table.items[key] = {
        "SessionId": key, "claim_status": "claimed",
        "claimed_at": int(main.time.time()) - main.INITIAL_PROMPT_CLAIM_STALE_SECONDS - 1,
    }
    assert chat.send()["statusCode"] == 200
    assert chat.calls["generate"] == 1
