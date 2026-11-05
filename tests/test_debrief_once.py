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


TABLE = "conversation-table"
TOKEN = "claim-token"


def _run(ddb_table_name=TABLE):
    return chat.generate_debrief(
        session_id=SESSION,
        simulation_group_id="group",
        persona_id="persona",
        llm=None,
        ddb_table_name=ddb_table_name,
    )


class _Claim:
    """Records whether generate_debrief released the claim it took."""

    def __init__(self):
        self.released = []

    def release(self, session_id, table_name, token):
        self.released.append((session_id, table_name, token))

    @property
    def closed(self):
        return self.released == [(SESSION, TABLE, TOKEN)]


def _hold_lock(monkeypatch):
    claim = _Claim()
    monkeypatch.setattr(chat, "_claim_debrief", lambda session_id, table_name: TOKEN)
    monkeypatch.setattr(chat, "_release_debrief_claim", claim.release)
    return claim


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


def _forbid_release(monkeypatch):
    def must_not_release(*args):
        raise AssertionError("released a claim this run never took")

    monkeypatch.setattr(chat, "_release_debrief_claim", must_not_release)


def test_generate_debrief_skips_when_another_run_holds_the_lock(monkeypatch):
    """Concurrent requests: only the claim holder grades (finding f-197f7ee1)."""
    monkeypatch.setattr(chat, "_claim_debrief", lambda session_id, table_name: None)
    _forbid_release(monkeypatch)

    def must_not_check(session_id):
        raise AssertionError("existence check ran without the claim")

    monkeypatch.setattr(chat, "debrief_exists", must_not_check)
    _forbid_grader(monkeypatch)
    _assert_skipped(_run())


def test_generate_debrief_fails_closed_when_lock_errors(monkeypatch):
    def boom(session_id, table_name):
        raise RuntimeError("dynamodb down")

    monkeypatch.setattr(chat, "_claim_debrief", boom)
    _forbid_release(monkeypatch)
    _forbid_grader(monkeypatch)
    _assert_skipped(_run())


def test_generate_debrief_fails_closed_without_claim_table(monkeypatch):
    def must_not_claim(*args):
        raise AssertionError("claimed without a table")

    monkeypatch.setattr(chat, "_claim_debrief", must_not_claim)
    _forbid_grader(monkeypatch)
    _assert_skipped(_run(ddb_table_name=None))


def test_generate_debrief_discards_run_when_debrief_already_saved(monkeypatch):
    lock = _hold_lock(monkeypatch)
    monkeypatch.setattr(chat, "debrief_exists", lambda session_id: False)

    def lost_race(**kwargs):
        raise chat.DebriefAlreadySaved(SESSION)

    monkeypatch.setattr(chat, "_run_debrief_grader", lost_race)
    _assert_skipped(_run())
    assert lock.closed


class _ConditionalCheckFailed(Exception):
    pass


class _FakeTable:
    """Just enough of a boto3 DynamoDB Table for the claim helpers."""

    def __init__(self, put_error=None, update_error=None):
        self.put_error = put_error
        self.update_error = update_error
        self.puts = []
        self.updates = []
        exceptions = type("E", (), {"ConditionalCheckFailedException": _ConditionalCheckFailed})
        self.meta = type("M", (), {"client": type("C", (), {"exceptions": exceptions})})

    def put_item(self, **kwargs):
        self.puts.append(kwargs)
        if self.put_error:
            raise self.put_error

    def update_item(self, **kwargs):
        self.updates.append(kwargs)
        if self.update_error:
            raise self.update_error


def _fake_dynamodb(monkeypatch, table):
    names = []

    class _Resource:
        def Table(self, name):
            names.append(name)
            return table

    class _Boto3:
        @staticmethod
        def resource(service):
            assert service == "dynamodb"
            return _Resource()

    monkeypatch.setattr(chat, "boto3", _Boto3)
    return names


def test_claim_debrief_is_one_conditional_put_without_a_db_connection(monkeypatch):
    """The claim must not hold a DB connection for the grading run (f-1829a8dd)."""
    table = _FakeTable()
    names = _fake_dynamodb(monkeypatch, table)

    def no_db():
        raise AssertionError("claim opened a DB connection")

    monkeypatch.setattr(chat, "_get_db_connection", no_db)
    monkeypatch.setattr(chat.time, "time", lambda: 1_000)

    token = chat._claim_debrief(SESSION, TABLE)

    assert token and names == [TABLE]
    (put,) = table.puts
    item = put["Item"]
    assert item["SessionId"] == f"DEBRIEF_CLAIM#{SESSION}"
    assert item["claim_token"] == token
    assert item["claimed_until"] == 1_000 + chat.DEBRIEF_CLAIM_SECONDS
    assert item["expireAt"] > item["claimed_until"]
    # A live claim blocks; a lapsed one (run died) can be taken over.
    assert put["ConditionExpression"] == "attribute_not_exists(SessionId) OR claimed_until < :now"
    assert put["ExpressionAttributeValues"] == {":now": 1_000}


def test_claim_debrief_tokens_are_unique(monkeypatch):
    _fake_dynamodb(monkeypatch, _FakeTable())
    assert chat._claim_debrief(SESSION, TABLE) != chat._claim_debrief(SESSION, TABLE)


def test_claim_debrief_returns_none_when_held(monkeypatch):
    _fake_dynamodb(monkeypatch, _FakeTable(put_error=_ConditionalCheckFailed()))
    assert chat._claim_debrief(SESSION, TABLE) is None


def test_claim_debrief_raises_on_other_errors(monkeypatch):
    _fake_dynamodb(monkeypatch, _FakeTable(put_error=RuntimeError("throttled")))
    with pytest.raises(RuntimeError):
        chat._claim_debrief(SESSION, TABLE)


def test_claim_outlives_the_lambda_timeout():
    # text generation Lambda timeout is 300s (cdk/lib/api-service-stack.ts).
    assert chat.DEBRIEF_CLAIM_SECONDS > 300


def test_release_debrief_claim_only_releases_own_token(monkeypatch):
    table = _FakeTable()
    _fake_dynamodb(monkeypatch, table)
    chat._release_debrief_claim(SESSION, TABLE, TOKEN)
    (update,) = table.updates
    assert update["Key"] == {"SessionId": f"DEBRIEF_CLAIM#{SESSION}"}
    assert update["UpdateExpression"] == "SET claimed_until = :zero"
    assert update["ConditionExpression"] == "claim_token = :token"
    assert update["ExpressionAttributeValues"] == {":zero": 0, ":token": TOKEN}


def test_release_debrief_claim_swallows_errors(monkeypatch):
    # A taken-over claim (condition fails) or an outage must not mask the
    # debrief result; the claim lapses on its own.
    _fake_dynamodb(monkeypatch, _FakeTable(update_error=_ConditionalCheckFailed()))
    chat._release_debrief_claim(SESSION, TABLE, TOKEN)


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
