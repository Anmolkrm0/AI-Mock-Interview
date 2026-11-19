"""Public contact form submission endpoint."""

from __future__ import annotations

import collections
import time
import uuid

import httpx
from fastapi import APIRouter, Request, status
from pydantic import BaseModel, Field

from app.api.deps import DB, OptionalUser, SettingsDep
from app.core.errors import RateLimited, ValidationFailed
from app.models import ContactMessage

router = APIRouter(prefix="/contact", tags=["contact"])

_CONTACT_RATE_LIMIT: dict[str, list[float]] = collections.defaultdict(list)
_MAX_PER_HOUR = 5


class ContactFormIn(BaseModel):
    name: str = Field(..., min_length=1, max_length=128)
    email: str = Field(..., min_length=3, max_length=255)
    message: str = Field(..., min_length=1, max_length=5000)
    captcha_token: str | None = None


class ContactFormOut(BaseModel):
    status: str
    message_id: str


@router.post("", response_model=ContactFormOut, status_code=status.HTTP_201_CREATED)
async def submit_contact_form(
    body: ContactFormIn,
    request: Request,
    db: DB,
    settings: SettingsDep,
    user: OptionalUser,
) -> ContactFormOut:
    x_forwarded_for = request.headers.get("x-forwarded-for", "")
    client_ip = (
        x_forwarded_for.split(",")[0].strip()
        if x_forwarded_for
        else (request.client.host if request.client else "unknown")
    )

    # In-memory sliding window rate limiting
    now = time.time()
    cutoff = now - 3600
    timestamps = [t for t in _CONTACT_RATE_LIMIT[client_ip] if t > cutoff]
    if len(timestamps) >= _MAX_PER_HOUR:
        raise RateLimited(
            "You have sent too many messages recently. Please try again later.",
            code="contact_rate_limit",
        )
    timestamps.append(now)
    _CONTACT_RATE_LIMIT[client_ip] = timestamps

    # Turnstile bot check if configured
    if settings.turnstile_secret_key:
        if not body.captcha_token:
            raise ValidationFailed("Bot verification token required.", code="turnstile_required")
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.post(
                    "https://challenges.cloudflare.com/turnstile/v0/siteverify",
                    data={
                        "secret": settings.turnstile_secret_key,
                        "response": body.captcha_token,
                        "remoteip": client_ip,
                    },
                )
                data = resp.json()
                if not data.get("success"):
                    raise ValidationFailed(
                        "Bot check failed. Please refresh and try again.", code="turnstile_failed"
                    )
        except ValidationFailed:
            raise
        except Exception:
            raise ValidationFailed(
                "Bot check failed. Please refresh and try again.", code="turnstile_failed"
            )

    user_id = user.id if (user and not user.is_anonymous) else None

    msg = ContactMessage(
        id=uuid.uuid4(),
        name=body.name.strip(),
        email=str(body.email).strip().lower(),
        message=body.message.strip(),
        user_id=user_id,
        handled=False,
    )
    db.add(msg)
    await db.commit()

    return ContactFormOut(status="ok", message_id=str(msg.id))
