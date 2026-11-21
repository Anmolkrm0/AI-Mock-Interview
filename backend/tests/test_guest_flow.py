"""Tests for guest flow, server-side limits, report preview, and guest claims."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from app.api.v1.health import is_migration_up_to_date
from app.core.config import get_settings
from app.db.session import get_sessionmaker
from app.models import (
    GuestInterviewStat,
    Interview,
    Profile,
    Question,
    Report,
    StorageCleanupTask,
)
from app.workers.jobs import cleanup_unclaimed_guests
from tests.conftest import make_token
from tests.test_api_integration import DOCX_MIME, JD, RESUME, docx_bytes, drain_jobs, ev


@pytest.mark.asyncio
async def test_anonymous_limits_and_report_preview(client: AsyncClient, fakes) -> None:
    guest_id = uuid.uuid4()
    guest_token = make_token(guest_id, is_anonymous=True)
    guest_auth = {"Authorization": f"Bearer {guest_token}"}

    # 1. Upload resume and job description as guest
    res_up = await client.post(
        "/api/v1/documents/resume",
        headers=guest_auth,
        files={"file": ("resume.docx", docx_bytes(RESUME), DOCX_MIME)},
    )
    assert res_up.status_code == 201
    resume_id = res_up.json()["id"]

    job_up = await client.post(
        "/api/v1/documents/job-description",
        headers=guest_auth,
        data={"text": JD},
    )
    assert job_up.status_code == 201
    job_id = job_up.json()["id"]

    # 2. First interview creation forces duration to 10 and recording_mode to none
    int_res = await client.post(
        "/api/v1/interviews",
        headers=guest_auth,
        json={
            "resume_document_id": resume_id,
            "job_description_document_id": job_id,
            "job_role": "Software Engineer",
            "duration_minutes": 30,  # Requested 30
            "evaluation_rigor": "standard",
            "recording_mode": "video",  # Requested video
            "consent_given": True,
        },
    )
    assert int_res.status_code == 201
    int_data = int_res.json()
    interview_id = int_data["id"]
    assert int_data["duration_minutes"] == 10
    assert int_data["recording_mode"] == "none"

    # 3. Second interview creation by guest returns 403 with code "guest_limit"
    int_res2 = await client.post(
        "/api/v1/interviews",
        headers=guest_auth,
        json={
            "resume_document_id": resume_id,
            "job_description_document_id": job_id,
            "job_role": "Software Engineer",
            "duration_minutes": 10,
            "evaluation_rigor": "standard",
            "recording_mode": "none",
            "consent_given": True,
        },
    )
    assert int_res2.status_code == 403
    assert int_res2.json()["error"]["code"] == "guest_limit"

    # 4. Recording endpoints return 403 for guest
    rec_up = await client.post(
        "/api/v1/recordings/upload-url",
        headers=guest_auth,
        json={
            "interview_id": interview_id,
            "mime_type": "audio/webm",
            "size_bytes": 1000,
            "duration_seconds": 60,
        },
    )
    assert rec_up.status_code == 403
    assert rec_up.json()["error"]["code"] == "RECORDINGS_NOT_ALLOWED"

    rec_latest = await client.get("/api/v1/recordings/latest", headers=guest_auth)
    assert rec_latest.status_code == 403
    assert rec_latest.json()["error"]["code"] == "RECORDINGS_NOT_ALLOWED"

    rec_del = await client.delete("/api/v1/recordings/latest", headers=guest_auth)
    assert rec_del.status_code == 403
    assert rec_del.json()["error"]["code"] == "RECORDINGS_NOT_ALLOWED"

    rec_play = await client.get(f"/api/v1/interviews/{interview_id}/recording-url", headers=guest_auth)
    assert rec_play.status_code == 403
    assert rec_play.json()["error"]["code"] == "RECORDINGS_NOT_ALLOWED"

    # 5. Feedback returns 403 for guest
    fb_res = await client.post(
        f"/api/v1/interviews/{interview_id}/feedback",
        headers=guest_auth,
        json={"rating": 5, "comments": "Great"},
    )
    assert fb_res.status_code == 403
    assert fb_res.json()["error"]["code"] == "GUEST_FEEDBACK_FORBIDDEN"

    # 6. Admin endpoints return 404 for guest
    admin_me = await client.get("/api/v1/admin/me", headers=guest_auth)
    assert admin_me.status_code in (403, 404)

    # 7. Listing interviews beyond offset 0 returns 403 for guest
    list_offset = await client.get("/api/v1/interviews?offset=1", headers=guest_auth)
    assert list_offset.status_code == 403
    assert list_offset.json()["error"]["code"] == "GUEST_LIST_LIMIT"

    list_ok = await client.get("/api/v1/interviews", headers=guest_auth)
    assert list_ok.status_code == 200
    assert len(list_ok.json()["items"]) == 1

    # 7b. Deleting interview returns 403 with code "guest_limit" for guest
    del_res = await client.delete(f"/api/v1/interviews/{interview_id}", headers=guest_auth)
    assert del_res.status_code == 403
    assert del_res.json()["error"]["code"] == "guest_limit"

    # 8. Report preview cut on SERVER:
    # Run plan
    plan_res = await client.post(
        "/api/v1/interviews/plan", headers=guest_auth, json={"interview_id": interview_id}
    )
    assert plan_res.status_code == 200
    q = plan_res.json()["questions"]

    # Start live session
    token_res = await client.post(f"/api/v1/interviews/{interview_id}/live-token", headers=guest_auth)
    assert token_res.status_code == 200

    await client.post(
        f"/api/v1/interviews/{interview_id}/events",
        headers=guest_auth,
        json={
            "events": [
                ev("session_started"),
                ev("question_asked", question_id=q[0]["id"]),
                ev(
                    "answer_submitted",
                    question_id=q[0]["id"],
                    answer_source="text",
                    transcript_text="I designed and led the backend service architecture.",
                ),
            ]
        },
    )

    # Complete interview and drain jobs
    end_res = await client.post(f"/api/v1/interviews/{interview_id}/complete", headers=guest_auth)
    assert end_res.status_code == 200
    await drain_jobs(fakes)

    # GET report as guest: should return preview object only
    rep_res = await client.get(f"/api/v1/interviews/{interview_id}/report", headers=guest_auth)
    assert rep_res.status_code == 200
    rep_data = rep_res.json()
    assert rep_data["locked"] is True
    assert rep_data["overall_score"] is not None
    assert rep_data["overall_label"] in (
        "Excellent",
        "Strong",
        "Competent",
        "Developing",
        "Needs Improvement",
    )
    assert rep_data["competency_scores"] == []
    assert rep_data["question_evaluations"] == []
    assert rep_data["strengths"] == []
    assert rep_data["improvement_areas"] == []
    assert rep_data["recommendations"] == []
    assert rep_data["summary"] is None


@pytest.mark.asyncio
async def test_guest_claim_flow(client: AsyncClient, fakes) -> None:
    guest_id = uuid.uuid4()
    guest_token = make_token(guest_id, is_anonymous=True)
    guest_auth = {"Authorization": f"Bearer {guest_token}"}

    reg_id = uuid.uuid4()
    reg_token = make_token(reg_id, is_anonymous=False)
    reg_auth = {"Authorization": f"Bearer {reg_token}"}

    # Guest uploads and creates interview
    res_up = await client.post(
        "/api/v1/documents/resume",
        headers=guest_auth,
        files={"file": ("resume.docx", docx_bytes(RESUME), DOCX_MIME)},
    )
    resume_id = res_up.json()["id"]

    job_up = await client.post(
        "/api/v1/documents/job-description",
        headers=guest_auth,
        data={"text": JD},
    )
    job_id = job_up.json()["id"]

    int_res = await client.post(
        "/api/v1/interviews",
        headers=guest_auth,
        json={
            "resume_document_id": resume_id,
            "job_description_document_id": job_id,
            "job_role": "Backend Engineer",
            "duration_minutes": 10,
            "evaluation_rigor": "standard",
            "recording_mode": "none",
            "consent_given": True,
        },
    )
    interview_id = int_res.json()["id"]

    # Attempt to claim with anonymous caller -> 403 Forbidden
    anon_claim = await client.post(
        "/api/v1/guest/claim",
        headers=guest_auth,
        json={"guest_token": guest_token},
    )
    assert anon_claim.status_code == 403
    assert anon_claim.json()["error"]["code"] == "GUEST_CANNOT_CLAIM"

    # Attempt to claim with invalid guest token -> 400 Bad Request
    inv_claim = await client.post(
        "/api/v1/guest/claim",
        headers=reg_auth,
        json={"guest_token": "not-a-valid-jwt"},
    )
    assert inv_claim.status_code == 400
    assert inv_claim.json()["error"]["code"] == "INVALID_GUEST_TOKEN"

    # Attempt to claim with non-anonymous token -> 400 Bad Request
    non_anon_token = make_token(uuid.uuid4(), is_anonymous=False)
    non_anon_claim = await client.post(
        "/api/v1/guest/claim",
        headers=reg_auth,
        json={"guest_token": non_anon_token},
    )
    assert non_anon_claim.status_code == 400
    assert non_anon_claim.json()["error"]["code"] == "INVALID_GUEST_TOKEN"

    # Happy path: registered user claims guest session
    claim_res = await client.post(
        "/api/v1/guest/claim",
        headers=reg_auth,
        json={"guest_token": guest_token},
    )
    assert claim_res.status_code == 200
    assert claim_res.json()["claimed"] is True
    assert claim_res.json()["claimed_interviews"] == 1

    # Now registered user owns the interview
    owned_int = await client.get(f"/api/v1/interviews/{interview_id}", headers=reg_auth)
    assert owned_int.status_code == 200
    assert owned_int.json()["id"] == interview_id

    # Guest user no longer owns the interview (returns 404 for guest)
    guest_view = await client.get(f"/api/v1/interviews/{interview_id}", headers=guest_auth)
    assert guest_view.status_code == 404

    # Idempotent: second claim with same guest token succeeds with 0 claimed
    second_claim = await client.post(
        "/api/v1/guest/claim",
        headers=reg_auth,
        json={"guest_token": guest_token},
    )
    assert second_claim.status_code == 200
    assert second_claim.json()["claimed"] is True
    assert second_claim.json()["claimed_interviews"] == 0


@pytest.mark.asyncio
async def test_readiness_version_check(client: AsyncClient) -> None:
    # Code expecting 0003 should consider 0004 ready, 0003 ready, but 0002 not ready
    assert is_migration_up_to_date("0004", "0003") is True
    assert is_migration_up_to_date("0003", "0003") is True
    assert is_migration_up_to_date("0002", "0003") is False
    assert is_migration_up_to_date("0001", "0003") is False
    assert is_migration_up_to_date(None, "0003") is False

    r = await client.get("/api/v1/ready")
    assert r.status_code == 200
    assert r.json()["ready"] is True


@pytest.mark.asyncio
async def test_video_recording_rejected_when_disabled(client: AsyncClient, monkeypatch) -> None:
    settings = get_settings()
    monkeypatch.setattr(settings, "allow_video_recording", False)
    user_id = uuid.uuid4()
    user_auth = {"Authorization": f"Bearer {make_token(user_id)}"}
    res_up = await client.post(
        "/api/v1/documents/resume",
        headers=user_auth,
        files={"file": ("resume.docx", docx_bytes(RESUME), DOCX_MIME)},
    )
    job_up = await client.post(
        "/api/v1/documents/job-description",
        headers=user_auth,
        data={"text": JD},
    )
    r = await client.post(
        "/api/v1/interviews",
        headers=user_auth,
        json={
            "resume_document_id": res_up.json()["id"],
            "job_description_document_id": job_up.json()["id"],
            "job_role": "Backend Engineer",
            "duration_minutes": 20,
            "evaluation_rigor": "standard",
            "recording_mode": "video",
            "consent_given": True,
        },
    )
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "VIDEO_RECORDING_DISABLED"


@pytest.mark.asyncio
async def test_guest_network_limit_and_daily_cap(client: AsyncClient, monkeypatch) -> None:
    settings = get_settings()
    monkeypatch.setattr(settings, "guest_per_network_daily", 2)

    client_ip = "203.0.113.42"
    headers_ip = {"X-Forwarded-For": f"{client_ip}, 10.0.0.1"}

    # 1. Guest 1 from this IP succeeds
    g1_id = uuid.uuid4()
    g1_auth = {"Authorization": f"Bearer {make_token(g1_id, is_anonymous=True)}", **headers_ip}
    res1 = await client.post(
        "/api/v1/documents/resume",
        headers=g1_auth,
        files={"file": ("resume.docx", docx_bytes(RESUME), DOCX_MIME)},
    )
    job1 = await client.post(
        "/api/v1/documents/job-description",
        headers=g1_auth,
        data={"text": JD},
    )
    r1 = await client.post(
        "/api/v1/interviews",
        headers=g1_auth,
        json={
            "resume_document_id": res1.json()["id"],
            "job_description_document_id": job1.json()["id"],
            "job_role": "Backend Engineer",
            "duration_minutes": 10,
            "evaluation_rigor": "standard",
            "recording_mode": "none",
            "consent_given": True,
        },
    )
    assert r1.status_code == 201

    # 2. Guest 2 from this same IP succeeds
    g2_id = uuid.uuid4()
    g2_auth = {"Authorization": f"Bearer {make_token(g2_id, is_anonymous=True)}", **headers_ip}
    res2 = await client.post(
        "/api/v1/documents/resume",
        headers=g2_auth,
        files={"file": ("resume.docx", docx_bytes(RESUME), DOCX_MIME)},
    )
    job2 = await client.post(
        "/api/v1/documents/job-description",
        headers=g2_auth,
        data={"text": JD},
    )
    r2 = await client.post(
        "/api/v1/interviews",
        headers=g2_auth,
        json={
            "resume_document_id": res2.json()["id"],
            "job_description_document_id": job2.json()["id"],
            "job_role": "Backend Engineer",
            "duration_minutes": 10,
            "evaluation_rigor": "standard",
            "recording_mode": "none",
            "consent_given": True,
        },
    )
    assert r2.status_code == 201

    # 3. Guest 3 from this same IP gets 403 guest_network_limit
    g3_id = uuid.uuid4()
    g3_auth = {"Authorization": f"Bearer {make_token(g3_id, is_anonymous=True)}", **headers_ip}
    res3 = await client.post(
        "/api/v1/documents/resume",
        headers=g3_auth,
        files={"file": ("resume.docx", docx_bytes(RESUME), DOCX_MIME)},
    )
    job3 = await client.post(
        "/api/v1/documents/job-description",
        headers=g3_auth,
        data={"text": JD},
    )
    r3 = await client.post(
        "/api/v1/interviews",
        headers=g3_auth,
        json={
            "resume_document_id": res3.json()["id"],
            "job_description_document_id": job3.json()["id"],
            "job_role": "Backend Engineer",
            "duration_minutes": 10,
            "evaluation_rigor": "standard",
            "recording_mode": "none",
            "consent_given": True,
        },
    )
    assert r3.status_code == 403
    assert r3.json()["error"]["code"] == "guest_network_limit"

    # 4. Daily cap reached
    monkeypatch.setattr(settings, "guest_daily_cap", 2)
    # Different IP so network limit isn't hit
    g4_id = uuid.uuid4()
    g4_auth = {
        "Authorization": f"Bearer {make_token(g4_id, is_anonymous=True)}",
        "X-Forwarded-For": "198.51.100.99",
    }
    res4 = await client.post(
        "/api/v1/documents/resume",
        headers=g4_auth,
        files={"file": ("resume.docx", docx_bytes(RESUME), DOCX_MIME)},
    )
    job4 = await client.post(
        "/api/v1/documents/job-description",
        headers=g4_auth,
        data={"text": JD},
    )
    r4 = await client.post(
        "/api/v1/interviews",
        headers=g4_auth,
        json={
            "resume_document_id": res4.json()["id"],
            "job_description_document_id": job4.json()["id"],
            "job_role": "Backend Engineer",
            "duration_minutes": 10,
            "evaluation_rigor": "standard",
            "recording_mode": "none",
            "consent_given": True,
        },
    )
    assert r4.status_code == 403
    assert r4.json()["error"]["code"] == "guest_daily_cap"


@pytest.mark.asyncio
async def test_worker_cleanup_unclaimed_guests(client: AsyncClient, fakes) -> None:
    _, storage = fakes
    settings = get_settings()
    sessionmaker = get_sessionmaker()

    # 1. Create an anonymous user older than 48 hours
    old_guest_id = uuid.uuid4()
    old_guest_auth = {"Authorization": f"Bearer {make_token(old_guest_id, is_anonymous=True)}"}
    res_up = await client.post(
        "/api/v1/documents/resume",
        headers=old_guest_auth,
        files={"file": ("resume.docx", docx_bytes(RESUME), DOCX_MIME)},
    )
    assert res_up.status_code == 201

    # Manually backdate profile created_at to 50 hours ago
    async with sessionmaker() as db:
        old_prof = await db.get(Profile, old_guest_id)
        assert old_prof is not None
        old_prof.created_at = datetime.now(UTC) - timedelta(hours=50)
        await db.commit()

    # 2. Create a fresh anonymous user (< 48 hours old)
    fresh_guest_id = uuid.uuid4()
    fresh_guest_auth = {"Authorization": f"Bearer {make_token(fresh_guest_id, is_anonymous=True)}"}
    res_fresh = await client.post(
        "/api/v1/documents/resume",
        headers=fresh_guest_auth,
        files={"file": ("resume.docx", docx_bytes(RESUME), DOCX_MIME)},
    )
    assert res_fresh.status_code == 201

    # Fake HTTP client to record Supabase auth delete calls
    deleted_auth_urls: list[str] = []

    class FakeAuthHttpClient:
        async def delete(self, url: str, headers: dict) -> None:
            deleted_auth_urls.append(url)

    async with sessionmaker() as db:
        cleaned_cnt = await cleanup_unclaimed_guests(db, storage, settings, http_client=FakeAuthHttpClient())
        assert cleaned_cnt >= 1

    # Verify old profile is gone, fresh profile still exists
    async with sessionmaker() as db:
        assert (await db.get(Profile, old_guest_id)) is None
        assert (await db.get(Profile, fresh_guest_id)) is not None

        # Storage cleanup task queued for old guest's document
        tasks = list(
            (
                await db.execute(
                    select(StorageCleanupTask).where(StorageCleanupTask.reason == "guest_expired")
                )
            ).scalars()
        )
        assert len(tasks) >= 1


@pytest.mark.asyncio
async def test_cleanup_archives_guest_interview_then_deletes_it(client: AsyncClient, fakes) -> None:
    _, storage = fakes
    settings = get_settings()
    sessionmaker = get_sessionmaker()

    guest_id = uuid.uuid4()
    interview_id = uuid.uuid4()
    report_id = uuid.uuid4()

    # Create expired guest profile with an interview, report, and questions
    async with sessionmaker() as db:
        prof = Profile(
            id=guest_id,
            is_anonymous=True,
            created_at=datetime.now(UTC) - timedelta(hours=50),
        )
        db.add(prof)
        await db.flush()

        interview = Interview(
            id=interview_id,
            user_id=guest_id,
            is_guest=True,
            job_role="Senior Python Developer",
            duration_minutes=20,
            status="completed",
            evaluation_rigor="standard",
            recording_mode="none",
            created_at=datetime.now(UTC) - timedelta(hours=49),
        )
        db.add(interview)
        await db.flush()

        q1 = Question(
            id=uuid.uuid4(),
            interview_id=interview_id,
            sequence_number=1,
            question_text="Describe a complex system you designed.",
            competency="System Design",
            difficulty=4,
            question_type="technical",
            status="answered",
        )
        q2 = Question(
            id=uuid.uuid4(),
            interview_id=interview_id,
            sequence_number=2,
            question_text="How do you handle ambiguous requirements?",
            competency="Communication",
            difficulty=3,
            question_type="behavioral",
            status="skipped",
        )
        db.add_all([q1, q2])

        report = Report(
            id=report_id,
            interview_id=interview_id,
            report_status="completed",
            overall_score=78.5,
            evidence_sufficiency="sufficient",
        )
        db.add(report)
        await db.commit()

    class FakeAuthHttpClient:
        async def delete(self, url: str, headers: dict) -> None:
            pass

    async with sessionmaker() as db:
        cleaned = await cleanup_unclaimed_guests(db, storage, settings, http_client=FakeAuthHttpClient())
        assert cleaned >= 1

    # Verify guest profile, interview, and report are deleted
    async with sessionmaker() as db:
        assert (await db.get(Profile, guest_id)) is None
        assert (await db.get(Interview, interview_id)) is None
        assert (await db.get(Report, report_id)) is None

        # Verify outcome was archived into guest_interview_stats
        stat = await db.get(GuestInterviewStat, interview_id)
        assert stat is not None
        assert stat.interview_id == interview_id
        assert stat.job_role == "Senior Python Developer"
        assert stat.duration_minutes == 20
        assert stat.status == "completed"
        assert stat.questions_total == 2
        assert stat.questions_answered == 1
        assert stat.overall_score == 78.5
        assert stat.archived_at is not None

