"""
Instructor DTP/recommendation embedding cache must follow the DB.

Regression: the RECCACHE#/DTPCACHE# entries are keyed per group+persona and
nothing invalidated them, so a recommendation assigned to a patient after the
first debrief was ignored by later debriefs for up to the cache TTL.
"""
import pytest

import chat

GROUP = "group-1"
PERSONA = "persona-1"


def _rec(rec_id, text):
    return {
        "recommendation_id": rec_id,
        "recommendation_text": text,
        "rationale": "because",
        "evaluation_criteria": None,
    }


class _FakeTable:
    def __init__(self):
        self.items = {}

    def get_item(self, Key):
        item = self.items.get(Key["SessionId"])
        return {"Item": item} if item is not None else {}

    def put_item(self, Item):
        self.items[Item["SessionId"]] = Item


class _FakeDynamo:
    def __init__(self, table):
        self._table = table

    def Table(self, _name):
        return self._table


class _CountingEmbeddings:
    def __init__(self):
        self.calls = []

    def embed_documents(self, texts):
        self.calls.append(list(texts))
        return [[float(len(t)), 1.0] for t in texts]


@pytest.fixture
def env(monkeypatch):
    table = _FakeTable()
    monkeypatch.setattr(chat.boto3, "resource", lambda *_a, **_k: _FakeDynamo(table))
    db_rows = {"recs": [_rec("r1", "Start metformin")]}

    def fake_fetch(_group, _persona, raise_on_error=False):
        if isinstance(db_rows["recs"], Exception):
            raise db_rows["recs"]
        return list(db_rows["recs"])

    monkeypatch.setattr(chat, "fetch_instructor_recommendations", fake_fetch)
    return table, db_rows, _CountingEmbeddings()


def _ids(recs):
    return [r["recommendation_id"] for r in recs]


def test_cache_is_reused_when_db_unchanged(env):
    table, _db, emb = env
    first = chat.load_instructor_recs(GROUP, PERSONA, emb, "t")
    second = chat.load_instructor_recs(GROUP, PERSONA, emb, "t")
    assert _ids(first) == _ids(second) == ["r1"]
    assert len(emb.calls) == 1


def test_newly_assigned_recommendation_is_picked_up(env):
    _table, db, emb = env
    chat.load_instructor_recs(GROUP, PERSONA, emb, "t")
    db["recs"] = [_rec("r1", "Start metformin"), _rec("r2", "Refer to dietitian")]
    recs = chat.load_instructor_recs(GROUP, PERSONA, emb, "t")
    assert _ids(recs) == ["r1", "r2"]
    assert len(emb.calls) == 2


def test_cached_empty_list_does_not_hide_later_assignment(env):
    _table, db, emb = env
    db["recs"] = []
    assert chat.load_instructor_recs(GROUP, PERSONA, emb, "t") == []
    db["recs"] = [_rec("r9", "Patient-specific rec")]
    assert _ids(chat.load_instructor_recs(GROUP, PERSONA, emb, "t")) == ["r9"]


def test_edited_text_rebuilds_cache(env):
    _table, db, emb = env
    chat.load_instructor_recs(GROUP, PERSONA, emb, "t")
    db["recs"] = [_rec("r1", "Start metformin 500 mg BID")]
    recs = chat.load_instructor_recs(GROUP, PERSONA, emb, "t")
    assert recs[0]["recommendation_text"] == "Start metformin 500 mg BID"


def test_legacy_cache_without_fingerprint_is_rebuilt(env):
    table, _db, emb = env
    table.items[f"RECCACHE#{GROUP}#{PERSONA}"] = {
        "SessionId": f"RECCACHE#{GROUP}#{PERSONA}",
        "items": [],
    }
    assert _ids(chat.load_instructor_recs(GROUP, PERSONA, emb, "t")) == ["r1"]


def test_db_failure_falls_back_to_cache(env):
    _table, db, emb = env
    chat.load_instructor_recs(GROUP, PERSONA, emb, "t")
    db["recs"] = RuntimeError("db down")
    assert _ids(chat.load_instructor_recs(GROUP, PERSONA, emb, "t")) == ["r1"]
    assert len(emb.calls) == 1
