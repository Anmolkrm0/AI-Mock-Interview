"""Unit tests for pure business logic (no database, no network)."""

from __future__ import annotations

import io
import uuid
from types import SimpleNamespace

import pytest

from app.core.config import get_settings
from app.core.errors import AppError, Conflict, ValidationFailed
from app.core.logging import redact
from app.providers.base import map_http_error
from app.schemas.documents import JobExtraction, RoleSuggestion
from app.schemas.interviews import InterviewCreate
from app.schemas.plan import InterviewPlanDraft, PlanQuestion
from app.schemas.report import QuestionJudgement
from app.services import document_service
from app.services.evaluation_service import (
    AnsweredQuestion,
    compute_scores,
    quote_in_transcript,
    select_attempt,
    to_percent,
)
from app.services.interview_planner import fit_time_allocations, question_budget
from app.services.interview_service import can_transition, transition
from app.services.live_ai_service import build_system_instruction
from app.services.role_detection_service import detect_roles

# ------------------------------------------------------------- state machine


@pytest.mark.parametrize(
    ("current", "target", "ok"),
    [
        ("created", "preparing", True),
        ("preparing", "ready", True),
        ("ready", "connecting", True),
        ("connecting", "in_progress", True),
        ("connecting", "failed", True),
        ("in_progress", "paused", True),
        ("paused", "in_progress", True),
        ("in_progress", "finalizing", True),
        ("finalizing", "evaluating", True),
        ("evaluating", "completed", True),
        ("evaluating", "failed", True),
        ("completed", "in_progress", False),
        ("completed", "connecting", False),
        ("cancelled", "preparing", False),
        ("ready", "in_progress", False),
        ("created", "in_progress", False),
    ],
)
def test_transitions(current: str, target: str, ok: bool) -> None:
    assert can_transition(current, target) is ok


def test_failed_retry_only_into_failed_stage() -> None:
    assert can_transition("failed", "preparing", "planning")
    assert not can_transition("failed", "connecting", "planning")
    assert can_transition("failed", "evaluating", "evaluation")
    assert not can_transition("failed", "preparing", "evaluation")
    assert can_transition("failed", "connecting", "live")


def test_completed_interview_cannot_restart() -> None:
    interview = SimpleNamespace(status="completed", failure_stage=None, failure_code=None)
    with pytest.raises(Conflict) as exc:
        transition(interview, "connecting")  # type: ignore[arg-type]
    assert exc.value.code == "INVALID_STATE_TRANSITION"


# ------------------------------------------------------------- duration & config


@pytest.mark.parametrize("duration", [10, 20, 30, 45])
@pytest.mark.parametrize("rigor", ["standard", "target_bar", "stress_test"])
def test_question_budget_adapts(duration: int, rigor: str) -> None:
    core, optional, available = question_budget(duration, rigor)
    assert 3 <= core <= 16 and optional >= 1
    assert available == duration * 60 - 90


def test_question_count_not_fixed() -> None:
    counts = {question_budget(d, "standard")[0] for d in (10, 20, 30, 45)}
    assert len(counts) == 4  # each duration yields a different count
    assert question_budget(45, "stress_test")[0] < question_budget(45, "standard")[0]


def test_invalid_duration_and_missing_consent_rejected() -> None:
    base = dict(
        resume_document_id=uuid.uuid4(),
        job_description_document_id=uuid.uuid4(),
        job_role="Engineer",
        evaluation_rigor="standard",
        consent_given=True,
    )
    InterviewCreate(**base, duration_minutes=20)
    with pytest.raises(ValueError):
        InterviewCreate(**base, duration_minutes=15)
    with pytest.raises(ValueError):
        InterviewCreate(**{**base, "consent_given": False}, duration_minutes=20)
    with pytest.raises(ValueError):
        InterviewCreate(**{**base, "evaluation_rigor": "brutal"}, duration_minutes=20)


def _plan_question(i: int, priority: str = "core") -> dict:
    return {
        "question": f"Tell me about a distinct question {i}?",
        "category": "technical",
        "competency": "Coding",
        "difficulty": 3,
        "priority": priority,
        "expected_evidence": ["x"],
        "time_allocation_seconds": 100,
    }


def test_plan_validation_dedupes_and_normalizes_weights() -> None:
    draft = InterviewPlanDraft.model_validate(
        {
            "objectives": ["o"],
            "competencies": [{"competency": "Coding", "weight": 0.5}],
            "questions": [
                _plan_question(1),
                _plan_question(1),
                _plan_question(2),
                {**_plan_question(3), "competency": "Design"},
            ],
        }
    )
    assert len(draft.questions) == 3  # duplicate removed
    names = {c.competency for c in draft.competencies}
    assert names == {"Coding", "Design"}  # missing competency added
    assert abs(sum(c.weight for c in draft.competencies) - 1) < 1e-3


def test_plan_validation_rejects_bad_difficulty() -> None:
    with pytest.raises(ValueError):
        InterviewPlanDraft.model_validate(
            {
                "objectives": ["o"],
                "competencies": [{"competency": "Coding", "weight": 1}],
                "questions": [{**_plan_question(1), "difficulty": 9}, _plan_question(2)],
            }
        )


def test_time_allocations_fit_budget() -> None:
    draft = InterviewPlanDraft.model_validate(
        {
            "objectives": ["o"],
            "competencies": [{"competency": "Coding", "weight": 1}],
            "questions": [_plan_question(i) for i in range(4)] + [_plan_question(9, "optional")],
        }
    )
    fit_time_allocations(draft, 1110)
    core_total = sum(q.time_allocation_seconds for q in draft.questions if q.priority == "core")
    assert abs(core_total - 1110) <= 4


def test_plan_question_rejects_multiple_question_marks() -> None:
    with pytest.raises(ValueError, match="at most one"):
        PlanQuestion(
            question="What is your favorite project? Why did you choose it?",
            category="technical",
            competency="Coding",
            difficulty=3,
            expected_evidence=["evidence"],
            time_allocation_seconds=120,
        )


def test_plan_question_rejects_over_220_characters() -> None:
    long_question = "Explain " + "x" * 215 + "?"
    assert len(long_question) > 220
    with pytest.raises(ValueError):
        PlanQuestion(
            question=long_question,
            category="technical",
            competency="Coding",
            difficulty=3,
            expected_evidence=["evidence"],
            time_allocation_seconds=120,
        )


def test_plan_question_accepts_valid_question() -> None:
    pq = PlanQuestion(
        question="How do you handle database migrations safely?",
        category="technical",
        competency="Coding",
        difficulty=3,
        expected_evidence=["evidence"],
        time_allocation_seconds=120,
    )
    assert pq.question == "How do you handle database migrations safely?"
    assert len(pq.question) <= 220
    assert pq.question.count("?") <= 1


def test_build_system_instruction_contains_short_question_and_clarification_rules() -> None:
    interview = SimpleNamespace(
        duration_minutes=20,
        job_role="Senior Software Engineer",
        evaluation_rigor="standard",
    )
    q1 = SimpleNamespace(
        sequence_number=1,
        priority="core",
        competency="Coding",
        time_allocation_seconds=120,
        status="pending",
        question_text="How do you structure microservices?",
        follow_up_topics=["scalability"],
    )
    instruction = build_system_instruction(
        interview=interview,  # type: ignore[arg-type]
        objectives=["Assess backend depth"],
        questions=[q1],  # type: ignore[arg-type]
        candidate={"headline": "Backend Engineer"},
        job_title="Senior Software Engineer",
        remaining=1200,
    )
    assert "Ask each planned question in one or two short sentences." in instruction
    assert (
        "Do not add commentary, praise or a summary of the previous answer before the next question; at most say 'Thanks.'"
        in instruction
    )
    assert (
        "If the candidate asks you to repeat or clarify, answer only what they asked, in one short sentence."
        in instruction
    )
    assert (
        "For example, if they ask for the second part, say only the second part. Never re-read the whole question unless they ask for the whole question, and never repeat earlier questions."
        in instruction
    )
    assert (
        "Keep your own turns short: acknowledgements are 3 to 6 words. Then stop and let the candidate speak."
        in instruction
    )


def test_build_system_instruction_greeting_and_resume() -> None:
    interview = SimpleNamespace(
        duration_minutes=20,
        job_role="Senior Software Engineer",
        evaluation_rigor="standard",
    )
    q1 = SimpleNamespace(
        sequence_number=1,
        priority="core",
        competency="Coding",
        time_allocation_seconds=120,
        status="pending",
        question_text="How do you structure microservices?",
        follow_up_topics=["scalability"],
    )
    # Fresh start with candidate name
    fresh_instruction = build_system_instruction(
        interview=interview,  # type: ignore[arg-type]
        objectives=["Assess backend depth"],
        questions=[q1],  # type: ignore[arg-type]
        candidate={"headline": "Backend Engineer"},
        job_title="Senior Software Engineer",
        remaining=1200,
        candidate_first_name="Ritik",
    )
    assert "When the candidate joins, speak first, immediately." in fresh_instruction
    assert "Start with one short sentence (under 10 words)" in fresh_instruction
    assert "'Hi Ritik, I\\'m your interviewer today.'" in fresh_instruction
    assert "Before we begin, how are you feeling today?" in fresh_instruction
    assert "advance_to_question with next_question_number=1" in fresh_instruction
    assert "The greeting/warm-up is not a planned question" in fresh_instruction
    assert "never scored" in fresh_instruction

    # Resumed session
    q1.status = "asked"
    resume_instruction = build_system_instruction(
        interview=interview,  # type: ignore[arg-type]
        objectives=["Assess backend depth"],
        questions=[q1],  # type: ignore[arg-type]
        candidate={"headline": "Backend Engineer"},
        job_title="Senior Software Engineer",
        remaining=1000,
        candidate_first_name="Ritik",
    )
    assert "This is a reconnection to an interview already in progress." in resume_instruction
    assert "never repeat the warm greeting or ice-breaker" in resume_instruction
    assert "Before we begin, how are you feeling about today?" not in resume_instruction


# ------------------------------------------------------------- documents


def _docx_bytes(text: str) -> bytes:
    import docx

    d = docx.Document()
    for para in text.split("\n"):
        d.add_paragraph(para)
    buf = io.BytesIO()
    d.save(buf)
    return buf.getvalue()


RESUME_TEXT = "\n".join(
    ["Jane Doe - Backend Engineer", "Experience: 4 years building Python APIs with FastAPI and PostgreSQL."]
    + [f"Led project {i}: designed services, improved reliability and mentored engineers." for i in range(8)]
)


def test_rejects_unsupported_type() -> None:
    with pytest.raises(ValidationFailed) as exc:
        document_service.validate_upload("resume.exe", b"MZ...", get_settings())
    assert exc.value.code == "UNSUPPORTED_FILE_TYPE"


def test_rejects_empty_and_oversized() -> None:
    settings = get_settings()
    with pytest.raises(ValidationFailed):
        document_service.validate_upload("cv.pdf", b"", settings)
    with pytest.raises(AppError) as exc:
        document_service.validate_upload("cv.pdf", b"%PDF-" + b"0" * settings.max_upload_bytes, settings)
    assert exc.value.code == "FILE_TOO_LARGE" and exc.value.status_code == 413


def test_rejects_fake_pdf_and_fake_docx() -> None:
    with pytest.raises(ValidationFailed) as exc:
        document_service.validate_upload("cv.pdf", b"not a pdf", get_settings())
    assert exc.value.code == "INVALID_FILE_CONTENT"
    with pytest.raises(ValidationFailed):
        document_service.validate_upload("cv.docx", b"PK\x03\x04garbage", get_settings())


def test_file_name_is_sanitized() -> None:
    f = document_service.validate_upload("../../etc/passwd<>.docx", _docx_bytes(RESUME_TEXT), get_settings())
    assert "/" not in f.file_name and "<" not in f.file_name


async def test_docx_extraction() -> None:
    f = document_service.validate_upload("cv.docx", _docx_bytes(RESUME_TEXT), get_settings())
    text = await document_service.extract_text(f, get_settings())
    assert "FastAPI" in text and "Led project 7" in text


async def test_docx_too_little_text_rejected() -> None:
    f = document_service.validate_upload("cv.docx", _docx_bytes("Hi"), get_settings())
    with pytest.raises(ValidationFailed) as exc:
        await document_service.extract_text(f, get_settings())
    assert exc.value.code == "DOCUMENT_UNREADABLE"


def test_unreadable_symbol_text_rejected() -> None:
    with pytest.raises(ValidationFailed):
        document_service.check_readable("#$%^ 1234 " * 50, get_settings())


async def test_pdf_extraction() -> None:
    fitz = pytest.importorskip("fitz", reason="PyMuPDF not installed in this environment")
    doc = fitz.open()
    page = doc.new_page()
    y = 72
    for line in RESUME_TEXT.split("\n"):
        page.insert_text((72, y), line[:90])
        y += 14
    data = doc.tobytes()
    f = document_service.validate_upload("cv.pdf", data, get_settings())
    text = await document_service.extract_text(f, get_settings())
    assert "FastAPI" in text


def test_correction_validated() -> None:
    ok = document_service.validate_correction("job_description", {"job_title": "Analyst", "seniority": "mid"})
    assert ok["job_title"] == "Analyst"
    with pytest.raises(ValidationFailed):
        document_service.validate_correction("job_description", {"seniority": "galactic"})


# ------------------------------------------------------------- roles


def test_role_detection_clear_single_role() -> None:
    job = JobExtraction(
        job_title="Data Analyst", role_suggestions=[RoleSuggestion(title="Data Analyst", confidence=0.95)]
    )
    result = detect_roles(job)
    assert result.default_role == "Data Analyst" and not result.needs_user_choice


def test_role_detection_ambiguous_asks_user() -> None:
    job = JobExtraction(
        role_suggestions=[
            RoleSuggestion(title="Data Analyst", confidence=0.6),
            RoleSuggestion(title="Data Engineer", confidence=0.55),
        ]
    )
    result = detect_roles(job)
    assert result.default_role is None and result.needs_user_choice and len(result.roles) == 2


def test_role_detection_empty() -> None:
    result = detect_roles(JobExtraction())
    assert result.roles == [] and result.needs_user_choice


# ------------------------------------------------------------- evaluation math


def _answered(qid: str, comp: str, transcript: str = "I built a cache layer") -> AnsweredQuestion:
    return AnsweredQuestion(
        id=qid,
        sequence_number=1,
        question_text="q",
        competency=comp,
        question_type="technical",
        difficulty=3,
        expected_evidence=[],
        answer_source="voice",
        transcript=transcript,
        exchange=[],
        attempt_number=1,
        attempts_total=1,
    )


def _judgement(qid: str, score: int) -> QuestionJudgement:
    return QuestionJudgement(
        question_id=qid, score=score, rationale="Because it was specific.", confidence="high"
    )


def test_rubric_to_percent() -> None:
    assert [to_percent(s) for s in (1, 2, 3, 4, 5)] == [0.0, 25.0, 50.0, 75.0, 100.0]


def test_weighted_overall_score() -> None:
    answered = [_answered("a", "Design"), _answered("b", "Design"), _answered("c", "Coding")]
    judgements = {"a": _judgement("a", 5), "b": _judgement("b", 3), "c": _judgement("c", 2)}
    result = compute_scores(judgements, answered, {"Design": 0.75, "Coding": 0.25}, planned_core=3)
    design = next(c for c in result["competency_scores"] if c["competency"] == "Design")
    assert design["score"] == 75.0  # avg 4 -> 75
    assert result["overall_score"] == pytest.approx(0.75 * 75 + 0.25 * 25)
    assert result["evidence_sufficiency"] == "sufficient"


def test_skipped_questions_excluded_from_denominator() -> None:
    # Only one answered question; skipped ones are simply absent from `answered`.
    result = compute_scores(
        {"a": _judgement("a", 4)}, [_answered("a", "Coding")], {"Coding": 0.5, "Design": 0.5}, planned_core=4
    )
    assert result["overall_score"] == 75.0  # not dragged down by unanswered Design
    design = next(c for c in result["competency_scores"] if c["competency"] == "Design")
    assert design["score"] is None and design["questions_evaluated"] == 0
    assert result["evidence_sufficiency"] == "insufficient"


def test_no_answers_means_no_score() -> None:
    result = compute_scores({}, [], {"Coding": 1.0}, planned_core=3)
    assert result["overall_score"] is None and result["evidence_sufficiency"] == "insufficient"


def test_quote_verification() -> None:
    transcript = "Honestly, I built a Redis cache layer, which cut p95 latency by 40%."
    assert quote_in_transcript("built a Redis cache layer", transcript)
    assert quote_in_transcript("cut P95 latency by 40", transcript)
    assert not quote_in_transcript("led a team of twenty", transcript)


def test_attempt_selection_policy() -> None:
    def att(n: int, selected: bool, skipped: bool = False, text: str = "answer"):
        return SimpleNamespace(
            attempt_number=n, selected_for_evaluation=selected, is_skipped=skipped, transcript_text=text
        )

    assert select_attempt([att(1, False), att(2, True)]).attempt_number == 2
    assert select_attempt([att(1, True), att(2, False)]).attempt_number == 1  # retake abandoned
    assert select_attempt([att(1, False, skipped=True, text="")]) is None
    assert select_attempt([att(1, False), att(2, False, skipped=True, text="")]).attempt_number == 1


# ------------------------------------------------------------- provider errors & logging


@pytest.mark.parametrize(
    ("status", "message", "code", "retryable"),
    [
        (400, "INVALID_ARGUMENT API key not valid", "AI_PROVIDER_AUTH_FAILED", False),
        (403, "PERMISSION_DENIED", "AI_PROVIDER_AUTH_FAILED", False),
        (404, "models/x is not found", "AI_MODEL_UNSUPPORTED", False),
        (
            429,
            "RESOURCE_EXHAUSTED Quota exceeded for quota metric requests per day",
            "AI_PROVIDER_QUOTA_EXHAUSTED",
            False,
        ),
        (429, "RESOURCE_EXHAUSTED rate limit per minute", "AI_PROVIDER_RATE_LIMITED", True),
        (503, "UNAVAILABLE", "AI_PROVIDER_UNAVAILABLE", True),
        (400, "INVALID_ARGUMENT bad field", "AI_PROVIDER_BAD_REQUEST", False),
    ],
)
def test_provider_error_mapping(status: int, message: str, code: str, retryable: bool) -> None:
    err = map_http_error(status, message, "Gemini")
    assert err.code == code and err.retryable is retryable
    assert "AIza" not in err.message


def test_provider_429_maps_to_friendly_error() -> None:
    expected = (
        "Our AI is busy right now. Please try again in a few minutes. Your past reports are still available."
    )
    err1 = map_http_error(429, "Rate limit exceeded", "Gemini")
    assert err1.message == expected
    err2 = map_http_error(429, "Quota exceeded for quota metric requests per day", "Gemini")
    assert err2.message == expected
    err3 = map_http_error(503, "RESOURCE_EXHAUSTED", "Gemini")
    assert err3.message == expected


def test_log_redaction() -> None:
    line = (
        "calling with key=AIzaSyA1234567890abcdefghijklmnop Bearer eyJhbGciOi.eyJzdWIiOi.sig "
        "token auth_tokens/abc123 secret sb_secret_xyz"
    )
    out = redact(line)
    assert "AIzaSyA1234567890" not in out and "eyJzdWIiOi" not in out
    assert "abc123" not in out and "sb_secret_xyz" not in out
