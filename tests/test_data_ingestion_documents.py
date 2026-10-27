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


# --- Chunk source id comes from the original key, not the page temp key (finding f-0eb77eb0) ---

class _FakeChunk:
    def __init__(self, text):
        self.page_content = text
        self.metadata = {}


def _real_module(monkeypatch, documents, page_texts):
    """Load an unstubbed copy of documents.py whose S3 and splitter are fakes.

    page_texts maps a page temp key to the text stored under it.
    """
    spec = importlib.util.spec_from_file_location("_ingest_documents_chunks", os.path.join(_SRC, "processing", "documents.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    def download_fileobj(bucket, key, buf):
        buf.write(page_texts[key].encode("utf-8"))

    monkeypatch.setattr(module, "s3", types.SimpleNamespace(download_fileobj=download_fileobj, delete_object=lambda **kw: None))
    monkeypatch.setattr(module, "SemanticChunker", lambda _emb: types.SimpleNamespace(create_documents=lambda texts: [_FakeChunk(t) for t in texts]))
    return module


def _store_texts_returning(module, monkeypatch):
    """Make store_doc_texts return the page keys ingestion would really write."""
    def store_doc_texts(bucket, group, persona, filename, output_bucket, folder="documents"):
        return [f"{group}/{persona}/{folder}/{filename}_page_1.txt"]

    monkeypatch.setattr(module, "store_doc_texts", store_doc_texts)


def _sources(chunks):
    return {c.metadata["source"] for c in chunks}


def test_page_sentinel_in_filename_does_not_collide_with_other_document(monkeypatch, documents):
    legit_page = "group-1/persona-1/documents/notes.pdf_page_1.txt"
    attacker_page = "group-1/persona-1/documents/notes.pdf_page_x.pdf_page_1.txt"
    module = _real_module(monkeypatch, documents, {legit_page: "real", attacker_page: "fake"})
    _store_texts_returning(module, monkeypatch)

    legit = module.add_document(bucket="b", group="group-1", persona="persona-1", filename="notes.pdf", vectorstore=None, embeddings=None)
    attacker = module.add_document(bucket="b", group="group-1", persona="persona-1", filename="notes.pdf_page_x.pdf", vectorstore=None, embeddings=None)

    assert _sources(legit) == {"s3://embedding-bucket/group-1/persona-1/documents/notes.pdf"}
    assert _sources(attacker) == {"s3://embedding-bucket/group-1/persona-1/documents/notes.pdf_page_x.pdf"}
    assert _sources(legit).isdisjoint(_sources(attacker))


def test_files_sharing_a_page_prefix_keep_distinct_sources(monkeypatch, documents):
    """Case_page1.pdf and Case_page2.pdf used to both truncate to 'Case'."""
    pages = {
        "group-1/persona-1/info/Case_page1.pdf_page_1.txt": "one",
        "group-1/persona-1/info/Case_page2.pdf_page_1.txt": "two",
    }
    module = _real_module(monkeypatch, documents, pages)
    _store_texts_returning(module, monkeypatch)

    one = module.add_document(bucket="b", group="group-1", persona="persona-1", filename="Case_page1.pdf", vectorstore=None, embeddings=None, folder="info")
    two = module.add_document(bucket="b", group="group-1", persona="persona-1", filename="Case_page2.pdf", vectorstore=None, embeddings=None, folder="info")

    assert _sources(one) == {"s3://embedding-bucket/group-1/persona-1/info/Case_page1.pdf"}
    assert _sources(two) == {"s3://embedding-bucket/group-1/persona-1/info/Case_page2.pdf"}


def test_normal_filename_source_is_unchanged(monkeypatch, documents):
    """Existing embeddings must keep matching, so the source format for ordinary
    names is the same as before the fix."""
    page = "group-1/persona-1/documents/GroupCode_XXX_-_Group-Name.pdf_page_1.txt"
    module = _real_module(monkeypatch, documents, {page: "text"})
    _store_texts_returning(module, monkeypatch)

    chunks = module.add_document(bucket="b", group="group-1", persona="persona-1", filename="GroupCode_XXX_-_Group-Name.pdf", vectorstore=None, embeddings=None)
    assert _sources(chunks) == {"s3://embedding-bucket/group-1/persona-1/documents/GroupCode_XXX_-_Group-Name.pdf"}
