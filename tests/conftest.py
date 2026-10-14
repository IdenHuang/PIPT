"""
Shared test configuration, fixtures, Hypothesis profiles, and skip markers.

This conftest.py sets up the sys.path so that tests can import from
cdk/text_generation/src/helpers/ and provides shared fixtures used
across all test modules.
"""
import sys
import os
import math
import hashlib
import struct
import pytest
from hypothesis import settings, HealthCheck

# ---------------------------------------------------------------------------
# sys.path manipulation — allow importing from cdk/text_generation/src/helpers/
# ---------------------------------------------------------------------------
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_HELPERS_PATH = os.path.join(_REPO_ROOT, "cdk", "text_generation", "src", "helpers")
_SRC_PATH = os.path.join(_REPO_ROOT, "cdk", "text_generation", "src")
_TESTS_PATH = os.path.dirname(os.path.abspath(__file__))

if _HELPERS_PATH not in sys.path:
    sys.path.insert(0, _HELPERS_PATH)
if _SRC_PATH not in sys.path:
    sys.path.insert(0, _SRC_PATH)
if _TESTS_PATH not in sys.path:
    sys.path.insert(0, _TESTS_PATH)

# ---------------------------------------------------------------------------
# Graceful import of chat.py — skip all tests if dependencies are missing
# ---------------------------------------------------------------------------
try:
    # Mock unavailable dependencies before importing chat.py
    import types as _types
    import importlib as _importlib

    def _is_importable(name):
        try:
            _importlib.import_module(name)
            return True
        except ImportError:
            return False

    _mock_modules = [
        "psycopg", "boto3", "langchain_aws", "langchain_core",
        "langchain_core.prompts", "langchain_core.runnables",
        "langchain_core.runnables.history", "langchain_core.messages",
        "langchain_classic", "langchain_classic.chains",
        "langchain_classic.chains.combine_documents",
        "langchain_community", "langchain_community.chat_message_histories",
        "pydantic",
    ]
    for _mod_name in _mock_modules:
        # Only stub modules that genuinely aren't installed; stubbing a real
        # package (e.g. boto3) hides its submodules and breaks chat.py imports.
        if _mod_name not in sys.modules and not _is_importable(_mod_name):
            _mock_mod = _types.ModuleType(_mod_name)
            _mock_mod.BaseModel = type("BaseModel", (), {})
            _mock_mod.Field = lambda **kwargs: None
            _mock_mod.ChatBedrock = type("ChatBedrock", (), {})
            _mock_mod.ChatPromptTemplate = type("ChatPromptTemplate", (), {})
            _mock_mod.MessagesPlaceholder = type("MessagesPlaceholder", (), {})
            _mock_mod.create_stuff_documents_chain = lambda *a, **kw: None
            _mock_mod.create_retrieval_chain = lambda *a, **kw: None
            _mock_mod.RunnableWithMessageHistory = type("RunnableWithMessageHistory", (), {})
            _mock_mod.DynamoDBChatMessageHistory = type("DynamoDBChatMessageHistory", (), {})
            sys.modules[_mod_name] = _mock_mod

    from chat import (
        compute_cosine_similarity,
        greedy_match_assignment,
        match_submissions,
        compute_section_scores,
        compute_overall_score,
        validate_debrief_output,
        SUBMISSION_MATCH_THRESHOLD,
    )
    CHAT_AVAILABLE = True
except ImportError as e:
    CHAT_AVAILABLE = False
    _IMPORT_ERROR = str(e)

    # Create stub references so collection doesn't fail
    compute_cosine_similarity = None
    greedy_match_assignment = None
    match_submissions = None
    compute_section_scores = None
    compute_overall_score = None
    validate_debrief_output = None
    SUBMISSION_MATCH_THRESHOLD = 0.55


def pytest_collection_modifyitems(config, items):
    """Skip all tests if chat.py dependencies are not available."""
    if not CHAT_AVAILABLE:
        skip_marker = pytest.mark.skip(
            reason=f"chat.py dependencies not available: {_IMPORT_ERROR}"
        )
        for item in items:
            item.add_marker(skip_marker)


# ---------------------------------------------------------------------------
# Hypothesis profiles
# ---------------------------------------------------------------------------
settings.register_profile("dev", max_examples=100, suppress_health_check=[HealthCheck.too_slow])
settings.register_profile("ci", max_examples=200, suppress_health_check=[HealthCheck.too_slow])
settings.load_profile(os.getenv("HYPOTHESIS_PROFILE", "dev"))


# ---------------------------------------------------------------------------
# MockEmbeddingsModel
# ---------------------------------------------------------------------------
class MockEmbeddingsModel:
    """Deterministic mock for CohereBedrockEmbeddings.

    Supports two modes:
    1. Hash-based: Generates deterministic vectors from text content via hashing.
       Identical texts produce identical vectors (similarity 1.0).
       Unrelated texts produce low similarity (~0.0-0.3).
    2. Lookup-based: Returns pre-configured vectors for specific texts.

    Matches the CohereBedrockEmbeddings interface: embed_documents() and embed_query().
    """

    def __init__(self, dimension: int = 1024, lookup: dict | None = None):
        self.dimension = dimension
        self.lookup = lookup or {}

    def _hash_to_vector(self, text: str) -> list[float]:
        """Generate a deterministic unit vector from text via SHA-256 hashing."""
        # Expand hash to fill dimension using repeated hashing
        raw_bytes = b""
        seed = text.encode("utf-8")
        while len(raw_bytes) < self.dimension * 4:
            seed = hashlib.sha256(seed).digest()
            raw_bytes += seed

        # Convert bytes to floats
        vec = []
        for i in range(self.dimension):
            # Unpack 4 bytes as a float-like value in [-1, 1]
            val = struct.unpack_from(">i", raw_bytes, i * 4)[0]
            vec.append(val / (2**31))

        # Normalize to unit vector
        norm = math.sqrt(sum(v * v for v in vec))
        if norm > 0:
            vec = [v / norm for v in vec]
        return vec

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        """Batch embed — matches CohereBedrockEmbeddings interface."""
        return [self._embed_single(t) for t in texts]

    def embed_query(self, text: str) -> list[float]:
        """Single embed — matches CohereBedrockEmbeddings interface."""
        return self._embed_single(text)

    def _embed_single(self, text: str) -> list[float]:
        """Embed a single text, using lookup if available, else hash-based."""
        if text in self.lookup:
            return self.lookup[text]
        return self._hash_to_vector(text)


# ---------------------------------------------------------------------------
# Shared pytest fixtures
# ---------------------------------------------------------------------------
@pytest.fixture
def mock_embeddings_model():
    """Provide a default MockEmbeddingsModel instance."""
    return MockEmbeddingsModel(dimension=1024)


@pytest.fixture
def sample_key_questions():
    """Provide sample key questions for testing."""
    from fixtures.key_questions import KEY_QUESTIONS
    return KEY_QUESTIONS


@pytest.fixture
def sample_instructor_dtps():
    """Provide sample instructor DTPs for testing."""
    from fixtures.instructor_items import INSTRUCTOR_DTPS
    return INSTRUCTOR_DTPS


@pytest.fixture
def sample_instructor_recommendations():
    """Provide sample instructor recommendations for testing."""
    from fixtures.instructor_items import INSTRUCTOR_RECOMMENDATIONS
    return INSTRUCTOR_RECOMMENDATIONS


# ---------------------------------------------------------------------------
# Hypothesis custom strategies
# ---------------------------------------------------------------------------
from hypothesis import strategies as st


@st.composite
def non_zero_vectors(draw, dim=st.integers(min_value=2, max_value=50)):
    """Generate float vectors with at least one non-zero element."""
    d = draw(dim) if not isinstance(dim, int) else dim
    vec = draw(
        st.lists(
            st.floats(min_value=-1e6, max_value=1e6, allow_nan=False, allow_infinity=False),
            min_size=d,
            max_size=d,
        )
    )
    # Ensure at least one non-zero element
    if all(v == 0.0 for v in vec):
        idx = draw(st.integers(min_value=0, max_value=d - 1))
        vec[idx] = draw(
            st.floats(min_value=0.1, max_value=1e6, allow_nan=False, allow_infinity=False)
        )
    return vec


@st.composite
def similarity_matrices(draw, num_students=None, num_instructors=None):
    """Generate valid similarity pair lists for greedy_match_assignment."""
    ns = num_students or draw(st.integers(min_value=1, max_value=8))
    ni = num_instructors or draw(st.integers(min_value=1, max_value=8))
    pairs = []
    for s_idx in range(ns):
        for i_idx in range(ni):
            score = draw(st.floats(min_value=0.0, max_value=1.0, allow_nan=False))
            pairs.append((s_idx, i_idx, score))
    return pairs, ns, ni


@st.composite
def key_question_lists(draw, min_size=1, max_size=10):
    """Generate lists of key question dicts with valid metadata."""
    size = draw(st.integers(min_value=min_size, max_value=max_size))
    questions = []
    for i in range(size):
        questions.append({
            "question_id": f"q-{i:03d}",
            "question_text": draw(st.text(min_size=5, max_size=100)),
            "evaluation_criteria": draw(st.text(min_size=5, max_size=100)),
            "is_mandatory": draw(st.booleans()),
            "weight": draw(st.floats(min_value=0.5, max_value=5.0, allow_nan=False, allow_infinity=False)),
        })
    return questions


@st.composite
def dtp_comparison_dicts(draw):
    """Generate valid dtp_comparison structures."""
    num_matched = draw(st.integers(min_value=0, max_value=5))
    num_missed = draw(st.integers(min_value=0, max_value=5))
    num_additional = draw(st.integers(min_value=0, max_value=5))

    matched = [
        {
            "student_text": f"student dtp {i}",
            "instructor_text": f"instructor dtp {i}",
            "instructor_id": f"dtp-{i:03d}",
            "score": draw(st.floats(min_value=0.55, max_value=1.0, allow_nan=False)),
        }
        for i in range(num_matched)
    ]
    missed = [
        {"instructor_text": f"missed dtp {i}", "instructor_id": f"dtp-missed-{i:03d}"}
        for i in range(num_missed)
    ]
    additional = [
        {"student_text": f"additional dtp {i}"}
        for i in range(num_additional)
    ]
    return {"matched": matched, "missed": missed, "additional": additional}


@st.composite
def rec_comparison_dicts(draw):
    """Generate valid rec_comparison structures."""
    num_matched = draw(st.integers(min_value=0, max_value=5))
    num_missed = draw(st.integers(min_value=0, max_value=5))
    num_additional = draw(st.integers(min_value=0, max_value=5))

    matched = [
        {
            "student_text": f"student rec {i}",
            "instructor_text": f"instructor rec {i}",
            "instructor_id": f"rec-{i:03d}",
            "score": draw(st.floats(min_value=0.55, max_value=1.0, allow_nan=False)),
        }
        for i in range(num_matched)
    ]
    missed = [
        {"instructor_text": f"missed rec {i}", "instructor_id": f"rec-missed-{i:03d}"}
        for i in range(num_missed)
    ]
    additional = [
        {"student_text": f"additional rec {i}"}
        for i in range(num_additional)
    ]
    return {"matched": matched, "missed": missed, "additional": additional}


@st.composite
def debrief_dicts(draw, complete=True):
    """Generate debrief output dicts (optionally with missing keys)."""
    base = {
        "summary": draw(st.text(min_size=0, max_size=200)),
        "questions_addressed": [
            {
                "question_id": f"q-{i:03d}",
                "question_text": f"Question {i}",
                "matched_messages": [f"message {i}"],
                "quality_assessment": "Good",
            }
            for i in range(draw(st.integers(min_value=0, max_value=3)))
        ],
        "questions_missed": [
            {
                "question_id": f"q-missed-{i:03d}",
                "question_text": f"Missed question {i}",
                "is_mandatory": draw(st.booleans()),
                "weight": 1.0,
            }
            for i in range(draw(st.integers(min_value=0, max_value=3)))
        ],
        "recommendation_feedback": {
            "strengths": [draw(st.text(min_size=1, max_size=50))],
            "areas_for_improvement": [draw(st.text(min_size=1, max_size=50))],
        },
        "reasoning_gaps": draw(st.text(min_size=0, max_size=100)),
        "overall_score": draw(st.floats(min_value=0.0, max_value=100.0, allow_nan=False, allow_infinity=False)),
        "suggested_rewrites": [],
    }

    if not complete:
        # Randomly remove some keys
        keys_to_maybe_remove = ["summary", "reasoning_gaps", "suggested_rewrites", "overall_score"]
        for key in keys_to_maybe_remove:
            if draw(st.booleans()):
                del base[key]

    return base


@st.composite
def json_serializable_dicts(draw):
    """Generate arbitrary JSON-serializable dictionaries."""
    return draw(
        st.dictionaries(
            keys=st.text(
                alphabet=st.characters(whitelist_categories=("L", "N", "P")),
                min_size=1,
                max_size=20,
            ),
            values=st.one_of(
                st.text(max_size=50),
                st.integers(min_value=-1000, max_value=1000),
                st.floats(min_value=-1000, max_value=1000, allow_nan=False, allow_infinity=False),
                st.booleans(),
                st.none(),
                st.lists(st.integers(min_value=-100, max_value=100), max_size=5),
            ),
            min_size=1,
            max_size=8,
        )
    )
