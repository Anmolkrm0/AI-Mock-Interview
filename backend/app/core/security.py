"""Supabase access-token verification.

The backend never trusts a user id sent by the browser. It verifies the
Supabase access token itself:

* Projects using asymmetric JWT signing keys (ES256/RS256, the current Supabase
  default) are verified against the project's public JWKS at
  ``{SUPABASE_URL}/auth/v1/.well-known/jwks.json``.
* Projects still on the legacy shared secret (HS256) are verified with
  ``SUPABASE_JWT_SECRET``.

Issuer, audience, expiry and subject are all checked.
"""

from __future__ import annotations

import asyncio
import time
import uuid
from dataclasses import dataclass
from typing import Any

import jwt
from jwt import PyJWKClient

from app.core.config import Settings
from app.core.errors import ConfigurationError, Unauthorized

_ASYMMETRIC = {"ES256", "RS256", "EdDSA"}


@dataclass(frozen=True)
class AuthenticatedUser:
    id: uuid.UUID
    email: str | None
    claims: dict[str, Any]


class TokenVerifier:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._jwks: PyJWKClient | None = None
        if settings.supabase_url:
            # PyJWKClient caches keys and refetches on unknown kid.
            self._jwks = PyJWKClient(settings.supabase_jwks_url, cache_keys=True, lifespan=600, timeout=10)

    def _decode(self, token: str) -> dict[str, Any]:
        try:
            header = jwt.get_unverified_header(token)
        except jwt.PyJWTError as exc:
            raise Unauthorized("Your session is invalid. Sign in again.", code="AUTH_INVALID") from exc

        alg = header.get("alg", "")
        options = {"require": ["exp", "sub", "aud"]}
        audience = self._settings.supabase_jwt_audience
        issuer = self._settings.supabase_issuer if self._settings.supabase_url else None
        try:
            if alg in _ASYMMETRIC:
                if self._jwks is None:
                    raise ConfigurationError(
                        "SUPABASE_URL is required to verify sign-in tokens.",
                        code="AUTH_NOT_CONFIGURED",
                    )
                key = self._jwks.get_signing_key_from_jwt(token).key
                return jwt.decode(
                    token,
                    key,
                    algorithms=[alg],
                    audience=audience,
                    issuer=issuer,
                    options=options,
                    leeway=30,
                )
            if alg == "HS256":
                if not self._settings.supabase_jwt_secret:
                    raise ConfigurationError(
                        "This project signs tokens with a shared secret; set SUPABASE_JWT_SECRET.",
                        code="AUTH_NOT_CONFIGURED",
                    )
                return jwt.decode(
                    token,
                    self._settings.supabase_jwt_secret,
                    algorithms=["HS256"],
                    audience=audience,
                    issuer=issuer,
                    options=options,
                    leeway=30,
                )
        except jwt.ExpiredSignatureError as exc:
            raise Unauthorized("Your session has expired. Sign in again.", code="AUTH_EXPIRED") from exc
        except jwt.PyJWKClientError as exc:
            raise Unauthorized(
                "Could not verify your session right now.",
                code="AUTH_KEYS_UNAVAILABLE",
                retryable=True,
            ) from exc
        except jwt.PyJWTError as exc:
            raise Unauthorized("Your session is invalid. Sign in again.", code="AUTH_INVALID") from exc
        raise Unauthorized("Unsupported token type.", code="AUTH_INVALID")

    async def verify(self, token: str) -> AuthenticatedUser:
        # JWKS fetches are blocking network calls; keep them off the event loop.
        claims = await asyncio.to_thread(self._decode, token)
        if claims.get("role") not in (None, "authenticated"):
            raise Unauthorized("This token cannot be used to access interviews.", code="AUTH_INVALID")
        try:
            user_id = uuid.UUID(str(claims["sub"]))
        except (KeyError, ValueError) as exc:
            raise Unauthorized("Your session is invalid. Sign in again.", code="AUTH_INVALID") from exc
        if claims.get("exp", 0) < time.time() - 30:
            raise Unauthorized("Your session has expired. Sign in again.", code="AUTH_EXPIRED")
        return AuthenticatedUser(id=user_id, email=claims.get("email"), claims=claims)
