"""
Authorization checks for the text-generation Lambda.

The API Gateway authorizer (cdk/lambda/jwtAuthorizer) only authenticates the
caller; it does not check that the caller may act on the session, persona or
simulation group named in the query string. These checks close that gap and
mirror the SQL in cdk/lambda/lib/authz.js (verifySessionOwnership,
verifyGroupOwnership, isAdmin) so both runtimes enforce the same rules.

Every query is parameterized and every check fails closed: any error or
missing row results in a denial.
"""
import hashlib
import logging
import re
import uuid
from dataclasses import dataclass

logger = logging.getLogger(__name__)

# Prompt Playground chats use client-generated scratch IDs with this prefix
# (frontend SystemPromptPlayground.tsx: `test-${Date.now()}-${6 base36 chars}`).
# They never correspond to a real chats.chat_id (always a UUID), so requiring
# the prefix keeps the playground away from real student chat history.
PLAYGROUND_SESSION_PREFIX = "test-"

# The prefix alone does not stop one instructor replaying another instructor's
# playground ID. playground_history_key() therefore namespaces the history key
# by caller, and the client ID is limited to a short, key-safe charset.
_PLAYGROUND_SESSION_RE = re.compile(r"^test-[A-Za-z0-9-]{1,64}$")

# Modes restricted to instructors of the group (or admins).
INSTRUCTOR_MODES = {"test_debrief", "test_system_prompt"}


@dataclass(frozen=True)
class AuthzDecision:
    allowed: bool
    status_code: int = 200
    reason: str = ""


ALLOW = AuthzDecision(True)


def _deny(status_code: int, reason: str) -> AuthzDecision:
    return AuthzDecision(False, status_code, reason)


def is_valid_uuid(value) -> bool:
    """True if value is a canonical UUID string (as stored in Postgres)."""
    if not isinstance(value, str):
        return False
    try:
        return str(uuid.UUID(value)) == value.lower()
    except (ValueError, AttributeError):
        return False


def is_valid_playground_session_id(value) -> bool:
    """True if value looks like a client-generated playground scratch ID."""
    return isinstance(value, str) and _PLAYGROUND_SESSION_RE.fullmatch(value) is not None


def playground_history_key(email: str, session_id: str) -> str:
    """
    Server-side chat-history key for a playground session, bound to the caller.

    The client-supplied ID is kept as a suffix so one instructor can run several
    playground chats, but the key is prefixed with a hash of the caller's email.
    Another instructor sending the same session_id gets a different key and can
    neither read nor append to this history. Emails compare case-insensitively.
    """
    owner = hashlib.sha256(email.strip().lower().encode("utf-8")).hexdigest()[:32]
    return f"{PLAYGROUND_SESSION_PREFIX}{owner}-{session_id[len(PLAYGROUND_SESSION_PREFIX):]}"


def is_admin(cur, email: str) -> bool:
    """Mirror of authz.js isAdmin: users.roles contains 'admin'."""
    cur.execute(
        """
        SELECT 1 FROM "users"
        WHERE user_email = %s AND 'admin' = ANY(roles)
        """,
        (email,),
    )
    return cur.fetchone() is not None


def is_group_instructor(cur, simulation_group_id: str, email: str) -> bool:
    """Mirror of authz.js verifyGroupOwnership (creator, assigned, or instructor enrollment)."""
    cur.execute(
        """
        SELECT 1
        FROM "users" u
        WHERE u.user_email = %s
          AND (
            EXISTS (
              SELECT 1 FROM "simulation_groups" sg
              WHERE sg.simulation_group_id = %s AND sg.created_by = u.user_id
            )
            OR EXISTS (
              SELECT 1 FROM "group_instructors" gi
              WHERE gi.simulation_group_id = %s AND gi.user_id = u.user_id
            )
            OR EXISTS (
              SELECT 1 FROM "enrollments" e
              WHERE e.simulation_group_id = %s AND e.user_id = u.user_id
                AND e.enrollment_type = 'instructor'
            )
          )
        """,
        (email, simulation_group_id, simulation_group_id, simulation_group_id),
    )
    return cur.fetchone() is not None


def session_matches(cur, session_id: str, persona_id: str, simulation_group_id: str,
                    owner_email: str | None = None) -> bool:
    """
    True if the chat exists and belongs to this persona and simulation group.

    When owner_email is given, the chat must also belong to that user
    (same join as authz.js verifySessionOwnership). Binding all three IDs
    stops a caller pairing their own session with another group's persona
    (which would expose that persona's RAG collection and prompts).
    """
    query = """
        SELECT 1
        FROM "chats" c
        JOIN "student_interactions" si ON si.student_interaction_id = c.student_interaction_id
        JOIN "enrollments" e ON e.enrollment_id = si.enrollment_id
    """
    params: list = [session_id, persona_id, simulation_group_id]
    if owner_email is not None:
        query += ' JOIN "users" u ON u.user_id = e.user_id'
    query += " WHERE c.chat_id = %s AND si.persona_id = %s AND e.simulation_group_id = %s"
    if owner_email is not None:
        query += " AND u.user_email = %s"
        params.append(owner_email)
    cur.execute(query, tuple(params))
    return cur.fetchone() is not None


def session_is_concluded(cur, session_id: str) -> bool:
    """True if the chat has been concluded (its debrief is graded and final)."""
    cur.execute(
        """
        SELECT 1 FROM "chats"
        WHERE chat_id = %s AND status = 'concluded'
        """,
        (session_id,),
    )
    return cur.fetchone() is not None


# Student modes that may still run once a chat is concluded: "debrief" is
# invoked by conclude_interaction after the status flips, and "match" tags
# messages that were already saved. Every other student mode is treated as
# chat and appends a turn, so it is refused on a concluded chat.
POST_CONCLUDE_MODES = {"debrief", "match"}


def persona_in_group(cur, persona_id: str, simulation_group_id: str) -> bool:
    cur.execute(
        """
        SELECT 1 FROM "personas"
        WHERE persona_id = %s AND simulation_group_id = %s
        """,
        (persona_id, simulation_group_id),
    )
    return cur.fetchone() is not None


def authorize_request(cur, *, mode: str, email: str, session_id: str,
                      persona_id: str, simulation_group_id: str) -> AuthzDecision:
    """
    Decide whether the authenticated caller may run `mode` against these IDs.

    Policy:
      - chat (default; also any unrecognised mode, which the handler treats
        as chat), match, debrief: the caller must own the session, or be an
        admin. The session must belong to the persona and group either way.
        Chat (and unrecognised modes) are refused with 409 once the chat is
        concluded; match and debrief still run.
      - test_debrief: caller must instruct the group (or be admin); the
        session must belong to the persona and group.
      - test_system_prompt: caller must instruct the group (or be admin);
        the persona must belong to the group; session_id must be a
        playground scratch ID, never a real chat. The handler must then key
        history with playground_history_key() so it is bound to the caller.
    """
    if not email:
        return _deny(401, "Missing caller identity")
    if not is_valid_uuid(simulation_group_id) or not is_valid_uuid(persona_id):
        return _deny(400, "Invalid simulation_group_id or patient_id")

    if mode in INSTRUCTOR_MODES:
        if not (is_admin(cur, email) or is_group_instructor(cur, simulation_group_id, email)):
            return _deny(403, "Instructor access required")

        if mode == "test_system_prompt":
            if not is_valid_playground_session_id(session_id):
                return _deny(400, "Invalid playground session_id")
            if not persona_in_group(cur, persona_id, simulation_group_id):
                return _deny(403, "Access denied")
            return ALLOW

        # test_debrief runs against a real (completed) student session in the group.
        if not is_valid_uuid(session_id):
            return _deny(400, "Invalid session_id")
        if not session_matches(cur, session_id, persona_id, simulation_group_id):
            return _deny(403, "Access denied")
        return ALLOW

    # chat / match / debrief
    if not is_valid_uuid(session_id):
        return _deny(400, "Invalid session_id")
    owner_email = None if is_admin(cur, email) else email
    if not session_matches(cur, session_id, persona_id, simulation_group_id, owner_email):
        return _deny(403, "Access denied")
    # A concluded chat is read-only for chat turns (security finding f-7d966e0e).
    if mode not in POST_CONCLUDE_MODES and session_is_concluded(cur, session_id):
        return _deny(409, "Session already concluded")
    return ALLOW
