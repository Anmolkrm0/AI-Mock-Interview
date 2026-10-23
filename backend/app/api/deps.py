"""Shared FastAPI dependencies."""

from __future__ import annotations

from collections.abc import AsyncIterator
from functools import lru_cache
from typing import Annotated

from fastapi import Depends, Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings, get_settings
from app.core.errors import Unauthorized
from app.core.rate_limit import rate_limiter
from app.core.security import AuthenticatedUser, TokenVerifier
from app.db.session import get_db
from app.providers.factory import ProviderRegistry, get_provider_registry
from app.services.auth_service import ensure_profile
from app.storage.supabase_storage import StorageClient, get_storage_client


@lru_cache
def _verifier() -> TokenVerifier:
    return TokenVerifier(get_settings())


def get_token_verifier() -> TokenVerifier:
    return _verifier()


async def db_session() -> AsyncIterator[AsyncSession]:
    async for session in get_db():
        yield session


DB = Annotated[AsyncSession, Depends(db_session)]
SettingsDep = Annotated[Settings, Depends(get_settings)]


async def current_user(
    request: Request,
    db: DB,
    verifier: Annotated[TokenVerifier, Depends(get_token_verifier)],
    settings: SettingsDep,
) -> AuthenticatedUser:
    header = request.headers.get("authorization", "")
    scheme, _, token = header.partition(" ")
    if scheme.lower() != "bearer" or not token:
        raise Unauthorized()
    user = await verifier.verify(token.strip())
    rate_limiter.check(f"default:{user.id}", settings.rate_limit_default_per_minute)
    await ensure_profile(db, user)
    request.state.user_id = str(user.id)
    return user


CurrentUser = Annotated[AuthenticatedUser, Depends(current_user)]
Providers = Annotated[ProviderRegistry, Depends(get_provider_registry)]
Storage = Annotated[StorageClient, Depends(get_storage_client)]


def limit_ai(user: AuthenticatedUser, settings: Settings) -> None:
    rate_limiter.check(f"ai:{user.id}", settings.rate_limit_ai_per_minute)
