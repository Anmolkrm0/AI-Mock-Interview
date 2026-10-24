"""Integration tests: real FastAPI app + real PostgreSQL (migrated with Alembic).

AI providers and object storage are MOCKED (tests/fakes.py). These tests prove
the backend's state handling, persistence, authorization and recovery logic;
they are not evidence that real Gemini voice integration works.
"""

from __future__ import annotations

import asyncio
import io
import uuid
from datetime import timedelta

import pytest
from sqlalchemy import select, text, update

from app.core.config import get_settings
from app.db.session import get_sessionmaker
from app.models import (
    AIUsage,
    AnswerAttempt,
    Document,
    EvaluationJob,
    Interview,
    InterviewPlan,
    Question,
    Recording,
    Report,
    StorageCleanupTask,
)
from app.providers.base import timeout_error
from app.services import report_service
from app.services.interview_service import now_utc
from app.workers import jobs
from tests.conftest import auth, make_token

pytestmark = pytest.mark.usefixtures("clean_db")

RESUME = "\n".join(
    ["Jane Doe - Backend Engineer", "4 years building Python APIs with FastAPI, PostgreSQL and Docker."]
    + [f"Project {i}: designed services, improved reliability, mentored engineers." for i in range(8)]
)
JD = (
    "Senior Backend Engineer. We are hiring a senior backend engineer to own Python services, "
    "design distributed systems, write SQL, mentor engineers and improve reliability. "
    "Requirements: 4+ years of Python, SQL, distributed systems; Kubernetes is a plus. " * 2
)


def docx_bytes(content: str) -> bytes:
    import docx

    d = docx.Document()
    for line in content.split("\n"):
        d.add_paragraph(line)
    buf = io.BytesIO()
    d.save(buf)
    return buf.getvalue()


DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"


async def upload_docs(client, user):
    r = await client.post(
        "/api/v1/documents/resume",
        headers=auth(user),
        files={"file": ("resume.docx", docx_bytes(RESUME), DOCX_MIME)},
    )
    assert r.status_code == 201, r.text
    resume = r.json()
    r = await client.post("/api/v1/documents/job-description", headers=auth(user), data={"text": JD})
    assert r.status_code == 201, r.text
    return resume, r.json()


async def ready_interview(client, user, *, duration=20, rigor="standard", recording="video", key=None):
    resume, jd = await upload_docs(client, user)
    body = {
        "resume_document_id": resume["id"],
        "job_description_document_id": jd["id"],
        "job_role": "Senior Backend Engineer",
        "duration_minutes": duration,
        "evaluation_rigor": rigor,
        "recording_mode": recording,
        "consent_given": True,
    }
    headers = {**auth(user), "Idempotency-Key": key or uuid.uuid4().hex}
    r = await client.post("/api/v1/interviews", json=body, headers=headers)
    assert r.status_code == 201, r.text
    interview_id = r.json()["id"]
    r = await client.post("/api/v1/interviews/plan", json={"interview_id": interview_id}, headers=auth(user))
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "ready"
    return interview_id, r.json()


def ev(kind: str, **kw) -> dict:
    return {"client_event_id": uuid.uuid4().hex, "event_type": kind, **kw}


async def start(client, user, interview_id):
    r = await client.post(f"/api/v1/interviews/{interview_id}/live-token", headers=auth(user))
    assert r.status_code == 200, r.text
    r = await client.post(
        f"/api/v1/interviews/{interview_id}/events",
        headers=auth(user),
        json={"events": [ev("session_started")]},
    )
    assert r.status_code == 200, r.text
    return r.json()


async def drain_jobs(fakes):
    registry, _ = fakes
    while await report_service.process_one(get_sessionmaker(), registry.evaluation, get_settings()):
        pass


# ------------------------------------------------------------------ auth


async def test_requires_valid_token(client) -> None:
    user = uuid.uuid4()
    assert (await client.get("/api/v1/interviews")).status_code == 401
    expired = make_token(user, expires_in=-120)
    r = await client.get("/api/v1/interviews", headers={"Authorization": f"Bearer {expired}"})
    assert r.status_code == 401 and r.json()["error"]["code"] == "AUTH_EXPIRED"
    forged = make_token(user, secret="attacker-secret-attacker-secret-1234")
    r = await client.get("/api/v1/interviews", headers={"Authorization": f"Bearer {forged}"})
    assert r.status_code == 401 and r.json()["error"]["code"] == "AUTH_INVALID"
    wrong_aud = make_token(user, aud="anon")
    r = await client.get("/api/v1/interviews", headers={"Authorization": f"Bearer {wrong_aud}"})
    assert r.status_code == 401


async def test_empty_history(client) -> None:
    r = await client.get("/api/v1/interviews", headers=auth(uuid.uuid4()))
    assert r.status_code == 200
    assert r.json()["items"] == [] and r.json()["total"] == 0


async def test_health(client) -> None:
    r = await client.get("/api/v1/health")
    body = r.json()
    assert body["database"]["status"] == "ok" and body["database"]["up_to_date"]
    assert "test-jwt-secret" not in r.text


# ------------------------------------------------------------------ documents


async def test_document_upload_and_parse(client, fakes) -> None:
    user = uuid.uuid4()
    resume, jd = await upload_docs(client, user)
    assert resume["parsing_status"] == "parsed" and resume["extracted_data"]["skills"]
    assert jd["extracted_data"]["job_title"] == "Senior Backend Engineer"
    _, storage = fakes
    assert any(k[1].startswith(f"{user}/") for k in storage.objects)  # original stored privately
    r = await client.post(
        "/api/v1/roles/detect", headers=auth(user), json={"job_description_document_id": jd["id"]}
    )
    assert r.json()["default_role"] == "Senior Backend Engineer"


async def test_document_upload_succeeds_when_storage_fails(client, fakes) -> None:
    _, storage = fakes
    storage.fail_upload = True
    user = uuid.uuid4()
    r = await client.post(
        "/api/v1/documents/resume",
        headers=auth(user),
        files={"file": ("resume.docx", docx_bytes(RESUME), DOCX_MIME)},
    )
    assert r.status_code == 201, r.text
    data = r.json()
    assert data["parsing_status"] == "parsed"

    async with get_sessionmaker()() as db:
        doc = (await db.execute(select(Document).where(Document.id == uuid.UUID(data["id"])))).scalar_one()
        assert doc.storage_path is None


async def test_invalid_files_rejected_before_ai(client, fakes) -> None:
    registry, _ = fakes
    user = uuid.uuid4()
    r = await client.post(
        "/api/v1/documents/resume", headers=auth(user), files={"file": ("cv.txt", b"hello", "text/plain")}
    )
    assert r.status_code == 422 and r.json()["error"]["code"] == "UNSUPPORTED_FILE_TYPE"
    big = b"%PDF-" + b"0" * (get_settings().max_upload_bytes + 10)
    r = await client.post(
        "/api/v1/documents/resume", headers=auth(user), files={"file": ("cv.pdf", big, "application/pdf")}
    )
    assert r.status_code == 413
    r = await client.post(
        "/api/v1/documents/resume",
        headers=auth(user),
        files={"file": ("cv.docx", docx_bytes("tiny"), DOCX_MIME)},
    )
    assert r.json()["error"]["code"] == "DOCUMENT_UNREADABLE"
    r = await client.post("/api/v1/documents/job-description", headers=auth(user), data={"text": "short"})
    assert r.json()["error"]["code"] == "DOCUMENT_UNREADABLE"
    assert registry.text.calls == []  # nothing reached the LLM


async def test_parse_failure_then_retry_and_correction(client, fakes) -> None:
    registry, _ = fakes
    user = uuid.uuid4()
    registry.text.queue = [timeout_error()] * 3
    r = await client.post("/api/v1/documents/job-description", headers=auth(user), data={"text": JD})
    assert r.status_code == 504 and r.json()["error"]["retryable"] is True
    doc_id = r.json()["error"]["details"]["document_id"]
    r = await client.get(f"/api/v1/documents/{doc_id}", headers=auth(user))
    assert r.json()["parsing_status"] == "failed"
    r = await client.post(f"/api/v1/documents/{doc_id}/parse", headers=auth(user))
    assert r.status_code == 200 and r.json()["parsing_status"] == "parsed"
    r = await client.patch(
        f"/api/v1/documents/{doc_id}",
        headers=auth(user),
        json={"extracted_data": {"job_title": "Staff Engineer", "seniority": "lead"}},
    )
    assert r.json()["extracted_data"]["job_title"] == "Staff Engineer"


# ------------------------------------------------------------------ interview creation


async def test_create_is_idempotent_and_requires_parsed_docs(client) -> None:
    user = uuid.uuid4()
    resume, jd = await upload_docs(client, user)
    body = {
        "resume_document_id": resume["id"],
        "job_description_document_id": jd["id"],
        "job_role": "Engineer",
        "duration_minutes": 10,
        "evaluation_rigor": "standard",
        "consent_given": True,
    }
    headers = {**auth(user), "Idempotency-Key": "same-key-123"}
    results = await asyncio.gather(
        *[client.post("/api/v1/interviews", json=body, headers=headers) for _ in range(4)]
    )
    ids = {r.json()["id"] for r in results}
    assert len(ids) == 1  # double-clicks create one interview
    assert sorted(r.status_code for r in results).count(201) == 1
    # swapped document types are rejected
    bad = {**body, "resume_document_id": jd["id"], "job_description_document_id": resume["id"]}
    r = await client.post("/api/v1/interviews", json=bad, headers=auth(user))
    assert r.json()["error"]["code"] == "DOCUMENT_TYPE_MISMATCH"


@pytest.mark.parametrize("duration", [10, 20, 30, 45])
async def test_all_durations_plan(client, duration) -> None:
    user = uuid.uuid4()
    _, detail = await ready_interview(client, user, duration=duration)
    core = [q for q in detail["questions"] if q["priority"] == "core"]
    assert len(core) >= 3
    assert detail["duration_minutes"] == duration


@pytest.mark.parametrize("rigor", ["standard", "target_bar", "stress_test"])
async def test_all_rigor_modes_plan(client, rigor) -> None:
    user = uuid.uuid4()
    interview_id, detail = await ready_interview(client, user, rigor=rigor)
    async with get_sessionmaker()() as db:
        plan = (
            await db.execute(
                select(InterviewPlan).where(InterviewPlan.interview_id == uuid.UUID(interview_id))
            )
        ).scalar_one()
    assert plan.plan_json["questions"] and detail["evaluation_rigor"] == rigor


async def test_plan_failure_is_retryable_without_new_interview(client, fakes) -> None:
    registry, _ = fakes
    user = uuid.uuid4()
    resume, jd = await upload_docs(client, user)
    r = await client.post(
        "/api/v1/interviews",
        headers=auth(user),
        json={
            "resume_document_id": resume["id"],
            "job_description_document_id": jd["id"],
            "job_role": "Engineer",
            "duration_minutes": 10,
            "evaluation_rigor": "standard",
            "consent_given": True,
        },
    )
    iid = r.json()["id"]
    registry.text.queue = [timeout_error()] * 3
    r = await client.post("/api/v1/interviews/plan", json={"interview_id": iid}, headers=auth(user))
    assert r.status_code == 504
    status = (await client.get(f"/api/v1/interviews/{iid}/status", headers=auth(user))).json()
    assert status["status"] == "failed" and status["failure_stage"] == "planning"
    r = await client.post("/api/v1/interviews/plan", json={"interview_id": iid}, headers=auth(user))
    assert r.json()["status"] == "ready"
    r = await client.get("/api/v1/interviews", headers=auth(user))
    assert r.json()["total"] == 1


async def test_daily_limit(client) -> None:
    user = uuid.uuid4()
    resume, jd = await upload_docs(client, user)
    body = {
        "resume_document_id": resume["id"],
        "job_description_document_id": jd["id"],
        "job_role": "Engineer",
        "duration_minutes": 10,
        "evaluation_rigor": "standard",
        "consent_given": True,
    }
    for _ in range(get_settings().daily_interview_limit):
        assert (await client.post("/api/v1/interviews", json=body, headers=auth(user))).status_code == 201
    r = await client.post("/api/v1/interviews", json=body, headers=auth(user))
    assert r.status_code == 429 and r.json()["error"]["code"] == "DAILY_INTERVIEW_LIMIT"


# ------------------------------------------------------------------ live session


async def test_full_interview_flow(client, fakes) -> None:
    registry, storage = fakes
    user = uuid.uuid4()
    iid, detail = await ready_interview(client, user)
    q = detail["questions"]

    r = await client.post(f"/api/v1/interviews/{iid}/live-token", headers=auth(user))
    token = r.json()
    assert token["token"].startswith("auth_tokens/") and token["deadline_at"] is None
    setup = registry.live.setups[-1]
    assert "Senior Backend Engineer" in setup.system_instruction
    assert q[0]["question_text"] in setup.system_instruction
    assert {f.name for f in setup.functions} == {"advance_to_question", "end_interview"}

    started = (
        await client.post(
            f"/api/v1/interviews/{iid}/events", headers=auth(user), json={"events": [ev("session_started")]}
        )
    ).json()
    assert started["status"] == "in_progress" and 1190 <= started["remaining_seconds"] <= 1200

    events = [
        ev("question_asked", question_id=q[0]["id"]),
        ev("transcript_segment", speaker="interviewer", text=q[0]["question_text"], question_id=q[0]["id"]),
        ev("transcript_segment", speaker="candidate", text="I built a payments API.", question_id=q[0]["id"]),
        ev(
            "answer_submitted",
            question_id=q[0]["id"],
            answer_source="voice",
            transcript_text="I built a payments API in Python that handled 2k requests per second.",
            exchange=[
                {"speaker": "interviewer", "text": "Follow-up: how did you scale it?"},
                {"speaker": "candidate", "text": "Horizontal scaling and caching."},
            ],
        ),
        ev("answer_retake", question_id=q[0]["id"]),
        ev(
            "answer_submitted",
            question_id=q[0]["id"],
            answer_source="text",
            transcript_text="Second attempt: I designed and owned the payments API end to end.",
        ),
        ev("question_asked", question_id=q[1]["id"]),
        ev("question_skipped", question_id=q[1]["id"]),
        ev("question_asked", question_id=q[2]["id"]),
        ev(
            "answer_submitted",
            question_id=q[2]["id"],
            answer_source="voice",
            transcript_text="For system design I would start from requirements and failure modes.",
        ),
        ev("metric", metric_name="time_to_first_response_ms", metric_value=850),
    ]
    r = await client.post(f"/api/v1/interviews/{iid}/events", headers=auth(user), json={"events": events})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["progress"]["answered"] == 2 and body["progress"]["skipped"] == 1

    # duplicate delivery is idempotent
    r = await client.post(f"/api/v1/interviews/{iid}/events", headers=auth(user), json={"events": events[:2]})
    assert all(x["duplicate"] for x in r.json()["results"])

    # retake preserved both attempts; latest selected; no duplicate question
    async with get_sessionmaker()() as db:
        attempts = list(
            (
                await db.execute(
                    select(AnswerAttempt)
                    .where(AnswerAttempt.question_id == uuid.UUID(q[0]["id"]))
                    .order_by(AnswerAttempt.attempt_number)
                )
            ).scalars()
        )
        assert [a.attempt_number for a in attempts] == [1, 2]
        assert [a.selected_for_evaluation for a in attempts] == [False, True]
        assert attempts[0].exchange[0]["text"].startswith("Follow-up")
        skipped = (
            await db.execute(select(AnswerAttempt).where(AnswerAttempt.question_id == uuid.UUID(q[1]["id"])))
        ).scalar_one()
        assert skipped.is_skipped and not skipped.selected_for_evaluation
        qcount = (
            (await db.execute(select(Question).where(Question.interview_id == uuid.UUID(iid))))
            .scalars()
            .all()
        )
        assert len(qcount) == len(q)

    # answering an already-answered question without retake is refused
    r = await client.post(
        f"/api/v1/interviews/{iid}/events",
        headers=auth(user),
        json={
            "events": [
                ev("answer_submitted", question_id=q[2]["id"], answer_source="text", transcript_text="again")
            ]
        },
    )
    assert r.json()["error"]["code"] == "ANSWER_ALREADY_RECORDED"

    # refresh: transcript and timer survive
    detail = (await client.get(f"/api/v1/interviews/{iid}", headers=auth(user))).json()
    assert len(detail["transcript"]) == 2 and detail["deadline_at"] is not None
    deadline = detail["deadline_at"]
    r = await client.post(f"/api/v1/interviews/{iid}/live-token", headers=auth(user))  # reconnect
    assert r.json()["deadline_at"] == deadline  # timer not reset
    assert "reconnection" in registry.live.setups[-1].system_instruction
    assert "skipped by candidate" in registry.live.setups[-1].system_instruction

    # complete twice -> idempotent
    r1 = await client.post(
        f"/api/v1/interviews/{iid}/complete", headers=auth(user), json={"reason": "user_ended"}
    )
    r2 = await client.post(f"/api/v1/interviews/{iid}/complete", headers=auth(user))
    assert r1.json()["status"] == r2.json()["status"] == "evaluating"
    async with get_sessionmaker()() as db:
        assert len((await db.execute(select(EvaluationJob))).scalars().all()) == 1

    # cannot restart a finished interview
    r = await client.post(f"/api/v1/interviews/{iid}/live-token", headers=auth(user))
    assert r.json()["error"]["code"] == "INTERVIEW_NOT_JOINABLE"

    await drain_jobs(fakes)
    report = (await client.get(f"/api/v1/interviews/{iid}/report", headers=auth(user))).json()
    assert report["report_status"] == "completed"
    assert report["overall_score"] == 75.0  # fake scores 4 -> 75
    assert len(report["question_evaluations"]) == 2
    q1 = report["question_evaluations"][0]
    assert q1["answer_transcript"].startswith("Second attempt") and q1["attempts_total"] == 2
    verified = [e["verified"] for e in q1["evidence"]]
    assert verified == [True, False]  # invented quote is flagged
    reasons = {u["reason"] for u in report["unevaluated_questions"]}
    assert "skipped" in reasons
    status = (await client.get(f"/api/v1/interviews/{iid}/status", headers=auth(user))).json()
    assert status["status"] == "completed"

    r = await client.post(
        f"/api/v1/interviews/{iid}/feedback",
        headers=auth(user),
        json={"rating": 5, "comments": "Very useful"},
    )
    assert r.status_code == 200
    r = await client.post(f"/api/v1/interviews/{iid}/feedback", headers=auth(user), json={"rating": 4})
    assert r.json()["rating"] == 4  # updated, not duplicated
    r = await client.post(f"/api/v1/interviews/{iid}/feedback", headers=auth(user), json={"rating": 9})
    assert r.status_code == 422

    history = (await client.get("/api/v1/interviews", headers=auth(user))).json()
    assert history["items"][0]["overall_score"] == 75.0

    async with get_sessionmaker()() as db:
        usage = (await db.execute(select(AIUsage))).scalars().all()
        assert {u.operation for u in usage} >= {"parse_resume", "plan_interview", "evaluate_interview"}


async def test_report_and_dashboard_work_when_ai_provider_down(client, fakes) -> None:
    registry, _ = fakes
    user = uuid.uuid4()
    iid, detail = await ready_interview(client, user)
    q = detail["questions"]
    await client.post(f"/api/v1/interviews/{iid}/live-token", headers=auth(user))
    await client.post(
        f"/api/v1/interviews/{iid}/events",
        headers=auth(user),
        json={"events": [{"client_event_id": str(uuid.uuid4()), "event_type": "session_started"}]},
    )
    await client.post(
        f"/api/v1/interviews/{iid}/events",
        headers=auth(user),
        json={
            "events": [
                {
                    "client_event_id": str(uuid.uuid4()),
                    "event_type": "answer_submitted",
                    "question_id": q[0]["id"],
                    "answer_source": "voice",
                    "transcript_text": "I built a payments API in Python.",
                }
            ]
        },
    )
    await client.post(f"/api/v1/interviews/{iid}/complete", headers=auth(user), json={"reason": "user_ended"})
    await drain_jobs(fakes)

    # Disable AI providers
    registry.text.configured = False
    registry.live.configured = False

    try:
        rep = await client.get(f"/api/v1/interviews/{iid}/report", headers=auth(user))
        assert rep.status_code == 200
        assert rep.json()["report_status"] == "completed"

        dash = await client.get("/api/v1/interviews", headers=auth(user))
        assert dash.status_code == 200
        items = dash.json()["items"]
        assert len(items) >= 1
        assert items[0]["id"] == str(iid)
        assert items[0]["overall_score"] is not None
        assert items[0]["report_status"] == "completed"
    finally:
        registry.text.configured = True
        registry.live.configured = True


async def test_user_isolation(client) -> None:
    owner, intruder = uuid.uuid4(), uuid.uuid4()
    iid, detail = await ready_interview(client, owner)
    paths = [
        ("get", f"/api/v1/interviews/{iid}"),
        ("get", f"/api/v1/interviews/{iid}/status"),
        ("get", f"/api/v1/interviews/{iid}/report"),
        ("post", f"/api/v1/interviews/{iid}/live-token"),
        ("post", f"/api/v1/interviews/{iid}/complete"),
        ("get", f"/api/v1/interviews/{iid}/recording-url"),
    ]
    for method, path in paths:
        r = await getattr(client, method)(path, headers=auth(intruder))
        assert r.status_code == 404, path
    r = await client.post(
        f"/api/v1/interviews/{iid}/events", headers=auth(intruder), json={"events": [ev("session_started")]}
    )
    assert r.status_code == 404
    r = await client.post(f"/api/v1/interviews/{iid}/feedback", headers=auth(intruder), json={"rating": 1})
    assert r.status_code == 404
    r = await client.post(
        "/api/v1/recordings/upload-url",
        headers=auth(intruder),
        json={"interview_id": iid, "mime_type": "video/webm", "size_bytes": 10, "duration_seconds": 5},
    )
    assert r.status_code == 404
    assert (await client.get("/api/v1/interviews", headers=auth(intruder))).json()["total"] == 0
    # documents belonging to someone else can't be used either
    owner_docs = detail  # noqa: F841
    async with get_sessionmaker()() as db:
        doc_id = (await db.execute(text("select id from documents limit 1"))).scalar_one()
    assert (await client.get(f"/api/v1/documents/{doc_id}", headers=auth(intruder))).status_code == 404


async def test_events_rejected_after_deadline_and_auto_finalize(client, fakes) -> None:
    user = uuid.uuid4()
    iid, detail = await ready_interview(client, user, duration=10)
    await start(client, user, iid)
    q = detail["questions"]
    await client.post(
        f"/api/v1/interviews/{iid}/events",
        headers=auth(user),
        json={
            "events": [
                ev(
                    "answer_submitted",
                    question_id=q[0]["id"],
                    answer_source="text",
                    transcript_text="An answer given before time ran out.",
                )
            ]
        },
    )
    async with get_sessionmaker()() as db:
        await db.execute(
            update(Interview)
            .where(Interview.id == uuid.UUID(iid))
            .values(
                started_at=now_utc() - timedelta(minutes=20), deadline_at=now_utc() - timedelta(minutes=10)
            )
        )
        await db.commit()
    r = await client.post(
        f"/api/v1/interviews/{iid}/events",
        headers=auth(user),
        json={"events": [ev("question_skipped", question_id=q[1]["id"])]},
    )
    assert r.json()["error"]["code"] == "INTERVIEW_TIME_EXPIRED"
    r = await client.post(f"/api/v1/interviews/{iid}/live-token", headers=auth(user))
    assert r.json()["error"]["code"] == "INTERVIEW_TIME_EXPIRED"
    async with get_sessionmaker()() as db:
        assert await jobs.finalize_abandoned(db, get_settings()) == 1
    await drain_jobs(fakes)
    assert (await client.get(f"/api/v1/interviews/{iid}/status", headers=auth(user))).json()[
        "status"
    ] == "completed"


async def test_end_before_any_answer_cancels(client) -> None:
    user = uuid.uuid4()
    iid, _ = await ready_interview(client, user)
    await client.post(f"/api/v1/interviews/{iid}/live-token", headers=auth(user))
    r = await client.post(f"/api/v1/interviews/{iid}/complete", headers=auth(user))
    assert r.json()["status"] == "cancelled"
    assert (await client.get("/api/v1/interviews", headers=auth(user))).json()["total"] == 0


async def test_one_active_interview_per_user(client) -> None:
    user = uuid.uuid4()
    first, _ = await ready_interview(client, user)
    second, _ = await ready_interview(client, user)
    await start(client, user, first)
    r = await client.post(f"/api/v1/interviews/{second}/live-token", headers=auth(user))
    assert r.json()["error"]["code"] == "ACTIVE_INTERVIEW_EXISTS"


# ------------------------------------------------------------------ evaluation recovery


async def test_evaluation_retries_then_fails_then_manual_retry(client, fakes) -> None:
    registry, _ = fakes
    user = uuid.uuid4()
    iid, detail = await ready_interview(client, user)
    await start(client, user, iid)
    q = detail["questions"]
    await client.post(
        f"/api/v1/interviews/{iid}/events",
        headers=auth(user),
        json={
            "events": [
                ev(
                    "answer_submitted",
                    question_id=q[0]["id"],
                    answer_source="voice",
                    transcript_text="I led the migration of our monolith to services.",
                )
            ]
        },
    )
    await client.post(f"/api/v1/interviews/{iid}/complete", headers=auth(user))
    registry.evaluation.queue = [timeout_error()] * 20  # every attempt times out
    for _ in range(get_settings().job_max_attempts):
        async with get_sessionmaker()() as db:
            await db.execute(update(EvaluationJob).values(next_run_at=now_utc()))
            await db.commit()
        await drain_jobs(fakes)
    status = (await client.get(f"/api/v1/interviews/{iid}/status", headers=auth(user))).json()
    assert status["status"] == "failed" and status["failure_stage"] == "evaluation"
    assert status["report_status"] == "failed"
    # transcript still preserved
    detail = (await client.get(f"/api/v1/interviews/{iid}", headers=auth(user))).json()
    assert detail["attempts"][q[0]["id"]][0]["transcript_text"].startswith("I led")

    registry.evaluation.queue = []
    r = await client.post(f"/api/v1/interviews/{iid}/retry-evaluation", headers=auth(user))
    assert r.json()["status"] == "evaluating"
    await drain_jobs(fakes)
    report = (await client.get(f"/api/v1/interviews/{iid}/report", headers=auth(user))).json()
    assert report["report_status"] == "completed"


async def test_invalid_evaluation_output_is_retried(client, fakes) -> None:
    registry, _ = fakes
    user = uuid.uuid4()
    iid, detail = await ready_interview(client, user)
    await start(client, user, iid)
    q = detail["questions"]
    await client.post(
        f"/api/v1/interviews/{iid}/events",
        headers=auth(user),
        json={
            "events": [
                ev(
                    "answer_submitted",
                    question_id=q[0]["id"],
                    answer_source="voice",
                    transcript_text="I improved query latency with indexes.",
                )
            ]
        },
    )
    await client.post(f"/api/v1/interviews/{iid}/complete", headers=auth(user))
    registry.evaluation.queue = [
        {
            "judgements": [
                {"question_id": q[0]["id"], "score": 11, "rationale": "x" * 20, "confidence": "high"}
            ],
            "summary": "bad score out of range",
        },
    ]
    await drain_jobs(fakes)
    report = (await client.get(f"/api/v1/interviews/{iid}/report", headers=auth(user))).json()
    assert report["report_status"] == "completed"
    assert 0 <= report["overall_score"] <= 100
    assert registry.evaluation.calls == 2


async def test_lease_expiry_recovers_after_restart(client, fakes) -> None:
    user = uuid.uuid4()
    iid, detail = await ready_interview(client, user)
    await start(client, user, iid)
    q = detail["questions"]
    await client.post(
        f"/api/v1/interviews/{iid}/events",
        headers=auth(user),
        json={
            "events": [
                ev(
                    "answer_submitted",
                    question_id=q[0]["id"],
                    answer_source="voice",
                    transcript_text="An answer.",
                )
            ]
        },
    )
    await client.post(f"/api/v1/interviews/{iid}/complete", headers=auth(user))
    # simulate a crash: job claimed (running) but the process died
    async with get_sessionmaker()() as db:
        claimed = await report_service.claim_job(db, get_settings())
        assert claimed is not None
    async with get_sessionmaker()() as db:
        assert await report_service.claim_job(db, get_settings()) is None  # still leased
        await db.execute(update(EvaluationJob).values(locked_until=now_utc() - timedelta(seconds=1)))
        await db.commit()
    await drain_jobs(fakes)
    assert (await client.get(f"/api/v1/interviews/{iid}/status", headers=auth(user))).json()[
        "status"
    ] == "completed"


# ------------------------------------------------------------------ recordings


async def upload_recording(client, storage, user, iid, size=1000, mime="video/webm"):
    r = await client.post(
        "/api/v1/recordings/upload-url",
        headers=auth(user),
        json={
            "interview_id": iid,
            "mime_type": f"{mime};codecs=vp8,opus",
            "size_bytes": size,
            "duration_seconds": 60,
        },
    )
    assert r.status_code == 200, r.text
    slot = r.json()
    assert slot["path"].startswith(f"{user}/{iid}/")
    storage.browser_upload(slot["bucket"], slot["path"], size, mime)
    return slot


async def test_recording_replacement_keeps_reports(client, fakes) -> None:
    _, storage = fakes
    user = uuid.uuid4()
    first, d1 = await ready_interview(client, user)
    await start(client, user, first)
    slot1 = await upload_recording(client, storage, user, first)
    r = await client.post(
        "/api/v1/recordings/confirm", headers=auth(user), json={"upload_id": slot1["upload_id"]}
    )
    assert r.status_code == 200
    r = await client.post(
        "/api/v1/recordings/confirm", headers=auth(user), json={"upload_id": slot1["upload_id"]}
    )
    assert r.status_code == 200  # idempotent
    await client.post(
        f"/api/v1/interviews/{first}/events",
        headers=auth(user),
        json={
            "events": [
                ev(
                    "answer_submitted",
                    question_id=d1["questions"][0]["id"],
                    answer_source="text",
                    transcript_text="First interview answer.",
                )
            ]
        },
    )
    await client.post(f"/api/v1/interviews/{first}/complete", headers=auth(user))
    await drain_jobs(fakes)

    second, _ = await ready_interview(client, user)
    await start(client, user, second)
    slot2 = await upload_recording(client, storage, user, second, size=2000)

    # a failed/unfinished upload must not affect the current recording
    failed = await client.post(
        "/api/v1/recordings/upload-url",
        headers=auth(user),
        json={"interview_id": second, "mime_type": "video/webm", "size_bytes": 50, "duration_seconds": 5},
    )
    r = await client.post(
        "/api/v1/recordings/confirm", headers=auth(user), json={"upload_id": failed.json()["upload_id"]}
    )
    assert r.json()["error"]["code"] == "RECORDING_NOT_UPLOADED"
    assert (await client.get("/api/v1/recordings/latest", headers=auth(user))).json()["interview_id"] == first

    r = await client.post(
        "/api/v1/recordings/confirm", headers=auth(user), json={"upload_id": slot2["upload_id"]}
    )
    assert r.json()["interview_id"] == second
    bucket = get_settings().recordings_bucket
    assert (bucket, slot1["path"]) not in storage.objects  # old deleted after swap
    assert (bucket, slot2["path"]) in storage.objects
    # previous report still available
    report = (await client.get(f"/api/v1/interviews/{first}/report", headers=auth(user))).json()
    assert report["report_status"] == "completed"
    # playback only for the interview that owns the current recording
    assert (
        await client.get(f"/api/v1/interviews/{first}/recording-url", headers=auth(user))
    ).status_code == 404
    r = await client.get(f"/api/v1/interviews/{second}/recording-url", headers=auth(user))
    assert r.status_code == 200 and r.json()["expires_in_seconds"] <= 600
    history = (await client.get("/api/v1/interviews", headers=auth(user))).json()
    assert history["current_recording_interview_id"] == second
    async with get_sessionmaker()() as db:
        assert len((await db.execute(select(Recording))).scalars().all()) == 1

    r = await client.delete("/api/v1/recordings/latest", headers=auth(user))
    assert r.status_code == 204 and (bucket, slot2["path"]) not in storage.objects
    assert (await client.get("/api/v1/recordings/latest", headers=auth(user))).status_code == 404


async def test_recording_verification_and_limits(client, fakes) -> None:
    _, storage = fakes
    user = uuid.uuid4()
    iid, _ = await ready_interview(client, user, recording="audio")
    await start(client, user, iid)
    r = await client.post(
        "/api/v1/recordings/upload-url",
        headers=auth(user),
        json={"interview_id": iid, "mime_type": "video/webm", "size_bytes": 10, "duration_seconds": 5},
    )
    assert r.json()["error"]["code"] == "RECORDING_TYPE_MISMATCH"
    r = await client.post(
        "/api/v1/recordings/upload-url",
        headers=auth(user),
        json={
            "interview_id": iid,
            "mime_type": "audio/webm",
            "size_bytes": 60 * 1024 * 1024,
            "duration_seconds": 5,
        },
    )
    assert r.status_code == 413
    r = await client.post(
        "/api/v1/recordings/upload-url",
        headers=auth(user),
        json={"interview_id": iid, "mime_type": "application/x-sh", "size_bytes": 10, "duration_seconds": 5},
    )
    assert r.json()["error"]["code"] == "RECORDING_TYPE_UNSUPPORTED"
    r = await client.post(
        "/api/v1/recordings/upload-url",
        headers=auth(user),
        json={"interview_id": iid, "mime_type": "audio/webm", "size_bytes": 500, "duration_seconds": 30},
    )
    slot = r.json()
    storage.browser_upload(slot["bucket"], slot["path"], 499, "audio/webm")  # truncated upload
    r = await client.post(
        "/api/v1/recordings/confirm", headers=auth(user), json={"upload_id": slot["upload_id"]}
    )
    assert r.json()["error"]["code"] == "RECORDING_VERIFICATION_FAILED"
    assert (await client.get("/api/v1/recordings/latest", headers=auth(user))).status_code == 404


async def test_old_recording_delete_failure_is_retried_later(client, fakes) -> None:
    _, storage = fakes
    user = uuid.uuid4()
    a, _ = await ready_interview(client, user)
    await start(client, user, a)
    s1 = await upload_recording(client, storage, user, a)
    await client.post("/api/v1/recordings/confirm", headers=auth(user), json={"upload_id": s1["upload_id"]})
    s2 = await upload_recording(client, storage, user, a, size=1500)
    storage.fail_delete = True
    r = await client.post(
        "/api/v1/recordings/confirm", headers=auth(user), json={"upload_id": s2["upload_id"]}
    )
    assert r.status_code == 200 and r.json()["file_size_bytes"] == 1500  # swap still succeeded
    bucket = get_settings().recordings_bucket
    assert (bucket, s1["path"]) in storage.objects
    async with get_sessionmaker()() as db:
        task = (await db.execute(select(StorageCleanupTask))).scalar_one()
        assert task.status == "pending" and task.attempts == 1
        await db.execute(update(StorageCleanupTask).values(next_run_at=now_utc()))
        await db.commit()
    storage.fail_delete = False
    async with get_sessionmaker()() as db:
        await jobs.run_cleanups(db, storage)
    assert (bucket, s1["path"]) not in storage.objects


async def test_error_shape_has_no_internals(client) -> None:
    r = await client.get(f"/api/v1/interviews/{uuid.uuid4()}", headers=auth(uuid.uuid4()))
    err = r.json()["error"]
    assert set(err) >= {"code", "message", "retryable", "request_id"}
    assert "Traceback" not in r.text and "sqlalchemy" not in r.text.lower()
    r = await client.get("/api/v1/interviews/not-a-uuid", headers=auth(uuid.uuid4()))
    assert r.status_code == 422 and r.json()["error"]["code"] == "VALIDATION_FAILED"


# ------------------------------------------------------------------ frontend contract


async def test_frontend_conductor_event_stream_is_accepted(client, fakes) -> None:
    """Replay the exact event stream produced by the frontend InterviewConductor
    (captured from frontend/tests/unit/conductor.test.ts) against the real backend."""
    import json
    from pathlib import Path

    stream = json.loads((Path(__file__).parent / "fixtures_conductor_events.json").read_text())
    user = uuid.uuid4()
    iid, detail = await ready_interview(client, user)
    ids = {f"q{q['sequence_number']}": q["id"] for q in detail["questions"]}
    r = await client.post(f"/api/v1/interviews/{iid}/live-token", headers=auth(user))
    assert r.status_code == 200
    for event in stream:
        if event.get("question_id"):
            event["question_id"] = ids[event["question_id"]]
        r = await client.post(
            f"/api/v1/interviews/{iid}/events", headers=auth(user), json={"events": [event]}
        )
        assert r.status_code == 200, (event["event_type"], r.text)
    r = await client.post(
        f"/api/v1/interviews/{iid}/complete", headers=auth(user), json={"reason": "user_ended"}
    )
    assert r.json()["status"] == "evaluating"
    await drain_jobs(fakes)
    report = (await client.get(f"/api/v1/interviews/{iid}/report", headers=auth(user))).json()
    scored = {q["sequence_number"]: q for q in report["question_evaluations"]}
    assert set(scored) == {1, 3}
    assert scored[3]["answer_transcript"] == "Second try, much clearer." and scored[3]["attempts_total"] == 2
    assert any(
        u["reason"] == "skipped" and u["sequence_number"] == 2 for u in report["unevaluated_questions"]
    )


# ------------------------------------------------------------------ admin feedback tests


async def test_admin_feedback_access_control(client, monkeypatch) -> None:
    admin_email = "admin@example.com"
    monkeypatch.setattr(get_settings(), "admin_emails", [admin_email])

    admin_user = uuid.uuid4()
    regular_user = uuid.uuid4()

    # 1. Unauthenticated -> 401
    r = await client.get("/api/v1/admin/feedback")
    assert r.status_code == 401
    r = await client.get("/api/v1/admin/feedback/summary")
    assert r.status_code == 401

    # 2. Regular authenticated user (not in admin_emails) -> 404 (does NOT reveal admin routes exist)
    reg_token = make_token(regular_user, email="user@example.com", email_verified=True)
    r = await client.get("/api/v1/admin/feedback", headers={"Authorization": f"Bearer {reg_token}"})
    assert r.status_code == 404
    r = await client.get("/api/v1/admin/feedback/summary", headers={"Authorization": f"Bearer {reg_token}"})
    assert r.status_code == 404

    # 3. Email in admin_emails but unverified -> 404
    unverified_token = make_token(admin_user, email=admin_email, email_verified=False)
    r = await client.get("/api/v1/admin/feedback", headers={"Authorization": f"Bearer {unverified_token}"})
    assert r.status_code == 404
    r = await client.get(
        "/api/v1/admin/feedback/summary", headers={"Authorization": f"Bearer {unverified_token}"}
    )
    assert r.status_code == 404

    # 4. Verified admin (top-level claim) -> 200
    verified_token = make_token(admin_user, email=admin_email, email_verified=True)
    r = await client.get("/api/v1/admin/feedback", headers={"Authorization": f"Bearer {verified_token}"})
    assert r.status_code == 200
    r = await client.get(
        "/api/v1/admin/feedback/summary", headers={"Authorization": f"Bearer {verified_token}"}
    )
    assert r.status_code == 200

    # 5. Verified admin (user_metadata claim, case-insensitive email) -> 200
    meta_token = make_token(admin_user, email="Admin@Example.COM", user_metadata={"email_verified": True})
    r = await client.get("/api/v1/admin/feedback", headers={"Authorization": f"Bearer {meta_token}"})
    assert r.status_code == 200


async def test_admin_feedback_listing_filtering_and_summary(client, monkeypatch) -> None:
    admin_email = "owner@example.com"
    monkeypatch.setattr(get_settings(), "admin_emails", [admin_email])
    admin_user = uuid.uuid4()
    admin_headers = {
        "Authorization": f"Bearer {make_token(admin_user, email=admin_email, email_verified=True)}"
    }

    user1 = uuid.uuid4()
    user2 = uuid.uuid4()

    iid1, _ = await ready_interview(client, user1, duration=20, rigor="standard")
    iid2, _ = await ready_interview(client, user2, duration=30, rigor="target_bar")

    # User 1 submits 5-star with comment
    r1 = await client.post(
        f"/api/v1/interviews/{iid1}/feedback",
        headers=auth(user1),
        json={"rating": 5, "comments": "Excellent experience"},
    )
    assert r1.status_code == 200

    # User 2 submits 2-star without comment
    r2 = await client.post(
        f"/api/v1/interviews/{iid2}/feedback",
        headers=auth(user2),
        json={"rating": 2, "comments": ""},
    )
    assert r2.status_code == 200

    # Admin lists feedback
    list_res = await client.get("/api/v1/admin/feedback", headers=admin_headers)
    assert list_res.status_code == 200
    data = list_res.json()
    assert data["total"] == 2
    assert len(data["items"]) == 2
    # Newest first
    assert data["items"][0]["interview_id"] == str(iid2)
    assert data["items"][0]["rating"] == 2
    assert data["items"][0]["comments"] is None or data["items"][0]["comments"] == ""
    assert data["items"][0]["duration_minutes"] == 30
    assert data["items"][0]["evaluation_rigor"] == "target_bar"

    assert data["items"][1]["interview_id"] == str(iid1)
    assert data["items"][1]["rating"] == 5
    assert data["items"][1]["comments"] == "Excellent experience"
    assert data["items"][1]["duration_minutes"] == 20
    assert data["items"][1]["evaluation_rigor"] == "standard"

    # Filter by rating=5
    r_filter = await client.get("/api/v1/admin/feedback?rating=5", headers=admin_headers)
    assert r_filter.status_code == 200
    assert r_filter.json()["total"] == 1
    assert r_filter.json()["items"][0]["interview_id"] == str(iid1)

    # Filter by rating=2
    r_filter2 = await client.get("/api/v1/admin/feedback?rating=2", headers=admin_headers)
    assert r_filter2.status_code == 200
    assert r_filter2.json()["total"] == 1
    assert r_filter2.json()["items"][0]["interview_id"] == str(iid2)

    # Filter by has_comments=true
    r_comments = await client.get("/api/v1/admin/feedback?has_comments=true", headers=admin_headers)
    assert r_comments.status_code == 200
    assert r_comments.json()["total"] == 1
    assert r_comments.json()["items"][0]["interview_id"] == str(iid1)

    # Filter by has_comments=false
    r_no_comments = await client.get("/api/v1/admin/feedback?has_comments=false", headers=admin_headers)
    assert r_no_comments.status_code == 200
    assert r_no_comments.json()["total"] == 1
    assert r_no_comments.json()["items"][0]["interview_id"] == str(iid2)

    # Admin summary
    summary_res = await client.get("/api/v1/admin/feedback/summary", headers=admin_headers)
    assert summary_res.status_code == 200
    s_data = summary_res.json()
    assert s_data["total_responses"] == 2
    assert s_data["average_rating"] == 3.5
    assert s_data["last_7_days"] == 2
    assert s_data["with_comments"] == 1
    counts = s_data["rating_counts"]
    assert counts.get("1", counts.get(1)) == 0
    assert counts.get("2", counts.get(2)) == 1
    assert counts.get("5", counts.get(5)) == 1


async def test_admin_me_and_access_control(client, monkeypatch) -> None:
    admin_email = "owner@example.com"
    monkeypatch.setattr(get_settings(), "admin_emails", [admin_email])

    admin_user = uuid.uuid4()
    regular_user = uuid.uuid4()

    admin_endpoints = [
        "/api/v1/admin/me",
        "/api/v1/admin/overview",
        "/api/v1/admin/users",
        f"/api/v1/admin/users/{regular_user}",
        "/api/v1/admin/interviews",
        "/api/v1/admin/feedback",
        "/api/v1/admin/feedback/summary",
    ]

    # 1. Unauthenticated -> 401
    for ep in admin_endpoints:
        r = await client.get(ep)
        assert r.status_code == 401, f"{ep} did not return 401 for unauthenticated"

    # 2. Regular user -> 404 (don't reveal route exists)
    reg_token = make_token(regular_user, email="candidate@example.com", email_verified=True)
    for ep in admin_endpoints:
        r = await client.get(ep, headers={"Authorization": f"Bearer {reg_token}"})
        assert r.status_code == 404, f"{ep} did not return 404 for non-admin"

    # 3. Unverified admin email -> 404
    unverified_token = make_token(admin_user, email=admin_email, email_verified=False)
    for ep in admin_endpoints:
        r = await client.get(ep, headers={"Authorization": f"Bearer {unverified_token}"})
        assert r.status_code == 404, f"{ep} did not return 404 for unverified admin"

    # 4. Verified admin -> 200
    verified_token = make_token(admin_user, email=admin_email, email_verified=True)
    headers = {"Authorization": f"Bearer {verified_token}"}
    r_me = await client.get("/api/v1/admin/me", headers=headers)
    assert r_me.status_code == 200
    assert r_me.json() == {"admin": True}

    r_overview = await client.get("/api/v1/admin/overview", headers=headers)
    assert r_overview.status_code == 200

    r_users = await client.get("/api/v1/admin/users", headers=headers)
    assert r_users.status_code == 200

    r_interviews = await client.get("/api/v1/admin/interviews", headers=headers)
    assert r_interviews.status_code == 200


async def test_admin_dashboard_full_aggregates_and_privacy(client, monkeypatch) -> None:
    admin_email = "superadmin@example.com"
    monkeypatch.setattr(get_settings(), "admin_emails", [admin_email])
    admin_user = uuid.uuid4()
    admin_headers = {
        "Authorization": f"Bearer {make_token(admin_user, email=admin_email, email_verified=True)}"
    }

    user1 = uuid.uuid4()
    user2 = uuid.uuid4()

    # User 1 interview (completed with evaluation and feedback)
    iid1, _ = await ready_interview(client, user1, duration=20, rigor="standard")
    async with get_sessionmaker()() as session:
        await session.execute(
            update(Interview)
            .where(Interview.id == iid1)
            .values(
                status="completed",
                started_at=now_utc(),
                completed_at=now_utc(),
            )
        )
        session.add(
            Report(
                id=uuid.uuid4(),
                interview_id=iid1,
                overall_score=85.0,
                report_status="completed",
            )
        )
        # Get existing question generated by ready_interview
        res = await session.execute(
            select(Question).where(Question.interview_id == iid1).order_by(Question.sequence_number).limit(1)
        )
        q = res.scalars().first()
        assert q is not None
        session.add(
            AnswerAttempt(
                id=uuid.uuid4(),
                question_id=q.id,
                attempt_number=1,
                answer_source="voice",
                transcript_text="I investigated a subtle race condition in production.",
                selected_for_evaluation=True,
            )
        )
        # Add AI Usage
        session.add(
            AIUsage(
                id=uuid.uuid4(),
                interview_id=iid1,
                operation="conduct_turn",
                provider="gemini",
                model="gemini-2.5-flash",
                input_tokens=150,
                output_tokens=80,
                latency_ms=650,
                success=True,
                error_code=None,
            )
        )
        session.add(
            AIUsage(
                id=uuid.uuid4(),
                interview_id=iid1,
                operation="conduct_turn",
                provider="gemini",
                model="gemini-2.5-flash",
                input_tokens=150,
                output_tokens=0,
                latency_ms=1200,
                success=False,
                error_code="RATE_LIMIT",
            )
        )
        await session.commit()

    # Submit feedback for interview 1
    r_fb = await client.post(
        f"/api/v1/interviews/{iid1}/feedback",
        headers=auth(user1),
        json={"rating": 5, "comments": "Very helpful practice!"},
    )
    assert r_fb.status_code == 200

    # User 2 interview (started / in_progress)
    iid2, _ = await ready_interview(client, user2, duration=30, rigor="target_bar")
    async with get_sessionmaker()() as session:
        await session.execute(
            update(Interview)
            .where(Interview.id == iid2)
            .values(
                status="in_progress",
                started_at=now_utc(),
            )
        )
        await session.commit()

    # 1. Test /admin/overview
    r_ov = await client.get("/api/v1/admin/overview?days=30", headers=admin_headers)
    assert r_ov.status_code == 200
    ov = r_ov.json()

    assert ov["interviews"]["started"] >= 2
    assert ov["interviews"]["completed"] >= 1
    assert ov["interviews"]["completion_rate"] == 50.0
    assert ov["averages"]["overall_score"] == 85.0
    assert ov["feedback"]["count"] >= 1
    assert ov["feedback"]["average_rating"] == 5.0
    assert ov["breakdowns"]["by_rigor"]["standard"] >= 1
    assert ov["breakdowns"]["by_rigor"]["target_bar"] >= 1
    assert ov["breakdowns"]["by_duration"]["20"] >= 1
    assert ov["breakdowns"]["by_duration"]["30"] >= 1
    assert len(ov["daily_series"]) == 30

    # Health metrics
    assert len(ov["health"]["ai_usage"]) >= 1
    assert any(u["operation"] == "conduct_turn" for u in ov["health"]["ai_usage"])
    assert any(ec["error_code"] == "RATE_LIMIT" for ec in ov["health"]["top_error_codes"])

    # 2. Test /admin/users
    r_users = await client.get("/api/v1/admin/users?limit=10&offset=0", headers=admin_headers)
    assert r_users.status_code == 200
    u_data = r_users.json()
    assert u_data["total"] >= 2
    user_ids = [u["user_id"] for u in u_data["items"]]
    assert str(user1) in user_ids
    assert str(user2) in user_ids

    # 3. Test /admin/users/{user_id}
    r_u1 = await client.get(f"/api/v1/admin/users/{user1}", headers=admin_headers)
    assert r_u1.status_code == 200
    u1_detail = r_u1.json()
    assert u1_detail["user_id"] == str(user1)
    assert u1_detail["interviews_total"] == 1
    assert u1_detail["interviews_completed"] == 1
    assert u1_detail["average_score"] == 85.0
    assert len(u1_detail["interviews"]) == 1
    assert u1_detail["interviews"][0]["id"] == str(iid1)
    assert u1_detail["interviews"][0]["feedback_rating"] == 5
    assert u1_detail["interviews"][0]["feedback_comments"] == "Very helpful practice!"

    # 4. Test /admin/interviews
    r_iv = await client.get("/api/v1/admin/interviews?status=completed", headers=admin_headers)
    assert r_iv.status_code == 200
    iv_data = r_iv.json()
    assert any(i["id"] == str(iid1) for i in iv_data["items"])
    assert not any(i["id"] == str(iid2) for i in iv_data["items"])

    r_iv_progress = await client.get("/api/v1/admin/interviews?status=in_progress", headers=admin_headers)
    assert r_iv_progress.status_code == 200
    assert any(i["id"] == str(iid2) for i in r_iv_progress.json()["items"])

    # 5. PRIVACY TEST: Verify NO private data is leaked across all admin responses
    responses_to_check = [
        r_ov.text,
        r_users.text,
        r_u1.text,
        r_iv.text,
        (await client.get("/api/v1/admin/feedback", headers=admin_headers)).text,
    ]

    for resp_text in responses_to_check:
        # Check that transcripts, resume texts, and raw storage paths are NEVER leaked
        assert "transcript_text" not in resp_text
        assert "extracted_text" not in resp_text
        assert "storage_path" not in resp_text
        assert "I investigated a subtle race condition in production." not in resp_text
        assert "Jane Doe - Backend Engineer" not in resp_text
        assert "Senior Backend Engineer. We are hiring" not in resp_text


async def test_live_token_endpoint_does_not_call_document_or_planner_services(
    client, fakes, monkeypatch
) -> None:
    from unittest.mock import MagicMock

    from app.services import document_service, interview_planner

    registry, _ = fakes
    user = uuid.uuid4()
    iid, _ = await ready_interview(client, user)

    doc_mock = MagicMock()
    planner_mock = MagicMock()
    monkeypatch.setattr(document_service, "parse_document", doc_mock)
    monkeypatch.setattr(interview_planner, "generate_plan", planner_mock)

    r = await client.post(f"/api/v1/interviews/{iid}/live-token", headers=auth(user))
    assert r.status_code == 200, r.text
    token_data = r.json()
    assert token_data["token"].startswith("auth_tokens/")
    assert not doc_mock.called
    assert not planner_mock.called


async def test_live_token_called_twice_in_a_row_returns_200(client, fakes) -> None:
    registry, _ = fakes
    user = uuid.uuid4()
    iid, _ = await ready_interview(client, user)

    # First call (e.g. prefetch)
    r1 = await client.post(f"/api/v1/interviews/{iid}/live-token", headers=auth(user))
    assert r1.status_code == 200, r1.text
    assert r1.json()["token"].startswith("auth_tokens/")

    # Second call (e.g. on click)
    r2 = await client.post(f"/api/v1/interviews/{iid}/live-token", headers=auth(user))
    assert r2.status_code == 200, r2.text
    assert r2.json()["token"].startswith("auth_tokens/")
