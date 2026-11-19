"""Billing and Cashfree payment gateway endpoints."""

from __future__ import annotations

import json
import uuid
from typing import Any

from fastapi import APIRouter, Depends, Header, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.api.deps import CurrentUser, DB, SettingsDep
from app.core.errors import Forbidden, NotFound, Unauthorized, ValidationFailed
from app.models import PaymentOrder
from app.services import billing_service

router = APIRouter(prefix="/billing", tags=["billing"])


class OrderCreateRequest(BaseModel):
    package_code: str = Field(..., max_length=32)


class OrderCreateResponse(BaseModel):
    order_id: str
    cf_order_id: str
    payment_session_id: str
    mode: str


class OrderConfirmResponse(BaseModel):
    status: str
    balance: int
    credits: int


class BalanceResponse(BaseModel):
    balance: int
    is_guest: bool
    is_admin: bool = False


@router.get("/packages")
async def get_packages(settings: SettingsDep) -> dict[str, Any]:
    """Public packages and credit costs definition."""
    return {
        "packages": billing_service.PACKAGES,
        "interview_costs": billing_service.INTERVIEW_COSTS,
        "payments_enabled": settings.payments_enabled,
    }


@router.get("/balance", response_model=BalanceResponse)
async def get_balance(user: CurrentUser, db: DB, settings: SettingsDep) -> BalanceResponse:
    """Return the user's current interview credit balance."""
    if user.is_anonymous:
        return BalanceResponse(balance=0, is_guest=True, is_admin=False)

    is_admin = bool(user.email and user.email.lower() in [e.lower() for e in settings.admin_emails])
    balance = await billing_service.get_balance(db, user.id)
    return BalanceResponse(balance=balance, is_guest=False, is_admin=is_admin)


@router.post("/orders", response_model=OrderCreateResponse, status_code=status.HTTP_201_CREATED)
async def create_order(
    body: OrderCreateRequest,
    user: CurrentUser,
    db: DB,
    settings: SettingsDep,
) -> OrderCreateResponse:
    """Create a Cashfree payment order for the chosen credit package."""
    if user.is_anonymous:
        raise Forbidden("Guests cannot purchase credits. Create an account to continue.", code="guest_cannot_purchase")

    pkg = billing_service.PACKAGE_BY_CODE.get(body.package_code)
    if not pkg:
        raise ValidationFailed(f"Unknown package code: '{body.package_code}'", code="UNKNOWN_PACKAGE")

    order_id = f"order_{uuid.uuid4().hex[:16]}"
    return_url = f"{settings.frontend_url.rstrip('/')}/pricing/return?order_id={order_id}"
    notify_url = f"{settings.backend_url.rstrip('/')}/api/v1/billing/cashfree/webhook"

    cf_res = await billing_service.create_cashfree_order(
        settings,
        order_id=order_id,
        amount_inr=pkg["price_inr"],
        customer_id=str(user.id),
        customer_email=user.email or f"{user.id}@example.com",
        return_url=return_url,
        notify_url=notify_url,
    )

    cf_order_id = str(cf_res.get("cf_order_id") or order_id)
    payment_session_id = str(cf_res.get("payment_session_id", ""))

    order = PaymentOrder(
        id=uuid.uuid4(),
        user_id=user.id,
        package_code=pkg["code"],
        credits=pkg["credits"],
        amount_paise=pkg["amount_paise"],
        currency="INR",
        cf_order_id=order_id,
        status="created",
    )
    db.add(order)
    await db.commit()

    return OrderCreateResponse(
        order_id=order_id,
        cf_order_id=cf_order_id,
        payment_session_id=payment_session_id,
        mode=settings.cashfree_env,
    )


@router.post("/orders/{order_id}/confirm", response_model=OrderConfirmResponse)
async def confirm_order(
    order_id: str,
    user: CurrentUser,
    db: DB,
    settings: SettingsDep,
) -> OrderConfirmResponse:
    """Owner only: check order status with Cashfree and credit account idempotently."""
    order = (
        await db.execute(
            select(PaymentOrder).where(
                PaymentOrder.user_id == user.id,
                PaymentOrder.cf_order_id == order_id,
            )
        )
    ).scalar_one_or_none()

    if not order:
        raise NotFound(f"Payment order '{order_id}' not found.", code="ORDER_NOT_FOUND")

    if order.status == "paid":
        current_balance = await billing_service.get_balance(db, user.id)
        return OrderConfirmResponse(status="paid", balance=current_balance, credits=order.credits)

    cf_order = await billing_service.get_cashfree_order(settings, order_id=order_id)
    order_status = str(cf_order.get("order_status", "")).upper()
    order_amount = float(cf_order.get("order_amount", 0))

    expected_amount = order.amount_paise / 100.0
    if abs(order_amount - expected_amount) > 0.01:
        raise ValidationFailed(
            f"Cashfree order amount {order_amount} does not match package amount {expected_amount}",
            code="PAYMENT_AMOUNT_MISMATCH",
        )

    if order_status == "PAID":
        cf_payment_id = None
        new_balance = await billing_service.credit_paid_order(
            db, order=order, cf_payment_id=cf_payment_id
        )
        return OrderConfirmResponse(status="paid", balance=new_balance, credits=order.credits)

    if order_status in ("FAILED", "EXPIRED"):
        order.status = order_status.lower()
        await db.commit()

    current_balance = await billing_service.get_balance(db, user.id)
    return OrderConfirmResponse(status=order.status, balance=current_balance, credits=0)


@router.post("/cashfree/webhook")
async def cashfree_webhook(
    request: Request,
    db: DB,
    settings: SettingsDep,
    x_webhook_timestamp: str = Header(default="", alias="x-webhook-timestamp"),
    x_webhook_signature: str = Header(default="", alias="x-webhook-signature"),
) -> dict[str, str]:
    """Cashfree webhook handler (no auth). Verifies signature and credits on success."""
    raw_body = await request.body()
    if not billing_service.verify_cashfree_webhook_signature(
        timestamp_header=x_webhook_timestamp,
        raw_body=raw_body,
        signature_header=x_webhook_signature,
        secret_key=settings.cashfree_secret_key,
    ):
        raise Unauthorized("Invalid webhook signature or stale timestamp.", code="INVALID_SIGNATURE")

    try:
        payload = json.loads(raw_body)
    except Exception:
        return {"status": "ok"}

    event_type = payload.get("type", "")
    data = payload.get("data", {})

    if event_type == "PAYMENT_SUCCESS_WEBHOOK":
        order_info = data.get("order", {})
        cf_order_id = str(order_info.get("order_id") or data.get("order_id") or "")
        payment_info = data.get("payment", {})
        cf_payment_id = str(payment_info.get("cf_payment_id") or "") or None

        if cf_order_id:
            order = (
                await db.execute(select(PaymentOrder).where(PaymentOrder.cf_order_id == cf_order_id))
            ).scalar_one_or_none()
            if order:
                # Re-fetch from Cashfree API to verify authenticity and amount
                cf_order = await billing_service.get_cashfree_order(settings, order_id=cf_order_id)
                if cf_order.get("order_status") == "PAID":
                    order_amount = float(cf_order.get("order_amount", 0))
                    expected_amount = order.amount_paise / 100.0
                    if abs(order_amount - expected_amount) <= 0.01:
                        await billing_service.credit_paid_order(
                            db, order=order, cf_payment_id=cf_payment_id
                        )

    elif event_type == "PAYMENT_FAILED_WEBHOOK":
        order_info = data.get("order", {})
        cf_order_id = str(order_info.get("order_id") or data.get("order_id") or "")
        if cf_order_id:
            order = (
                await db.execute(select(PaymentOrder).where(PaymentOrder.cf_order_id == cf_order_id))
            ).scalar_one_or_none()
            if order and order.status != "paid":
                order.status = "failed"
                await db.commit()

    return {"status": "ok"}
