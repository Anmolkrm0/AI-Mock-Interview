"""Authentication helpers: profile provisioning and ownership checks."""

from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import NotFound
from app.core.security import AuthenticatedUser
from app.models import Document, Interview, Profile

_known_profiles: set[uuid.UUID] = set()


async def ensure_profile(db: AsyncSession, user: AuthenticatedUser) -> None:
    """Create the profile row on first contact (idempotent)."""
    if user.id in _known_profiles:
        return
    name = None
    meta = user.claims.get("user_metadata") or {}
    if isinstance(meta, dict):
        name = meta.get("display_name") or meta.get("full_name")
    await db.execute(
        insert(Profile)
        .values(id=user.id, display_name=(name or None))
        .on_conflict_do_nothing(index_elements=[Profile.id])
    )
    await db.commit()
    _known_profiles.add(user.id)


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
