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
        self.autocommit = False

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


GRADER_STEPS = (
    "fetch_org_thresholds",
    "flush_matching_threads",
    "fetch_chat_transcript",
    "retrieve_answer_key_text",
    "publish_to_appsync",
    "save_debrief_to_db",
    "save_question_interactions",
)


def _forbid_grader(monkeypatch):
    def must_not_run(*args, **kwargs):
        raise AssertionError("grader ran when it should have been skipped")

    for name in GRADER_STEPS:
        monkeypatch.setattr(chat, name, must_not_run)


def _run():
    return chat.generate_debrief(
        session_id=SESSION,
        simulation_group_id="group",
        persona_id="persona",
        llm=None,
    )


class _LockConn:
    def __init__(self):
        self.closed = False

    def close(self):
        self.closed = True


def _hold_lock(monkeypatch):
    conn = _LockConn()
    monkeypatch.setattr(chat, "_acquire_debrief_lock", lambda session_id: conn)
    return conn


def _assert_skipped(result):
    assert result == {"status": "already_generated"}
    assert "questions_missed" not in result
    assert "answer_key_comparison" not in result


def test_generate_debrief_skips_all_work_when_debrief_exists(monkeypatch):
    lock = _hold_lock(monkeypatch)
    monkeypatch.setattr(chat, "debrief_exists", lambda session_id: True)
    _forbid_grader(monkeypatch)
    _assert_skipped(_run())
    assert lock.closed


def test_generate_debrief_proceeds_when_no_debrief(monkeypatch):
    lock = _hold_lock(monkeypatch)
    monkeypatch.setattr(chat, "debrief_exists", lambda session_id: False)

    class _Reached(Exception):
        pass

    def reached(*args, **kwargs):
        raise _Reached()

    monkeypatch.setattr(chat, "fetch_org_thresholds", reached)
    with pytest.raises(_Reached):
        _run()
    # The lock is released even when the grader raises.
    assert lock.closed


def test_generate_debrief_skips_when_another_run_holds_the_lock(monkeypatch):
    """Concurrent requests: only the lock holder grades (finding f-197f7ee1)."""
    monkeypatch.setattr(chat, "_acquire_debrief_lock", lambda session_id: None)

    def must_not_check(session_id):
        raise AssertionError("existence check ran without the lock")

    monkeypatch.setattr(chat, "debrief_exists", must_not_check)
    _forbid_grader(monkeypatch)
    _assert_skipped(_run())


def test_generate_debrief_fails_closed_when_lock_errors(monkeypatch):
    def boom(session_id):
        raise RuntimeError("db down")

    monkeypatch.setattr(chat, "_acquire_debrief_lock", boom)
    _forbid_grader(monkeypatch)
    _assert_skipped(_run())


def test_generate_debrief_discards_run_when_debrief_already_saved(monkeypatch):
    lock = _hold_lock(monkeypatch)
    monkeypatch.setattr(chat, "debrief_exists", lambda session_id: False)

    def lost_race(**kwargs):
        raise chat.DebriefAlreadySaved(SESSION)

    monkeypatch.setattr(chat, "_run_debrief_grader", lost_race)
    _assert_skipped(_run())
    assert lock.closed


def test_acquire_debrief_lock_uses_try_lock_without_transaction(monkeypatch):
    conn = _FakeConn((True,))
    monkeypatch.setattr(chat, "_get_db_connection", lambda: conn)
    assert chat._acquire_debrief_lock(SESSION) is conn
    assert conn.autocommit is True
    sql, params = conn.cursor_obj.executed[0]
    assert "pg_try_advisory_lock" in sql and SESSION not in sql
    assert params == (f"debrief:{SESSION}",)
    assert not conn.closed


def test_acquire_debrief_lock_returns_none_when_held(monkeypatch):
    conn = _FakeConn((False,))
    monkeypatch.setattr(chat, "_get_db_connection", lambda: conn)
    assert chat._acquire_debrief_lock(SESSION) is None
    assert conn.closed


class _UniqueViolationCursor(_FakeCursor):
    def execute(self, sql, params):
        raise chat.psycopg.errors.UniqueViolation("duplicate key")


def _save():
    return chat.save_debrief_to_db(
        session_id=SESSION,
        student_id=None,
        persona_id=None,
        simulation_group_id=None,
        generated_text="{}",
        missing_key_questions=[],
        reasoning_gaps="",
        rubric_scores={},
        total_questions_assigned=0,
        total_questions_asked=0,
        total_questions_missed=0,
        overall_score=0.0,
    )


def test_save_debrief_raises_on_duplicate_instead_of_swallowing(monkeypatch):
    conn = _FakeConn(None)
    conn.cursor_obj = _UniqueViolationCursor(None)
    monkeypatch.setattr(chat, "_get_db_connection", lambda: conn)
    with pytest.raises(chat.DebriefAlreadySaved):
        _save()
    assert conn.closed


def test_save_debrief_returns_empty_on_other_db_error(monkeypatch):
    def boom():
        raise RuntimeError("db down")

    monkeypatch.setattr(chat, "_get_db_connection", boom)
    assert _save() == ""
