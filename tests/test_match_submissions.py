"""
Property-based and example-based tests for match_submissions.

Feature: debrief-dtp-recommendation-test-suite
Properties 10-12, 24: Student completeness, instructor completeness,
threshold constraint, result structure.
"""
import pytest
from hypothesis import given, settings
from hypothesis import strategies as st
from test_support import (
    match_submissions,
    are_clinically_contradictory,
    SUBMISSION_MATCH_THRESHOLD,
    MockEmbeddingsModel,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_instructor_items(texts: list[str], model: MockEmbeddingsModel) -> list[dict]:
    """Build instructor items with pre-cached embeddings."""
    embeddings = model.embed_documents(texts)
    return [
        {
            "dtp_id": f"dtp-{i:03d}",
            "expected_dtp_text": text,
            "embedding": emb,
        }
        for i, (text, emb) in enumerate(zip(texts, embeddings))
    ]


# ---------------------------------------------------------------------------
# Property tests
# ---------------------------------------------------------------------------

@pytest.mark.property
@settings(max_examples=100)
@given(
    num_students=st.integers(min_value=1, max_value=6),
    num_instructors=st.integers(min_value=1, max_value=6),
)
def test_student_completeness(num_students, num_instructors):
    """Property 10: Student completeness — matched + additional == len(student_texts).

    Feature: debrief-dtp-recommendation-test-suite, Property 10: Match submissions student completeness
    """
    model = MockEmbeddingsModel(dimension=64)
    student_texts = [f"student submission {i}" for i in range(num_students)]
    instructor_texts = [f"instructor item {i}" for i in range(num_instructors)]
    instructor_items = _make_instructor_items(instructor_texts, model)

    result = match_submissions(student_texts, instructor_items, model)

    assert len(result["matched"]) + len(result["additional"]) == num_students


@pytest.mark.property
@settings(max_examples=100)
@given(
    num_students=st.integers(min_value=1, max_value=6),
    num_instructors=st.integers(min_value=1, max_value=6),
)
def test_instructor_completeness(num_students, num_instructors):
    """Property 11: Instructor completeness — matched + missed == len(instructor_items).

    Feature: debrief-dtp-recommendation-test-suite, Property 11: Match submissions instructor completeness
    """
    model = MockEmbeddingsModel(dimension=64)
    student_texts = [f"student submission {i}" for i in range(num_students)]
    instructor_texts = [f"instructor item {i}" for i in range(num_instructors)]
    instructor_items = _make_instructor_items(instructor_texts, model)

    result = match_submissions(student_texts, instructor_items, model)

    assert len(result["matched"]) + len(result["missed"]) == num_instructors


@pytest.mark.property
@settings(max_examples=100)
@given(
    num_students=st.integers(min_value=1, max_value=6),
    num_instructors=st.integers(min_value=1, max_value=6),
)
def test_threshold_constraint(num_students, num_instructors):
    """Property 12: Threshold constraint — all matched scores >= 0.55.

    Feature: debrief-dtp-recommendation-test-suite, Property 12: Match submissions threshold constraint
    """
    model = MockEmbeddingsModel(dimension=64)
    student_texts = [f"student submission {i}" for i in range(num_students)]
    instructor_texts = [f"instructor item {i}" for i in range(num_instructors)]
    instructor_items = _make_instructor_items(instructor_texts, model)

    result = match_submissions(student_texts, instructor_items, model)

    for item in result["matched"]:
        assert item["score"] >= SUBMISSION_MATCH_THRESHOLD, (
            f"Matched item has score {item['score']} < threshold {SUBMISSION_MATCH_THRESHOLD}"
        )


@pytest.mark.property
@settings(max_examples=100)
@given(
    num_students=st.integers(min_value=1, max_value=6),
    num_instructors=st.integers(min_value=1, max_value=6),
)
def test_result_structure(num_students, num_instructors):
    """Property 24: Result structure — matched/missed/additional have correct fields.

    Feature: debrief-dtp-recommendation-test-suite, Property 24: Match submissions result structure
    """
    model = MockEmbeddingsModel(dimension=64)
    student_texts = [f"student submission {i}" for i in range(num_students)]
    instructor_texts = [f"instructor item {i}" for i in range(num_instructors)]
    instructor_items = _make_instructor_items(instructor_texts, model)

    result = match_submissions(student_texts, instructor_items, model)

    for item in result["matched"]:
        assert "student_text" in item
        assert "instructor_text" in item
        assert "instructor_id" in item
        assert "score" in item

    for item in result["missed"]:
        assert "instructor_text" in item
        assert "instructor_id" in item

    for item in result["additional"]:
        assert "student_text" in item


# ---------------------------------------------------------------------------
# Example-based tests
# ---------------------------------------------------------------------------

@pytest.mark.integration
def test_empty_student_texts():
    """Empty student_texts returns all instructors as missed."""
    model = MockEmbeddingsModel(dimension=64)
    instructor_items = _make_instructor_items(["expected dtp 1", "expected dtp 2"], model)

    result = match_submissions([], instructor_items, model)

    assert result["matched"] == []
    assert len(result["missed"]) == 2
    assert result["additional"] == []


@pytest.mark.integration
def test_empty_instructor_items():
    """Empty instructor_items returns all students as additional."""
    model = MockEmbeddingsModel(dimension=64)

    result = match_submissions(["student text 1", "student text 2"], [], model)

    assert result["matched"] == []
    assert result["missed"] == []
    assert len(result["additional"]) == 2


@pytest.mark.integration
def test_both_empty():
    """Both empty returns all empty lists."""
    model = MockEmbeddingsModel(dimension=64)

    result = match_submissions([], [], model)

    assert result == {"matched": [], "missed": [], "additional": []}


@pytest.mark.integration
def test_identical_texts_produce_score_1():
    """Identical mock vectors produce score=1.0."""
    text = "exact same text for matching"
    model = MockEmbeddingsModel(dimension=64)
    instructor_items = _make_instructor_items([text], model)

    result = match_submissions([text], instructor_items, model)

    assert len(result["matched"]) == 1
    assert result["matched"][0]["score"] == 1.0
    assert result["missed"] == []
    assert result["additional"] == []


# ---------------------------------------------------------------------------
# Contradictory clinical action tests
# ---------------------------------------------------------------------------

@pytest.mark.integration
def test_contradictory_continue_vs_discontinue_not_matched():
    """Student saying 'continue naproxen' must NOT match instructor 'discontinue naproxen'."""
    model = MockEmbeddingsModel(dimension=64)
    instructor_items = _make_instructor_items(
        ["Mary should discontinue naproxen due to GI bleeding risk"], model
    )

    result = match_submissions(
        ["Mary should continue naproxen"], instructor_items, model
    )

    assert result["matched"] == [], (
        "Contradictory action (continue vs discontinue) should never produce a match"
    )
    assert len(result["missed"]) == 1
    assert len(result["additional"]) == 1


@pytest.mark.integration
def test_agreeing_discontinue_is_matched():
    """Student saying 'discontinue naproxen' SHOULD match instructor 'discontinue naproxen'."""
    instructor_text = "Mary should discontinue naproxen due to GI bleeding risk"
    # The hash-based mock gives unrelated vectors to any two different
    # sentences, so give the student's paraphrase the instructor's vector:
    # this test checks the contradiction filter, not embedding similarity.
    base = MockEmbeddingsModel(dimension=64)
    model = MockEmbeddingsModel(
        dimension=64,
        lookup={"Mary should discontinue naproxen": base.embed_query(instructor_text)},
    )
    instructor_items = _make_instructor_items([instructor_text], model)

    result = match_submissions(
        ["Mary should discontinue naproxen"], instructor_items, model
    )

    assert len(result["matched"]) == 1, (
        "Same clinical action (discontinue vs discontinue) should be matched"
    )


@pytest.mark.integration
def test_contradictory_increase_vs_decrease_not_matched():
    """Student saying 'increase metformin' must NOT match instructor 'decrease metformin'."""
    model = MockEmbeddingsModel(dimension=64)
    instructor_items = _make_instructor_items(
        ["Decrease metformin dose to 500mg daily"], model
    )

    result = match_submissions(["Increase metformin dose to 1000mg daily"], instructor_items, model)

    assert result["matched"] == []


@pytest.mark.unit
def test_are_clinically_contradictory_continue_discontinue():
    assert are_clinically_contradictory("continue naproxen", "discontinue naproxen") is True
    assert are_clinically_contradictory("discontinue naproxen", "continue naproxen") is True


@pytest.mark.unit
def test_are_clinically_contradictory_same_action():
    assert are_clinically_contradictory("discontinue naproxen", "discontinue naproxen") is False
    assert are_clinically_contradictory("continue atenolol", "continue atenolol") is False


@pytest.mark.unit
def test_are_clinically_contradictory_unrelated():
    assert are_clinically_contradictory("start lisinopril 10mg", "add metformin") is False


@pytest.mark.unit
def test_are_clinically_contradictory_increase_decrease():
    assert are_clinically_contradictory("increase the dose", "decrease the dose") is True


@pytest.mark.unit
def test_are_clinically_contradictory_hold_resume():
    assert are_clinically_contradictory("hold warfarin", "resume warfarin") is True
