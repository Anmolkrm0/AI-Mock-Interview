"""Guest sessions and claim endpoint."""

from __future__ import annotations

import logging
import uuid
from typing import Annotated

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy import select, update

from app.api.deps import DB, CurrentUser, get_token_verifier
from app.core.errors import BadRequest, Forbidden, Unauthorized
from app.core.rate_limit import rate_limiter
from app.core.security import TokenVerifier
from app.models import (
    AIUsage,
    Document,
    Feedback,
    GuestConversion,
    Interview,
    Profile,
    Recording,
    RecordingUpload,
)
from app.services.auth_service import forget_profile_cache

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/guest", tags=["guest"])


class GuestClaimIn(BaseModel):
    guest_token: str = Field(..., min_length=1)


class GuestClaimOut(BaseModel):
    claimed: bool
    claimed_interviews: int


@router.post("/claim", response_model=GuestClaimOut)
async def claim_guest_session(
    body: GuestClaimIn,
    user: CurrentUser,
    db: DB,
    verifier: Annotated[TokenVerifier, Depends(get_token_verifier)],
) -> GuestClaimOut:
    # 1. Caller must be registered (not anonymous)
    if user.is_anonymous:
        raise Forbidden("Only registered users can claim a guest session.", code="GUEST_CANNOT_CLAIM")

    # 2. Rate-limit by caller id
    rate_limiter.check(f"guest_claim:{user.id}", 10)

    # 3. Verify guest token (never log the token)
    try:
        guest_user = await verifier.verify(body.guest_token.strip())
    except Unauthorized:
        raise BadRequest("Invalid or expired guest session.", code="INVALID_GUEST_TOKEN") from None

    if not guest_user.is_anonymous:
        raise BadRequest(
            "The provided session is not an anonymous guest session.", code="INVALID_GUEST_TOKEN"
        )

    if guest_user.id == user.id:
        return GuestClaimOut(claimed=True, claimed_interviews=0)

    guest_id = guest_user.id
    target_id = user.id

    # 4. In ONE database transaction, migrate ownership
    # Count interviews to claim
    interviews = (await db.execute(select(Interview.id).where(Interview.user_id == guest_id))).scalars().all()
    claimed_count = len(interviews)

    guest_prof = await db.get(Profile, guest_id)
    if claimed_count == 0 and guest_prof is None:
        # Idempotent: already claimed or no records exist
        return GuestClaimOut(claimed=True, claimed_interviews=0)

    # Reassign Documents
    await db.execute(update(Document).where(Document.user_id == guest_id).values(user_id=target_id))

    # Reassign Interviews
    await db.execute(update(Interview).where(Interview.user_id == guest_id).values(user_id=target_id))

    # Handle Recording (user_id is PK)
    guest_rec = await db.get(Recording, guest_id)
    target_rec = await db.get(Recording, target_id)
    if guest_rec:
        if target_rec:
            await db.delete(guest_rec)
        else:
            await db.execute(update(Recording).where(Recording.user_id == guest_id).values(user_id=target_id))

    # Reassign RecordingUploads
    await db.execute(
        update(RecordingUpload).where(RecordingUpload.user_id == guest_id).values(user_id=target_id)
    )

    # Reassign Feedback
    await db.execute(update(Feedback).where(Feedback.user_id == guest_id).values(user_id=target_id))

    # Reassign AIUsage
    await db.execute(update(AIUsage).where(AIUsage.user_id == guest_id).values(user_id=target_id))

    # Delete guest profile
    if guest_prof:
        await db.delete(guest_prof)

    # Record conversion
    db.add(
        GuestConversion(
            id=uuid.uuid4(),
            conversion_type="claim",
            guest_user_id=guest_id,
            registered_user_id=target_id,
        )
    )

    await db.commit()
    forget_profile_cache()

    return GuestClaimOut(claimed=True, claimed_interviews=claimed_count)
