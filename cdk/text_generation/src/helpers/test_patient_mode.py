"""Tests that the debrief grading scope is derived server-side
(security finding f-5874e8aa)."""
import inspect
from unittest.mock import MagicMock

import pytest

import chat


class TestPatientModeFromCounts:
    """Must agree with getPatientMode in cdk/lambda/lib/debriefGeneration.js."""

    def test_nothing_assigned_is_conversation_only(self):
        assert chat.patient_mode_from_counts(0, 0, 0) == "conversation_only"

    def test_questions_only_is_interview_practice(self):
        assert chat.patient_mode_from_counts(3, 0, 0) == "interview_practice"

    @pytest.mark.parametrize("dtps,recs", [(1, 0), (0, 1), (2, 2)])
    def test_any_dtp_or_rec_is_full_assessment(self, dtps, recs):
        assert chat.patient_mode_from_counts(0, dtps, recs) == "full_assessment"
        assert chat.patient_mode_from_counts(5, dtps, recs) == "full_assessment"


def _fake_connection(row):
    cursor = MagicMock()
    cursor.fetchone.return_value = row
    conn = MagicMock()
    conn.cursor.return_value = cursor
    return conn, cursor


class TestDerivePatientMode:
    def test_queries_group_and_persona(self, monkeypatch):
        conn, cursor = _fake_connection((2, 1, 0))
        monkeypatch.setattr(chat, "_get_db_connection", lambda: conn)

        assert chat.derive_patient_mode("group-1", "persona-1") == "full_assessment"
        params = cursor.execute.call_args.args[1]
        assert params == {"g": "group-1", "p": "persona-1"}
        conn.close.assert_called_once()

    def test_db_error_fails_closed(self, monkeypatch):
        def boom():
            raise ConnectionError("db down")

        monkeypatch.setattr(chat, "_get_db_connection", boom)
        with pytest.raises(RuntimeError):
            chat.derive_patient_mode("group-1", "persona-1")


class TestGenerateDebriefUsesDerivedScope:
    def test_no_caller_supplied_patient_mode(self):
        assert "patient_mode" not in inspect.signature(chat.generate_debrief).parameters

    def test_grader_receives_derived_mode(self, monkeypatch):
        monkeypatch.setattr(chat, "_claim_debrief", lambda *a, **k: "token")
        monkeypatch.setattr(chat, "_release_debrief_claim", lambda *a, **k: None)
        monkeypatch.setattr(chat, "debrief_exists", lambda *a, **k: False)
        heartbeat = MagicMock()
        monkeypatch.setattr(chat, "_DebriefClaimHeartbeat", lambda *a, **k: heartbeat)
        monkeypatch.setattr(chat, "derive_patient_mode", lambda g, p: "full_assessment")
        grader = MagicMock(return_value={"ok": True})
        monkeypatch.setattr(chat, "_run_debrief_grader", grader)

        chat.generate_debrief(
            session_id="s", simulation_group_id="g", persona_id="p",
            llm=MagicMock(), ddb_table_name="table",
        )
        assert grader.call_args.kwargs["patient_mode"] == "full_assessment"

    def test_existing_debrief_skips_derivation(self, monkeypatch):
        monkeypatch.setattr(chat, "_claim_debrief", lambda *a, **k: "token")
        monkeypatch.setattr(chat, "_release_debrief_claim", lambda *a, **k: None)
        monkeypatch.setattr(chat, "debrief_exists", lambda *a, **k: True)
        monkeypatch.setattr(chat, "_DebriefClaimHeartbeat", lambda *a, **k: MagicMock())
        derive = MagicMock()
        monkeypatch.setattr(chat, "derive_patient_mode", derive)

        result = chat.generate_debrief(
            session_id="s", simulation_group_id="g", persona_id="p",
            llm=MagicMock(), ddb_table_name="table",
        )
        assert result == chat.DEBRIEF_ALREADY_GENERATED
        derive.assert_not_called()
