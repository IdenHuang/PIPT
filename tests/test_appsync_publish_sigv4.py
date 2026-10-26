"""
AppSync publishing (cdk/text_generation/src/helpers/chat.py):
  - publishTextStream is @aws_iam only (cdk/lib/schema.graphql), so the
    fallback AppSync path must SigV4-sign with the Lambda role and must never
    send a user's Cognito token
  - the signed body is exactly the body that is sent
"""
import json
import sys
import types

import pytest

import chat

APPSYNC_URL = "https://abc123.appsync-api.us-east-1.amazonaws.com/graphql"


class FakeResponse:
    def __init__(self, status_code=200, body=None):
        self.status_code = status_code
        self._body = body if body is not None else {"data": {"publishTextStream": None}}

    def json(self):
        return self._body


class _Calls(list):
    """Recorded POSTs, plus a slot for the response the fake returns."""


@pytest.fixture
def appsync_posts(monkeypatch):
    calls = _Calls()
    response = {"value": FakeResponse()}

    fake_requests = types.ModuleType("requests")

    def post(url, **kw):
        calls.append((url, kw))
        return response["value"]

    fake_requests.post = post
    monkeypatch.setitem(sys.modules, "requests", fake_requests)
    monkeypatch.setenv("APPSYNC_GRAPHQL_URL", APPSYNC_URL)
    monkeypatch.setenv("AWS_REGION", "us-east-1")
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "AKIDEXAMPLE")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY")
    monkeypatch.setenv("AWS_SESSION_TOKEN", "session-token-example")
    chat.set_stream_callback_url(None)
    calls.response = response
    yield calls
    chat.set_stream_callback_url(None)


def test_publish_is_sigv4_signed_for_appsync(appsync_posts):
    chat.publish_to_appsync("11111111-1111-4111-8111-111111111111", {"type": "debrief", "content": "{}"})

    assert len(appsync_posts) == 1
    url, kw = appsync_posts[0]
    assert url == APPSYNC_URL
    headers = kw["headers"]
    auth = headers["Authorization"]
    assert auth.startswith("AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/")
    assert "/us-east-1/appsync/aws4_request" in auth
    assert headers["X-Amz-Security-Token"] == "session-token-example"
    assert "X-Amz-Date" in headers
    assert not auth.startswith("Bearer")
    assert kw["timeout"]


def test_signed_body_is_the_sent_body(appsync_posts):
    chat.publish_to_appsync("11111111-1111-4111-8111-111111111111", {"type": "chunk", "content": "hi"})
    _, kw = appsync_posts[0]
    payload = json.loads(kw["data"])
    assert "publishTextStream" in payload["query"]
    assert payload["variables"]["sessionId"] == "11111111-1111-4111-8111-111111111111"
    assert json.loads(payload["variables"]["data"]) == {"type": "chunk", "content": "hi"}


def test_graphql_errors_are_logged(appsync_posts, caplog):
    appsync_posts.response["value"] = FakeResponse(
        200, {"errors": [{"errorType": "Unauthorized", "message": "Not Authorized"}]}
    )
    chat.publish_to_appsync("11111111-1111-4111-8111-111111111111", {"type": "chunk"})
    assert "Unauthorized" in caplog.text


def test_no_cognito_token_plumbing_remains():
    assert not hasattr(chat, "get_cognito_token")


def test_socket_callback_path_is_unchanged(monkeypatch):
    callback_calls = []
    fake_session = types.SimpleNamespace(post=lambda url, **kw: callback_calls.append(url))
    monkeypatch.setattr(chat, "_get_callback_session", lambda: fake_session)
    monkeypatch.setitem(sys.modules, "requests", sys.modules.get("requests") or types.ModuleType("requests"))
    chat.set_stream_callback_url("http://internal-nlb.example", "c" * 64)
    try:
        chat.publish_to_appsync("session-1", {"type": "chunk"})
    finally:
        chat.set_stream_callback_url(None)
    assert callback_calls == ["http://internal-nlb.example/stream-callback"]
