"""Authentication helpers: profile provisioning and ownership checks."""

from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import NotFound
from app.core.security import AuthenticatedUser
from app.models import Document, GuestConversion, Interview, Profile

_known_profiles: set[uuid.UUID] = set()


async def ensure_profile(db: AsyncSession, user: AuthenticatedUser) -> None:
    """Create the profile row on first contact (idempotent), and record conversions."""
    name = None
    meta = user.claims.get("user_metadata") or {}
    if isinstance(meta, dict):
        name = meta.get("display_name") or meta.get("full_name")

    if user.id not in _known_profiles:
        await db.execute(
            insert(Profile)
            .values(id=user.id, display_name=(name or None), is_anonymous=user.is_anonymous)
            .on_conflict_do_nothing(index_elements=[Profile.id])
        )
        await db.commit()
        _known_profiles.add(user.id)

    # If the user is now registered, ensure profile is marked non-anonymous and record conversion
    if not user.is_anonymous:
        prof = await db.get(Profile, user.id)
        if prof and prof.is_anonymous:
            prof.is_anonymous = False
            if name and not prof.display_name:
                prof.display_name = name
            db.add(
                GuestConversion(
                    id=uuid.uuid4(),
                    conversion_type="signup",
                    guest_user_id=user.id,
                    registered_user_id=user.id,
                )
            )
            await db.commit()


def forget_profile_cache() -> None:
    _known_profiles.clear()


async def get_owned_interview(
    db: AsyncSession, user_id: uuid.UUID, interview_id: uuid.UUID, *, for_update: bool = False
) -> Interview:
    """Load an interview only if it belongs to ``user_id``.

    A foreign interview is reported as "not found" rather than "forbidden" so
    the API does not reveal which ids exist.
    """
    stmt = select(Interview).where(Interview.id == interview_id, Interview.user_id == user_id)
    if for_update:
        stmt = stmt.with_for_update()
    interview = (await db.execute(stmt)).scalar_one_or_none()
    if interview is None:
        raise NotFound("Interview not found.", code="INTERVIEW_NOT_FOUND")
    return interview


async def get_owned_document(db: AsyncSession, user_id: uuid.UUID, document_id: uuid.UUID) -> Document:
    doc = (
        await db.execute(select(Document).where(Document.id == document_id, Document.user_id == user_id))
    ).scalar_one_or_none()
    if doc is None:
        raise NotFound("Document not found.", code="DOCUMENT_NOT_FOUND")
    return doc
