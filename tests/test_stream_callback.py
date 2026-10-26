"""
Stream callback publishing (cdk/text_generation/src/helpers/chat.py):
  - every /stream-callback POST carries the shared token and the per-request
    X-Stream-Nonce minted by the socket server
  - without a URL the socket path is disabled; without a nonce the header is
    omitted and the socket server decides
"""
import sys
import types

import pytest

import chat

NONCE = "b" * 64
URL = "http://internal-nlb.example"


@pytest.fixture
def posts(monkeypatch):
    calls = []
    fake_requests = types.ModuleType("requests")
    fake_requests.post = lambda url, **kw: calls.append((url, kw))
    monkeypatch.setitem(sys.modules, "requests", fake_requests)
    monkeypatch.setattr(chat, "_stream_callback_token", "shared-token")
    monkeypatch.setenv("APPSYNC_GRAPHQL_URL", "")
    yield calls
    chat.set_stream_callback_url(None)


def test_callback_carries_token_and_nonce(posts):
    chat.set_stream_callback_url(URL, NONCE)
    chat.publish_to_appsync("session-1", {"type": "chunk", "content": "hi"})
    assert len(posts) == 1
    url, kw = posts[0]
    assert url == f"{URL}/stream-callback"
    assert kw["headers"] == {"x-callback-token": "shared-token", "x-stream-nonce": NONCE}
    assert kw["json"] == {"session_id": "session-1", "data": {"type": "chunk", "content": "hi"}}


@pytest.mark.parametrize("nonce", [None, ""])
def test_callback_without_nonce_omits_the_header(posts, nonce):
    # Lets a Lambda deployed ahead of the socket server keep streaming; the
    # updated socket server rejects these with 403.
    chat.set_stream_callback_url(URL, nonce)
    chat.publish_to_appsync("session-1", {"type": "chunk"})
    assert len(posts) == 1
    assert posts[0][1]["headers"] == {"x-callback-token": "shared-token"}


@pytest.mark.parametrize("nonce", [None, NONCE])
def test_socket_path_disabled_without_url(posts, nonce):
    chat.set_stream_callback_url(None, nonce)
    assert chat._stream_callback_url is None
    assert chat._stream_callback_nonce is None
    chat.publish_to_appsync("session-1", {"type": "chunk"})
    assert posts == []


def test_reset_clears_previous_invocation_state(posts):
    chat.set_stream_callback_url(URL, NONCE)
    chat.set_stream_callback_url(None)
    assert chat._stream_callback_url is None
    assert chat._stream_callback_nonce is None
