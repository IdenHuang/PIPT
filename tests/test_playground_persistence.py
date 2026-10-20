"""
Prompt Playground turns must not be written to the PostgreSQL "messages" table.

Playground session IDs are "test-..." scratch keys (see helpers/authz.py), not
chats.chat_id UUIDs, so main.py's test_system_prompt branch calls get_response
with persist_messages=False. These tests pin that contract and the matching
OpenAPI declaration.
"""
import os
import re
import types

import pytest

import chat

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_MAIN_PY = os.path.join(_REPO_ROOT, "cdk", "text_generation", "src", "main.py")
_OPENAPI = os.path.join(_REPO_ROOT, "cdk", "OpenAPI_Swagger_Definition.yaml")


class _Recorder:
    def __init__(self, return_value=None):
        self.calls = []
        self.return_value = return_value

    def __call__(self, *args, **kwargs):
        self.calls.append((args, kwargs))
        return self.return_value


class _FakeChain:
    """Stands in for RunnableWithMessageHistory in the streaming path."""

    def stream(self, *_args, **_kwargs):
        yield {"answer": "streamed reply"}


@pytest.fixture
def stubbed_chat(monkeypatch):
    """Replace LangChain, guardrail, DB and AppSync calls with recorders."""
    saves = _Recorder(return_value="msg-id")
    matching = _Recorder()
    monkeypatch.setattr(chat, "save_message_to_db", saves)
    monkeypatch.setattr(chat, "run_matching_async", matching)
    monkeypatch.setattr(chat, "flush_matching_threads", lambda *a, **kw: None)
    monkeypatch.setattr(chat, "apply_text_guardrail", lambda text, source: (True, ""))
    monkeypatch.setattr(chat, "publish_to_appsync", lambda *a, **kw: None)
    monkeypatch.setattr(chat, "generate_response", lambda chain, query, session_id: "patient reply")
    monkeypatch.setattr(chat, "ChatPromptTemplate", types.SimpleNamespace(from_messages=lambda msgs: "prompt"))
    monkeypatch.setattr(chat, "MessagesPlaceholder", lambda name: name)
    monkeypatch.setattr(chat, "create_stuff_documents_chain", lambda llm, prompt: "qa_chain")
    monkeypatch.setattr(chat, "create_retrieval_chain", lambda retriever, qa: "rag_chain")
    monkeypatch.setattr(chat, "RunnableWithMessageHistory", lambda *a, **kw: _FakeChain())
    return types.SimpleNamespace(saves=saves, matching=matching)


def _call_get_response(**overrides):
    kwargs = dict(
        query="Where does it hurt?",
        patient_name="Alex",
        llm=types.SimpleNamespace(model_id="model"),
        history_aware_retriever="retriever",
        table_name="table",
        session_id="test-abc123",
        system_prompt="You are a patient.",
        patient_age="40",
        patient_prompt="Chest pain.",
        llm_completion=True,
        stream=False,
        student_user_id="user-1",
        persona_id="persona-1",
        embeddings_model=object(),
        ddb_table_name="table",
        raw_prompt_mode=True,
    )
    kwargs.update(overrides)
    return chat.get_response(**kwargs)


def test_playground_turn_skips_message_writes(stubbed_chat):
    result = _call_get_response(persist_messages=False)

    assert result["llm_output"].startswith("patient reply")
    assert stubbed_chat.saves.calls == []
    assert stubbed_chat.matching.calls == []


def test_default_chat_turn_still_saves_student_and_ai_messages(stubbed_chat):
    _call_get_response(session_id="11111111-1111-1111-1111-111111111111", raw_prompt_mode=False)

    sender_types = [args[2] for args, _ in stubbed_chat.saves.calls]
    assert sender_types == ["student", "ai"]
    assert len(stubbed_chat.matching.calls) == 1


def test_streaming_path_honours_persist_messages(stubbed_chat):
    reply = chat.generate_streaming_response(
        _FakeChain(), "Hello", "test-abc123", "Alex", "40", "Chest pain.",
        persist_messages=False,
    )

    assert reply == "streamed reply"
    assert stubbed_chat.saves.calls == []
    assert stubbed_chat.matching.calls == []


def _playground_branch_source():
    with open(_MAIN_PY, encoding="utf-8") as fh:
        source = fh.read()
    # The handler branch (not the earlier history-key rebinding) starts with a
    # logger.info call. \s* tolerates the CRLF line endings used in src files.
    start = re.search(r'if mode == "test_system_prompt":\s*logger\.info', source).start()
    end = source.index("DEFAULT CHAT MODE", start)
    return source[start:end]


def test_main_playground_branch_disables_persistence():
    branch = _playground_branch_source()
    assert re.search(r"get_response\(.*?persist_messages\s*=\s*False", branch, re.DOTALL)


def test_openapi_declares_playground_mode_and_body_fields():
    with open(_OPENAPI, encoding="utf-8") as fh:
        spec = fh.read()
    assert re.search(
        r'enum:\s*\["chat",\s*"debrief",\s*"match",\s*"test_debrief",\s*"test_system_prompt"\]', spec
    )
    for field in ("system_prompt", "patient_prompt"):
        assert re.search(rf"^\s+{field}:\s*$", spec, re.MULTILINE), field
