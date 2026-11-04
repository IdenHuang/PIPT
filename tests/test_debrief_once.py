"""
One debrief per chat 

generate_debrief must not re-run the grader when a debrief row already exists
for the chat: a repeat call would re-read the instructor answer key, re-publish
the debrief stream frames and duplicate question_interactions rows. The
existence check fails closed on DB errors.
"""
import pytest

import chat

SESSION = "55555555-5555-4555-8555-555555555555"


class _FakeCursor:
    def __init__(self, row):
        self._row = row
        self.executed = []

    def execute(self, sql, params):
        self.executed.append((sql, params))

    def fetchone(self):
        return self._row

    def close(self):
        pass


class _FakeConn:
    def __init__(self, row):
        self.cursor_obj = _FakeCursor(row)
        self.closed = False

    def cursor(self):
        return self.cursor_obj

    def close(self):
        self.closed = True


def test_debrief_exists_true_when_row_present(monkeypatch):
    conn = _FakeConn((1,))
    monkeypatch.setattr(chat, "_get_db_connection", lambda: conn)
    assert chat.debrief_exists(SESSION) is True
    sql, params = conn.cursor_obj.executed[0]
    assert '"debriefs"' in sql and SESSION not in sql
    assert params == (SESSION,)
    assert conn.closed


def test_debrief_exists_false_when_no_row(monkeypatch):
    monkeypatch.setattr(chat, "_get_db_connection", lambda: _FakeConn(None))
    assert chat.debrief_exists(SESSION) is False


def test_debrief_exists_fails_closed_on_db_error(monkeypatch):
    def boom():
        raise RuntimeError("db down")

    monkeypatch.setattr(chat, "_get_db_connection", boom)
    assert chat.debrief_exists(SESSION) is True


def test_generate_debrief_skips_all_work_when_debrief_exists(monkeypatch):
    monkeypatch.setattr(chat, "debrief_exists", lambda session_id: True)

    def must_not_run(*args, **kwargs):
        raise AssertionError("grader ran on a chat that already has a debrief")

    for name in (
        "fetch_org_thresholds",
        "flush_matching_threads",
        "fetch_chat_transcript",
        "retrieve_answer_key_text",
        "publish_to_appsync",
        "save_debrief_to_db",
        "save_question_interactions",
    ):
        monkeypatch.setattr(chat, name, must_not_run)

    result = chat.generate_debrief(
        session_id=SESSION,
        simulation_group_id="group",
        persona_id="persona",
        llm=None,
    )
    assert result == {"status": "already_generated"}
    assert "questions_missed" not in result
    assert "answer_key_comparison" not in result


def test_generate_debrief_proceeds_when_no_debrief(monkeypatch):
    monkeypatch.setattr(chat, "debrief_exists", lambda session_id: False)

    class _Reached(Exception):
        pass

    def reached(*args, **kwargs):
        raise _Reached()

    monkeypatch.setattr(chat, "fetch_org_thresholds", reached)
    with pytest.raises(_Reached):
        chat.generate_debrief(
            session_id=SESSION,
            simulation_group_id="group",
            persona_id="persona",
            llm=None,
        )
