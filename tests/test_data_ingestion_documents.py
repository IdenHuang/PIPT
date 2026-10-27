"""
Data-ingestion Lambda (cdk/data_ingestion/src/processing/documents.py):
process_documents() marks a file's ingestion_status "completed" only after
index() has written its embeddings (finding f-2ded25ae).

Marking files "completed" before index() meant a failure inside index() left
them "completed" with zero embeddings, and later runs skipped them.

documents.py is the real module; pymupdf, LangChain, S3 and the DB status
helpers are stubs.
"""
import importlib.util
import os
import sys
import types

import pytest

_SRC = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "cdk", "data_ingestion", "src")

FILES = [
    "group-1/persona-1/documents/a.pdf",
    "group-1/persona-1/documents/b.txt",
]
INFO_FILE = "group-1/persona-1/info/c.pdf"
ANSWER_KEY_FILE = "group-1/persona-1/answer_key/key.pdf"


class FakePaginator:
    def __init__(self, keys):
        self.keys = keys

    def paginate(self, Bucket, Prefix):
        matching = [{"Key": k} for k in self.keys if k.startswith(Prefix)]
        return [{"Contents": matching}] if matching else [{}]


@pytest.fixture
def documents(monkeypatch):
    monkeypatch.setenv("EMBEDDING_BUCKET_NAME", "embedding-bucket")
    monkeypatch.setenv("AWS_DEFAULT_REGION", "us-east-1")

    stub_modules = {
        "pymupdf": types.ModuleType("pymupdf"),
        "langchain_postgres": types.ModuleType("langchain_postgres"),
        "langchain_core": types.ModuleType("langchain_core"),
        "langchain_core.documents": types.ModuleType("langchain_core.documents"),
        "langchain_aws": types.ModuleType("langchain_aws"),
        "langchain_experimental": types.ModuleType("langchain_experimental"),
        "langchain_experimental.text_splitter": types.ModuleType("langchain_experimental.text_splitter"),
        "langchain_classic": types.ModuleType("langchain_classic"),
        "langchain_classic.indexes": types.ModuleType("langchain_classic.indexes"),
    }
    stub_modules["langchain_postgres"].PGVector = object
    stub_modules["langchain_core.documents"].Document = object
    stub_modules["langchain_aws"].BedrockEmbeddings = object
    stub_modules["langchain_experimental.text_splitter"].SemanticChunker = object
    stub_modules["langchain_classic.indexes"].SQLRecordManager = object
    stub_modules["langchain_classic.indexes"].index = lambda *a, **kw: None
    for name, mod in stub_modules.items():
        monkeypatch.setitem(sys.modules, name, mod)

    spec = importlib.util.spec_from_file_location("_ingest_documents_under_test", os.path.join(_SRC, "processing", "documents.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    state = types.SimpleNamespace(events=[], statuses={}, s3_keys=list(FILES), purged=[])
    monkeypatch.setattr(module, "s3", types.SimpleNamespace(get_paginator=lambda _: FakePaginator(state.s3_keys)))
    monkeypatch.setattr(module, "purge_answer_key_embeddings", lambda persona_id, conn: state.purged.append(persona_id) or 0)
    monkeypatch.setattr(module, "get_ingestion_status", lambda persona_id, file_path, conn: state.statuses.get(file_path, "processing"))

    def add_document(**kw):
        state.events.append(("add", kw["filename"]))
        return [f"chunk-of-{kw['filename']}"]

    def update_ingestion_status(persona_id, file_path, status, conn):
        state.events.append(("status", file_path, status))
        state.statuses[file_path] = status

    monkeypatch.setattr(module, "add_document", add_document)
    monkeypatch.setattr(module, "update_ingestion_status", update_ingestion_status)
    module._state = state
    return module


def _run(documents):
    documents.process_documents(
        bucket="ingest-bucket", group="group-1", persona_id="persona-1",
        vectorstore="vs", embeddings="emb", record_manager="rm", connection="conn",
    )


def test_files_marked_completed_only_after_index(documents, monkeypatch):
    def index(chunks, record_manager, vectorstore, **kw):
        documents._state.events.append(("index", tuple(chunks)))
        return {"num_added": len(chunks)}

    monkeypatch.setattr(documents, "index", index)
    _run(documents)

    kinds = [e[0] for e in documents._state.events]
    assert kinds == ["add", "add", "index", "status", "status"]
    assert documents._state.statuses == {f: "completed" for f in FILES}


def test_index_failure_leaves_files_not_completed(documents, monkeypatch):
    def index(*a, **kw):
        raise RuntimeError('password authentication failed for user "app_tc"')

    monkeypatch.setattr(documents, "index", index)
    with pytest.raises(RuntimeError):
        _run(documents)

    assert not any(e[0] == "status" for e in documents._state.events)
    assert documents._state.statuses == {}


def test_failed_files_are_reprocessed_on_next_run(documents, monkeypatch):
    """After an index() failure nothing is "completed", so the next run
    re-derives every file instead of skipping it."""
    attempts = []

    def index(chunks, *a, **kw):
        attempts.append(len(chunks))
        if len(attempts) == 1:
            raise RuntimeError("transient")
        return {}

    monkeypatch.setattr(documents, "index", index)
    with pytest.raises(RuntimeError):
        _run(documents)
    _run(documents)

    assert attempts == [2, 2]
    assert documents._state.statuses == {f: "completed" for f in FILES}


def test_already_completed_files_are_skipped(documents, monkeypatch):
    documents._state.statuses[FILES[0]] = "completed"
    monkeypatch.setattr(documents, "index", lambda chunks, *a, **kw: None)
    _run(documents)

    added = [e[1] for e in documents._state.events if e[0] == "add"]
    assert added == ["b.txt"]


# --- Answer keys stay out of the student-facing collection (finding f-7e54ad52) ---

def test_answer_key_files_are_not_embedded(documents, monkeypatch):
    documents._state.s3_keys = FILES + [INFO_FILE, ANSWER_KEY_FILE]
    indexed = []
    monkeypatch.setattr(documents, "index", lambda chunks, *a, **kw: indexed.extend(chunks))
    _run(documents)

    added = [e[1] for e in documents._state.events if e[0] == "add"]
    assert added == ["a.pdf", "b.txt", "c.pdf"]
    assert "chunk-of-key.pdf" not in indexed
    assert ANSWER_KEY_FILE not in documents._state.statuses


def test_embedded_folders_exclude_answer_key(documents):
    assert "answer_key" not in documents.EMBEDDED_FOLDERS
    assert set(documents.EMBEDDED_FOLDERS) == {"documents", "info"}


def test_legacy_answer_key_embeddings_are_purged(documents, monkeypatch):
    monkeypatch.setattr(documents, "index", lambda chunks, *a, **kw: None)
    _run(documents)
    assert documents._state.purged == ["persona-1"]


class _FakeCursor:
    def __init__(self, rowcount=0, fail=False):
        self.rowcount = rowcount
        self.fail = fail
        self.executed = []
        self.closed = False

    def execute(self, sql, params):
        if self.fail:
            raise RuntimeError("db down")
        self.executed.append((sql, params))

    def close(self):
        self.closed = True


class _FakeConnection:
    def __init__(self, cursor):
        self._cursor = cursor
        self.committed = False
        self.rolled_back = False

    def cursor(self):
        return self._cursor

    def commit(self):
        self.committed = True

    def rollback(self):
        self.rolled_back = True


def _real_purge(documents):
    """The fixture stubs purge_answer_key_embeddings; reload the real one."""
    spec = importlib.util.spec_from_file_location("_ingest_documents_purge", os.path.join(_SRC, "processing", "documents.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.purge_answer_key_embeddings


def test_purge_deletes_only_this_personas_answer_key_sources(documents):
    purge = _real_purge(documents)
    cur = _FakeCursor(rowcount=3)
    conn = _FakeConnection(cur)

    assert purge("persona-1", conn) == 3
    sql, params = cur.executed[0]
    assert "DELETE FROM langchain_pg_embedding" in sql
    assert "cmetadata->>'source' LIKE %s" in sql
    # Parameterized, scoped to the persona's collection and answer_key folder.
    assert params == ("persona-1", "%/persona-1/answer_key/%")
    assert conn.committed and cur.closed


def test_purge_failure_is_logged_not_raised(documents):
    purge = _real_purge(documents)
    cur = _FakeCursor(fail=True)
    conn = _FakeConnection(cur)

    assert purge("persona-1", conn) == 0
    assert conn.rolled_back and cur.closed
