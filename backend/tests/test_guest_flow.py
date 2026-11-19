"""Tests for guest flow, server-side limits, report preview, and guest claims."""

from __future__ import annotations

import uuid

import pytest
from httpx import AsyncClient

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
