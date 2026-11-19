"""Unit and integration tests for billing, Cashfree payments, credit ledger, and contact messages."""

from __future__ import annotations

import base64
import hashlib
import hmac
import time
import uuid
from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock, patch

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from app.core.config import get_settings
from app.db.session import get_sessionmaker
from app.models import ContactMessage, CreditLedger, Interview, PaymentOrder, Profile
from app.services import billing_service
from app.workers.jobs import refund_unstarted_or_failed
from tests.conftest import make_token
from tests.test_api_integration import DOCX_MIME, JD, RESUME, docx_bytes


@pytest.mark.asyncio
async def test_packages_and_balance_endpoints(client: AsyncClient, fakes) -> None:
    # 1. Packages endpoint is public
    res = await client.get("/api/v1/billing/packages")
    assert res.status_code == 200
    data = res.json()
    assert len(data["packages"]) == 4
    codes = [p["code"] for p in data["packages"]]
    assert codes == ["single", "starter", "pro", "job_hunt"]
    assert data["interview_costs"]["10"] == 1
    assert data["interview_costs"]["45"] == 5

    # 2. Guest balance is always 0
    guest_id = uuid.uuid4()
    guest_token = make_token(guest_id, is_anonymous=True)
    res_guest = await client.get("/api/v1/billing/balance", headers={"Authorization": f"Bearer {guest_token}"})
    assert res_guest.status_code == 200
    assert res_guest.json()["balance"] == 0
    assert res_guest.json()["is_guest"] is True

    # 3. New registered user gets 1 free grant credit on profile creation
    user_id = uuid.uuid4()
    user_token = make_token(user_id, email="newuser@example.com", is_anonymous=False)
    res_user = await client.get("/api/v1/billing/balance", headers={"Authorization": f"Bearer {user_token}"})
    assert res_user.status_code == 200
    assert res_user.json()["balance"] == 1
    assert res_user.json()["is_guest"] is False


@pytest.mark.asyncio
async def test_guest_blocked_from_purchasing(client: AsyncClient, fakes) -> None:
    guest_id = uuid.uuid4()
    guest_token = make_token(guest_id, is_anonymous=True)
    res = await client.post(
        "/api/v1/billing/orders",
        headers={"Authorization": f"Bearer {guest_token}"},
        json={"package_code": "single"},
    )
    assert res.status_code == 403
    assert res.json()["error"]["code"] == "guest_cannot_purchase"


@pytest.mark.asyncio
async def test_order_creation_confirm_and_idempotency(client: AsyncClient, fakes) -> None:
    user_id = uuid.uuid4()
    user_token = make_token(user_id, email="shopper@example.com", is_anonymous=False)
    auth = {"Authorization": f"Bearer {user_token}"}

    # Mock Cashfree order creation & fetch
    mock_create_res = {
        "cf_order_id": "cf_12345",
        "payment_session_id": "session_abc",
        "order_status": "ACTIVE",
    }
    mock_get_res = {
        "order_id": "order_test_123",
        "order_status": "PAID",
        "order_amount": 149.00,
    }

    with patch("app.services.billing_service.create_cashfree_order", new_callable=AsyncMock) as mock_create, \
         patch("app.services.billing_service.get_cashfree_order", new_callable=AsyncMock) as mock_get:
        mock_create.return_value = mock_create_res
        mock_get.return_value = mock_get_res

        # 1. Create order
        create_res = await client.post("/api/v1/billing/orders", headers=auth, json={"package_code": "single"})
        assert create_res.status_code == 201
        order_data = create_res.json()
        order_id = order_data["order_id"]
        assert order_data["cf_order_id"] == "cf_12345"

        # 2. Confirm order
        confirm_res = await client.post(f"/api/v1/billing/orders/{order_id}/confirm", headers=auth)
        assert confirm_res.status_code == 200
        assert confirm_res.json()["status"] == "paid"
        # 1 free grant + 1 purchased credit = 2
        assert confirm_res.json()["balance"] == 2
        assert confirm_res.json()["credits"] == 1

        # 3. Confirming again is idempotent
        confirm_res_2 = await client.post(f"/api/v1/billing/orders/{order_id}/confirm", headers=auth)
        assert confirm_res_2.status_code == 200
        assert confirm_res_2.json()["balance"] == 2


@pytest.mark.asyncio
async def test_cashfree_amount_mismatch_rejected(client: AsyncClient, fakes) -> None:
    user_id = uuid.uuid4()
    user_token = make_token(user_id, email="mismatch@example.com", is_anonymous=False)
    auth = {"Authorization": f"Bearer {user_token}"}

    mock_create_res = {"cf_order_id": "cf_mismatch", "payment_session_id": "session_m"}
    mock_get_res = {"order_id": "order_mismatch", "order_status": "PAID", "order_amount": 99.00}  # Should be 149.00

    with patch("app.services.billing_service.create_cashfree_order", new_callable=AsyncMock) as mock_create, \
         patch("app.services.billing_service.get_cashfree_order", new_callable=AsyncMock) as mock_get:
        mock_create.return_value = mock_create_res
        mock_get.return_value = mock_get_res

        create_res = await client.post("/api/v1/billing/orders", headers=auth, json={"package_code": "single"})
        order_id = create_res.json()["order_id"]

        confirm_res = await client.post(f"/api/v1/billing/orders/{order_id}/confirm", headers=auth)
        assert confirm_res.status_code == 422
        assert confirm_res.json()["error"]["code"] == "PAYMENT_AMOUNT_MISMATCH"


@pytest.mark.asyncio
async def test_webhook_signature_verification_and_crediting(client: AsyncClient, fakes) -> None:
    settings = get_settings()
    secret = "test_webhook_secret_key"
    user_id = uuid.uuid4()
    user_token = make_token(user_id, email="webhookuser@example.com", is_anonymous=False)
    auth = {"Authorization": f"Bearer {user_token}"}

    # Ensure profile and order exist
    await client.get("/api/v1/billing/balance", headers=auth)
    sessionmaker = get_sessionmaker()
    order_id = f"order_{uuid.uuid4().hex[:16]}"
    async with sessionmaker() as db:
        order = PaymentOrder(
            id=uuid.uuid4(),
            user_id=user_id,
            package_code="pro",
            credits=8,
            amount_paise=69900,
            currency="INR",
            cf_order_id=order_id,
            status="created",
        )
        db.add(order)
        await db.commit()

    raw_body = f'{{"type": "PAYMENT_SUCCESS_WEBHOOK", "data": {{"order": {{"order_id": "{order_id}"}}, "payment": {{"cf_payment_id": "pay_999"}}}}}}'.encode("utf-8")
    now_ts = str(int(time.time()))

    # Compute valid signature
    data_to_sign = now_ts.encode("utf-8") + raw_body
    valid_sig = base64.b64encode(hmac.new(secret.encode("utf-8"), data_to_sign, hashlib.sha256).digest()).decode("utf-8")

    mock_cf_order = {"order_id": order_id, "order_status": "PAID", "order_amount": 699.00}

    with patch.object(settings, "cashfree_secret_key", secret), \
         patch("app.services.billing_service.get_cashfree_order", new_callable=AsyncMock) as mock_get:
        mock_get.return_value = mock_cf_order

        # 1. Invalid signature
        res_bad_sig = await client.post(
            "/api/v1/billing/cashfree/webhook",
            content=raw_body,
            headers={"x-webhook-timestamp": now_ts, "x-webhook-signature": "bad_sig"},
        )
        assert res_bad_sig.status_code == 401

        # 2. Stale timestamp (15 minutes ago)
        old_ts = str(int(time.time() - 900))
        stale_data = old_ts.encode("utf-8") + raw_body
        stale_sig = base64.b64encode(hmac.new(secret.encode("utf-8"), stale_data, hashlib.sha256).digest()).decode("utf-8")
        res_stale = await client.post(
            "/api/v1/billing/cashfree/webhook",
            content=raw_body,
            headers={"x-webhook-timestamp": old_ts, "x-webhook-signature": stale_sig},
        )
        assert res_stale.status_code == 401

        # 3. Valid webhook
        res_valid = await client.post(
            "/api/v1/billing/cashfree/webhook",
            content=raw_body,
            headers={"x-webhook-timestamp": now_ts, "x-webhook-signature": valid_sig},
        )
        assert res_valid.status_code == 200

        # Check balance: 1 free + 8 from pro = 9
        res_bal = await client.get("/api/v1/billing/balance", headers=auth)
        assert res_bal.json()["balance"] == 9


@pytest.mark.asyncio
async def test_interview_charging_and_402_when_payments_enabled(client: AsyncClient, fakes) -> None:
    settings = get_settings()
    user_id = uuid.uuid4()
    user_token = make_token(user_id, email="candidate@example.com", is_anonymous=False)
    auth = {"Authorization": f"Bearer {user_token}"}

    # Upload docs
    res_up = await client.post(
        "/api/v1/documents/resume",
        headers=auth,
        files={"file": ("resume.docx", docx_bytes(RESUME), DOCX_MIME)},
    )
    resume_id = res_up.json()["id"]
    job_up = await client.post(
        "/api/v1/documents/job-description",
        headers=auth,
        data={"text": JD},
    )
    job_id = job_up.json()["id"]

    # When payments_enabled = True:
    with patch.object(settings, "payments_enabled", True):
        # User has 1 initial credit (free grant)
        # Attempting a 20-min interview costs ceil(20/10) = 2 credits -> should return 402 PaymentRequired
        res_fail = await client.post(
            "/api/v1/interviews",
            headers=auth,
            json={
                "resume_document_id": resume_id,
                "job_description_document_id": job_id,
                "job_role": "Backend Engineer",
                "duration_minutes": 20,
                "evaluation_rigor": "standard",
                "recording_mode": "none",
                "consent_given": True,
            },
        )
        assert res_fail.status_code == 402
        assert res_fail.json()["error"]["code"] == "payment_required"

        # Attempting a 10-min interview costs 1 credit -> succeeds
        res_ok = await client.post(
            "/api/v1/interviews",
            headers=auth,
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
        assert res_ok.status_code == 201
        interview_id = res_ok.json()["id"]

        # Balance now 0
        bal = await client.get("/api/v1/billing/balance", headers=auth)
        assert bal.json()["balance"] == 0

        # Cancel interview -> credits refunded!
        res_cancel = await client.post(f"/api/v1/interviews/{interview_id}/cancel", headers=auth)
        assert res_cancel.status_code == 200

        # Balance back to 1
        bal_after = await client.get("/api/v1/billing/balance", headers=auth)
        assert bal_after.json()["balance"] == 1


@pytest.mark.asyncio
async def test_admin_exempt_from_credit_checks(client: AsyncClient, fakes) -> None:
    settings = get_settings()
    admin_id = uuid.uuid4()
    admin_email = "admin@example.com"
    admin_token = make_token(admin_id, email=admin_email, email_verified=True, is_anonymous=False)
    auth = {"Authorization": f"Bearer {admin_token}"}

    res_up = await client.post(
        "/api/v1/documents/resume",
        headers=auth,
        files={"file": ("resume.docx", docx_bytes(RESUME), DOCX_MIME)},
    )
    resume_id = res_up.json()["id"]
    job_up = await client.post(
        "/api/v1/documents/job-description",
        headers=auth,
        data={"text": JD},
    )
    job_id = job_up.json()["id"]

    with patch.object(settings, "payments_enabled", True), \
         patch.object(settings, "admin_emails", [admin_email]):
        # Admin can create a 45-min interview (cost 5) even with only 1 credit
        res_create = await client.post(
            "/api/v1/interviews",
            headers=auth,
            json={
                "resume_document_id": resume_id,
                "job_description_document_id": job_id,
                "job_role": "Lead Architect",
                "duration_minutes": 45,
                "evaluation_rigor": "standard",
                "recording_mode": "none",
                "consent_given": True,
            },
        )
        assert res_create.status_code == 201


@pytest.mark.asyncio
async def test_stale_unstarted_interview_refunded_by_worker(client: AsyncClient, fakes) -> None:
    settings = get_settings()
    user_id = uuid.uuid4()
    user_token = make_token(user_id, email="staletest@example.com", is_anonymous=False)
    auth = {"Authorization": f"Bearer {user_token}"}

    # Upload docs and create interview
    res_up = await client.post(
        "/api/v1/documents/resume",
        headers=auth,
        files={"file": ("resume.docx", docx_bytes(RESUME), DOCX_MIME)},
    )
    job_up = await client.post(
        "/api/v1/documents/job-description",
        headers=auth,
        data={"text": JD},
    )

    with patch.object(settings, "payments_enabled", True):
        res = await client.post(
            "/api/v1/interviews",
            headers=auth,
            json={
                "resume_document_id": res_up.json()["id"],
                "job_description_document_id": job_up.json()["id"],
                "job_role": "SRE",
                "duration_minutes": 10,
                "evaluation_rigor": "standard",
                "recording_mode": "none",
                "consent_given": True,
            },
        )
        assert res.status_code == 201
        interview_id = uuid.UUID(res.json()["id"])

        # Balance is 0
        bal_before = await client.get("/api/v1/billing/balance", headers=auth)
        assert bal_before.json()["balance"] == 0

        # Simulate 35 minutes passed without starting
        sessionmaker = get_sessionmaker()
        async with sessionmaker() as db:
            interview = (await db.execute(select(Interview).where(Interview.id == interview_id))).scalar_one()
            interview.created_at = datetime.now(UTC) - timedelta(minutes=35)
            await db.commit()

        # Run worker job
        async with sessionmaker() as db:
            refunded_count = await refund_unstarted_or_failed(db, settings)
            assert refunded_count == 1

        # Balance is refunded back to 1
        bal_after = await client.get("/api/v1/billing/balance", headers=auth)
        assert bal_after.json()["balance"] == 1


@pytest.mark.asyncio
async def test_admin_billing_stats_and_credit_grant(client: AsyncClient, fakes) -> None:
    settings = get_settings()
    admin_id = uuid.uuid4()
    admin_email = "superadmin@example.com"
    admin_token = make_token(admin_id, email=admin_email, email_verified=True, is_anonymous=False)
    admin_auth = {"Authorization": f"Bearer {admin_token}"}

    user_id = uuid.uuid4()
    user_token = make_token(user_id, email="grantee@example.com", is_anonymous=False)
    user_auth = {"Authorization": f"Bearer {user_token}"}
    # Initialize user profile
    await client.get("/api/v1/billing/balance", headers=user_auth)

    with patch.object(settings, "admin_emails", [admin_email]):
        # 1. Billing stats
        stats_res = await client.get("/api/v1/admin/billing/stats", headers=admin_auth)
        assert stats_res.status_code == 200
        stats = stats_res.json()
        assert "revenue_today_inr" in stats
        assert "revenue_30d_inr" in stats
        assert "orders" in stats

        # 2. Grant credits to user
        grant_res = await client.post(
            "/api/v1/admin/billing/grant",
            headers=admin_auth,
            json={"email": str(user_id), "credits": 5, "note": "VIP test credit"},
        )
        assert grant_res.status_code == 200
        assert grant_res.json()["status"] == "ok"
        assert grant_res.json()["credits_granted"] == 5

        # Check target user balance: 1 free grant + 5 admin grant = 6
        bal_res = await client.get("/api/v1/billing/balance", headers=user_auth)
        assert bal_res.json()["balance"] == 6


@pytest.mark.asyncio
async def test_contact_form_and_admin_messages(client: AsyncClient, fakes) -> None:
    settings = get_settings()
    admin_id = uuid.uuid4()
    admin_email = "supportadmin@example.com"
    admin_token = make_token(admin_id, email=admin_email, email_verified=True, is_anonymous=False)
    admin_auth = {"Authorization": f"Bearer {admin_token}"}

    # 1. Submit contact message
    msg_payload = {
        "name": "Jane Doe",
        "email": "jane@example.com",
        "message": "Hello, I have a question about interview credits.",
    }
    submit_res = await client.post("/api/v1/contact", json=msg_payload)
    assert submit_res.status_code == 201
    message_id = submit_res.json()["message_id"]

    # 2. Admin views messages list
    with patch.object(settings, "admin_emails", [admin_email]):
        list_res = await client.get("/api/v1/admin/messages", headers=admin_auth)
        assert list_res.status_code == 200
        items = list_res.json()["items"]
        assert any(m["id"] == message_id for m in items)

        # 3. Admin marks message handled
        handle_res = await client.post(f"/api/v1/admin/messages/{message_id}/handle", headers=admin_auth)
        assert handle_res.status_code == 200
        assert handle_res.json()["status"] == "ok"

        # Verify handled is true
        list_res_2 = await client.get("/api/v1/admin/messages", headers=admin_auth)
        updated_msg = next(m for m in list_res_2.json()["items"] if m["id"] == message_id)
        assert updated_msg["handled"] is True
