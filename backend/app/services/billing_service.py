"""Cashfree payment integration, credit ledger operations, and packages."""

from __future__ import annotations

import base64
import hashlib
import hmac
import math
import time
import uuid
from datetime import datetime
from typing import Any

import logging

import httpx
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings
from app.core.errors import Conflict, Forbidden, NotFound, PaymentRequired, ValidationFailed
from app.models import CreditLedger, Interview, PaymentOrder

logger = logging.getLogger(__name__)

PACKAGES: list[dict[str, Any]] = [
    {
        "code": "single",
        "name": "Single",
        "credits": 1,
        "amount_paise": 14900,
        "price_inr": 149,
        "popular": False,
        "description": "1 interview · ₹149 per credit",
    },
    {
        "code": "starter",
        "name": "Starter",
        "credits": 3,
        "amount_paise": 29900,
        "price_inr": 299,
        "popular": False,
        "description": "3 interviews · ₹100 per credit",
    },
    {
        "code": "pro",
        "name": "Pro",
        "credits": 8,
        "amount_paise": 69900,
        "price_inr": 699,
        "popular": True,
        "description": "8 interviews · ₹87 per credit",
    },
    {
        "code": "job_hunt",
        "name": "Job Hunt",
        "credits": 15,
        "amount_paise": 119900,
        "price_inr": 1199,
        "popular": False,
        "description": "15 interviews · ₹80 per credit, the lowest price",
    },
]

PACKAGE_BY_CODE = {p["code"]: p for p in PACKAGES}

INTERVIEW_COSTS = {
    10: 1,
    20: 2,
    30: 3,
    45: 5,
}


def calculate_interview_cost(duration_minutes: int) -> int:
    """Interview cost = ceil(duration_minutes/10) credits (10 min = 1, 20 = 2, 30 = 3, 45 = 5)."""
    return math.ceil(duration_minutes / 10)


async def get_balance(db: AsyncSession, user_id: uuid.UUID) -> int:
    """Calculate the user's current credit balance by summing all ledger deltas."""
    result = await db.execute(
        select(func.coalesce(func.sum(CreditLedger.delta), 0)).where(CreditLedger.user_id == user_id)
    )
    return int(result.scalar_one() or 0)


async def grant_free_credit_if_eligible(db: AsyncSession, user_id: uuid.UUID) -> bool:
    """Grant 1 free credit to new non-anonymous profile ONLY if they have no interviews yet."""
    # Check if already has a free_grant
    has_grant = (
        await db.execute(
            select(CreditLedger.id).where(
                CreditLedger.user_id == user_id,
                CreditLedger.reason == "free_grant",
            )
        )
    ).scalar_one_or_none()
    if has_grant:
        return False

    # Check if user has any interviews
    interview_count = (
        await db.execute(select(func.count()).select_from(Interview).where(Interview.user_id == user_id))
    ).scalar_one()
    if interview_count > 0:
        return False

    entry = CreditLedger(
        id=uuid.uuid4(),
        user_id=user_id,
        delta=1,
        reason="free_grant",
        note="Welcome free credit",
    )
    db.add(entry)
    await db.commit()
    return True


async def charge_interview_credits(
    db: AsyncSession,
    *,
    user_id: uuid.UUID,
    interview_id: uuid.UUID,
    duration_minutes: int,
) -> int:
    """Deduct credits for creating an interview."""
    cost = calculate_interview_cost(duration_minutes)
    balance = await get_balance(db, user_id)
    if balance < cost:
        raise PaymentRequired(
            f"Not enough interview credits (required {cost}, balance {balance}). Choose a pack to continue.",
            code="payment_required",
        )
    existing = (
        await db.execute(
            select(CreditLedger.id).where(
                CreditLedger.interview_id == interview_id,
                CreditLedger.reason == "interview_use",
            )
        )
    ).scalar_one_or_none()
    if existing:
        return cost

    entry = CreditLedger(
        id=uuid.uuid4(),
        user_id=user_id,
        delta=-cost,
        reason="interview_use",
        interview_id=interview_id,
        note=f"Interview {interview_id} ({duration_minutes} min)",
    )
    db.add(entry)
    return cost


async def refund_interview_credits(
    db: AsyncSession,
    *,
    interview_id: uuid.UUID,
    reason_note: str,
) -> int | None:
    """Refund credits if an interview was charged and not already refunded."""
    use_entry = (
        await db.execute(
            select(CreditLedger).where(
                CreditLedger.interview_id == interview_id,
                CreditLedger.reason == "interview_use",
            )
        )
    ).scalar_one_or_none()
    if not use_entry:
        return None

    refund_entry = (
        await db.execute(
            select(CreditLedger).where(
                CreditLedger.interview_id == interview_id,
                CreditLedger.reason == "interview_refund",
            )
        )
    ).scalar_one_or_none()
    if refund_entry:
        return None

    refund_credits = abs(use_entry.delta)
    entry = CreditLedger(
        id=uuid.uuid4(),
        user_id=use_entry.user_id,
        delta=refund_credits,
        reason="interview_refund",
        interview_id=interview_id,
        note=reason_note,
    )
    db.add(entry)
    await db.commit()
    return refund_credits


def get_cashfree_base_url(settings: Settings) -> str:
    if settings.cashfree_env == "production":
        return "https://api.cashfree.com"
    return "https://sandbox.cashfree.com"


async def create_cashfree_order(
    settings: Settings,
    *,
    order_id: str,
    amount_inr: float,
    customer_id: str,
    customer_email: str,
    customer_phone: str = "9999999999",
    return_url: str,
    notify_url: str,
) -> dict[str, Any]:
    base_url = get_cashfree_base_url(settings)
    url = f"{base_url}/pg/orders"
    headers = {
        "x-client-id": settings.cashfree_app_id,
        "x-client-secret": settings.cashfree_secret_key,
        "x-api-version": settings.cashfree_api_version,
        "Content-Type": "application/json",
    }
    payload = {
        "order_id": order_id,
        "order_amount": round(amount_inr, 2),
        "order_currency": "INR",
        "customer_details": {
            "customer_id": customer_id[:50],
            "customer_email": customer_email,
            "customer_phone": customer_phone or "9999999999",
        },
        "order_meta": {
            "return_url": return_url,
            "notify_url": notify_url,
        },
    }
    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.post(url, headers=headers, json=payload)
        if resp.status_code >= 400:
            logger.warning("cashfree_create_order_failed status=%s", resp.status_code)
            raise ValidationFailed(
                "We couldn't start the payment. Please try again in a minute.",
                code="CASHFREE_ERROR",
            )
        return resp.json()


async def get_cashfree_order(
    settings: Settings,
    *,
    order_id: str,
) -> dict[str, Any]:
    base_url = get_cashfree_base_url(settings)
    url = f"{base_url}/pg/orders/{order_id}"
    headers = {
        "x-client-id": settings.cashfree_app_id,
        "x-client-secret": settings.cashfree_secret_key,
        "x-api-version": settings.cashfree_api_version,
    }
    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.get(url, headers=headers)
        if resp.status_code >= 400:
            raise NotFound(
                f"Cashfree order {order_id} not found: {resp.text}",
                code="ORDER_NOT_FOUND",
            )
        return resp.json()


def verify_cashfree_webhook_signature(
    *,
    timestamp_header: str,
    raw_body: bytes,
    signature_header: str,
    secret_key: str,
) -> bool:
    """Verify Cashfree signature: base64(HMAC-SHA256(timestamp + RAW body, secret)).

    Reject timestamps older than 10 minutes.
    Uses constant-time comparison.
    """
    if not timestamp_header or not signature_header or not secret_key:
        return False

    try:
        ts = float(timestamp_header)
        if ts > 1e11:  # milliseconds
            ts = ts / 1000.0
        now = time.time()
        if now - ts > 600 or ts - now > 300:
            return False
    except (ValueError, TypeError):
        return False

    data = timestamp_header.encode("utf-8") + raw_body
    computed = base64.b64encode(
        hmac.new(secret_key.encode("utf-8"), data, hashlib.sha256).digest()
    ).decode("utf-8")

    return hmac.compare_digest(computed, signature_header)


async def credit_paid_order(
    db: AsyncSession,
    *,
    order: PaymentOrder,
    cf_payment_id: str | None = None,
) -> int:
    """Mark order paid and credit user in credit_ledger idempotently."""
    if cf_payment_id and not order.cf_payment_id:
        order.cf_payment_id = cf_payment_id
    order.status = "paid"
    order.paid_at = func.now()

    existing_credit = (
        await db.execute(
            select(CreditLedger.id).where(CreditLedger.payment_order_id == order.id)
        )
    ).scalar_one_or_none()
    if not existing_credit:
        ledger_entry = CreditLedger(
            id=uuid.uuid4(),
            user_id=order.user_id,
            delta=order.credits,
            reason="purchase",
            payment_order_id=order.id,
            note=f"Package {order.package_code} ({order.credits} credits)",
        )
        db.add(ledger_entry)

    await db.commit()
    return await get_balance(db, order.user_id)
