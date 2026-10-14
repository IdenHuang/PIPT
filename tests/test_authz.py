"""
Unit tests for helpers/authz.py — text-generation request authorization.

Uses an in-memory fake cursor that answers each query type from a small
dataset, so the policy is exercised without a database. The fake also
asserts that every query is parameterized (no caller values in SQL text).
"""
import os
import sys

import pytest

sys.path.insert(
    0,
    os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "cdk", "text_generation", "src", "helpers"),
)
from authz import authorize_request, is_valid_uuid  # noqa: E402

GROUP = "11111111-1111-4111-8111-111111111111"
OTHER_GROUP = "22222222-2222-4222-8222-222222222222"
PERSONA = "33333333-3333-4333-8333-333333333333"
OTHER_PERSONA = "44444444-4444-4444-8444-444444444444"
CHAT = "55555555-5555-4555-8555-555555555555"
OTHER_CHAT = "66666666-6666-4666-8666-666666666666"

STUDENT = "student@example.edu"
OTHER_STUDENT = "other@example.edu"
INSTRUCTOR = "instructor@example.edu"
ADMIN = "admin@example.edu"


class FakeCursor:
    """Answers authz queries from fixed fixtures and records executed SQL."""

    def __init__(self):
        self.admins = {ADMIN}
        self.instructors = {(GROUP, INSTRUCTOR)}
        self.personas = {(PERSONA, GROUP)}
        # chat_id -> (persona_id, simulation_group_id, owner_email)
        self.chats = {
            CHAT: (PERSONA, GROUP, STUDENT),
            OTHER_CHAT: (PERSONA, GROUP, OTHER_STUDENT),
        }
        self.executed = []
        self._row = None

    def execute(self, sql, params):
        for value in params:
            assert str(value) not in sql, "caller value interpolated into SQL"
        self.executed.append(sql)
        self._row = (1,) if self._answer(sql, params) else None

    def _answer(self, sql, params):
        if "ANY(roles)" in sql:
            return params[0] in self.admins
        if '"group_instructors"' in sql:
            email, group = params[0], params[1]
            return (group, email) in self.instructors
        if 'FROM "personas"' in sql:
            return tuple(params) in self.personas
        if 'FROM "chats"' in sql:
            chat = self.chats.get(params[0])
            if chat is None:
                return False
            persona, group, owner = chat
            if (params[1], params[2]) != (persona, group):
                return False
            return len(params) == 3 or params[3] == owner
        raise AssertionError(f"unexpected query: {sql}")

    def fetchone(self):
        return self._row

    def close(self):
        pass


def decide(mode="chat", email=STUDENT, session=CHAT, persona=PERSONA, group=GROUP, cur=None):
    return authorize_request(
        cur or FakeCursor(),
        mode=mode,
        email=email,
        session_id=session,
        persona_id=persona,
        simulation_group_id=group,
    )


# ── Student-owned modes ─────────────────────────────────────────────────────

@pytest.mark.parametrize("mode", ["chat", "match", "debrief", "unknown_mode"])
def test_owner_is_allowed(mode):
    assert decide(mode=mode).allowed


@pytest.mark.parametrize("mode", ["chat", "match", "debrief", "unknown_mode"])
def test_other_users_session_is_denied(mode):
    d = decide(mode=mode, session=OTHER_CHAT)
    assert not d.allowed and d.status_code == 403


def test_instructor_cannot_chat_in_student_session():
    d = decide(email=INSTRUCTOR)
    assert not d.allowed and d.status_code == 403


def test_admin_bypasses_ownership():
    assert decide(email=ADMIN, session=OTHER_CHAT).allowed


def test_admin_still_needs_consistent_ids():
    d = decide(email=ADMIN, persona=OTHER_PERSONA)
    assert not d.allowed and d.status_code == 403


@pytest.mark.parametrize(
    "persona,group",
    [(OTHER_PERSONA, GROUP), (PERSONA, OTHER_GROUP)],
)
def test_own_session_with_foreign_persona_or_group_is_denied(persona, group):
    d = decide(persona=persona, group=group)
    assert not d.allowed and d.status_code == 403


def test_unknown_session_is_denied():
    d = decide(session="77777777-7777-4777-8777-777777777777")
    assert not d.allowed and d.status_code == 403


# ── Input validation and identity ───────────────────────────────────────────

def test_missing_email_is_401():
    d = decide(email="")
    assert not d.allowed and d.status_code == 401


@pytest.mark.parametrize(
    "field,value",
    [
        ("session", "not-a-uuid"),
        ("session", "test-123-abc"),
        ("session", f"{CHAT}' OR '1'='1"),
        ("persona", "x"),
        ("group", ""),
    ],
)
def test_malformed_ids_are_400(field, value):
    d = decide(**{field: value})
    assert not d.allowed and d.status_code == 400


# ── Instructor-only modes ───────────────────────────────────────────────────

@pytest.mark.parametrize("email", [STUDENT, OTHER_STUDENT])
@pytest.mark.parametrize("mode", ["test_debrief", "test_system_prompt"])
def test_students_cannot_use_instructor_modes(mode, email):
    session = CHAT if mode == "test_debrief" else "test-1-abc"
    d = decide(mode=mode, email=email, session=session)
    assert not d.allowed and d.status_code == 403


def test_group_instructor_can_test_debrief_student_session():
    assert decide(mode="test_debrief", email=INSTRUCTOR, session=OTHER_CHAT).allowed


def test_admin_can_test_debrief():
    assert decide(mode="test_debrief", email=ADMIN).allowed


def test_instructor_of_other_group_cannot_test_debrief():
    cur = FakeCursor()
    cur.instructors = {(OTHER_GROUP, INSTRUCTOR)}
    d = decide(mode="test_debrief", email=INSTRUCTOR, cur=cur)
    assert not d.allowed and d.status_code == 403


def test_test_debrief_session_must_belong_to_group():
    cur = FakeCursor()
    cur.instructors.add((OTHER_GROUP, INSTRUCTOR))
    d = decide(mode="test_debrief", email=INSTRUCTOR, group=OTHER_GROUP, cur=cur)
    assert not d.allowed and d.status_code == 403


def test_playground_chat_allowed_for_instructor():
    assert decide(mode="test_system_prompt", email=INSTRUCTOR, session="test-1700000000000-ab12cd").allowed


def test_playground_rejects_real_chat_id():
    """A real chat_id would let the playground read/append that session's history."""
    d = decide(mode="test_system_prompt", email=INSTRUCTOR, session=OTHER_CHAT)
    assert not d.allowed and d.status_code == 400


def test_playground_persona_must_belong_to_group():
    d = decide(mode="test_system_prompt", email=INSTRUCTOR, session="test-1-a", persona=OTHER_PERSONA)
    assert not d.allowed and d.status_code == 403


# ── Helpers ─────────────────────────────────────────────────────────────────

@pytest.mark.parametrize(
    "value,expected",
    [
        (CHAT, True),
        (CHAT.upper(), True),
        (CHAT.replace("-", ""), False),
        ("{" + CHAT + "}", False),
        ("", False),
        (None, False),
    ],
)
def test_is_valid_uuid(value, expected):
    assert is_valid_uuid(value) is expected
