"""
Text-generation Lambda (cdk/text_generation/src/helpers/vectorstore.py):
the student chat retriever only returns chunks from the persona's documents/
and info/ folders, never answer_key/ (finding f-7e54ad52).

vectorstore.py is the real module; LangChain and get_vectorstore are stubs.
"""
import fnmatch
import importlib.util
import os
import sys
import types

import pytest

_SRC = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "cdk", "text_generation", "src")


class FakeVectorstore:
    def __init__(self):
        self.retriever_kwargs = None

    def as_retriever(self, **kwargs):
        self.retriever_kwargs = kwargs
        return "retriever"


@pytest.fixture
def vs_module(monkeypatch):
    fake_vs = FakeVectorstore()

    prompts = types.ModuleType("langchain_core.prompts")
    prompts.ChatPromptTemplate = types.SimpleNamespace(from_messages=lambda msgs: "prompt")
    prompts.MessagesPlaceholder = lambda name: name
    chains = types.ModuleType("langchain_classic.chains")
    chains.create_history_aware_retriever = lambda llm, retriever, prompt: ("history_aware", retriever)
    helpers_pkg = types.ModuleType("helpers")
    helpers_pkg.__path__ = []
    helper = types.ModuleType("helpers.helper")
    helper.get_vectorstore = lambda **kw: (fake_vs, None)

    for name, mod in {
        "langchain_core": types.ModuleType("langchain_core"),
        "langchain_core.prompts": prompts,
        "langchain_classic": types.ModuleType("langchain_classic"),
        "langchain_classic.chains": chains,
        "helpers": helpers_pkg,
        "helpers.helper": helper,
    }.items():
        monkeypatch.setitem(sys.modules, name, mod)

    spec = importlib.util.spec_from_file_location("_textgen_vectorstore_under_test", os.path.join(_SRC, "helpers", "vectorstore.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module._fake_vs = fake_vs
    return module


CONFIG = {
    "collection_name": "persona-1",
    "dbname": "db", "user": "u", "password": "p", "host": "h", "port": "5432",
}


def _like(value, pattern):
    """SQL LIKE semantics for patterns using only % (no _ or escapes)."""
    return fnmatch.fnmatchcase(value, pattern.replace("%", "*"))


def _matches(flt, source):
    return any(_like(source, clause["source"]["$like"]) for clause in flt["$or"])


def test_retriever_is_built_with_source_filter(vs_module):
    result = vs_module.get_vectorstore_retriever(llm="llm", vectorstore_config_dict=CONFIG, embeddings="emb")

    assert result == ("history_aware", "retriever")
    kwargs = vs_module._fake_vs.retriever_kwargs
    assert kwargs == {"search_kwargs": {"filter": vs_module.student_safe_source_filter("persona-1")}}


@pytest.mark.parametrize("source,allowed", [
    ("s3://embedding-bucket/group-1/persona-1/documents/case.pdf", True),
    ("s3://embedding-bucket/group-1/persona-1/info/history.pdf", True),
    ("s3://embedding-bucket/group-1/persona-1/answer_key/key.pdf", False),
    # Unknown or future folders are excluded by default.
    ("s3://embedding-bucket/group-1/persona-1/rubric/r.pdf", False),
    # Another persona's documents never match this persona's filter.
    ("s3://embedding-bucket/group-1/persona-2/documents/case.pdf", False),
])
def test_filter_allows_only_student_safe_folders(vs_module, source, allowed):
    flt = vs_module.student_safe_source_filter("persona-1")
    assert _matches(flt, source) is allowed


def test_answer_key_not_in_retrievable_folders(vs_module):
    assert "answer_key" not in vs_module.STUDENT_RETRIEVABLE_FOLDERS
