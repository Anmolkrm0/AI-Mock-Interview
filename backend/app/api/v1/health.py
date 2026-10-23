from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from sqlalchemy import text

from app.api.deps import Providers, SettingsDep
from app.db.session import get_sessionmaker

router = APIRouter(tags=["health"])

EXPECTED_HEAD = "0002"


async def _db_state() -> tuple[str, str | None]:
    try:
        async with get_sessionmaker()() as db:
            await db.execute(text("select 1"))
            try:
                version = (await db.execute(text("select version_num from alembic_version"))).scalar()
            except Exception:
                version = None
            return "ok", version
    except Exception:
        return "unavailable", None


@router.get("/health")
async def health(settings: SettingsDep, providers: Providers) -> dict:
    """Liveness plus a configuration summary. Never exposes secrets."""
    db_status, migration = await _db_state()
    return {
        "status": "ok" if db_status == "ok" else "degraded",
        "version": settings.app_version,
        "environment": settings.environment,
        "database": {"status": db_status, "migration": migration, "up_to_date": migration == EXPECTED_HEAD},
        "providers": providers.status(),
        "storage": {"configured": bool(settings.supabase_url and settings.supabase_secret_key)},
        "auth": {"configured": bool(settings.supabase_url or settings.supabase_jwt_secret)},
    }


@router.get("/ready")
async def ready() -> JSONResponse:
    """Readiness for Render health checks: DB reachable and migrations applied."""
    db_status, migration = await _db_state()
    ok = db_status == "ok" and migration == EXPECTED_HEAD
    return JSONResponse(
        status_code=200 if ok else 503,
        content={"ready": ok, "database": db_status, "migration": migration},
    )
