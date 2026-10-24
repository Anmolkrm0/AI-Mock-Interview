"""FastAPI application factory."""

from __future__ import annotations

import asyncio
import contextlib
import logging
import uuid
from collections.abc import AsyncIterator

from fastapi import APIRouter, FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware

from app.api.v1 import admin, documents, health, interviews, recordings, roles, users
from app.core.config import get_settings
from app.core.errors import install_error_handlers
from app.core.logging import configure_logging
from app.db.session import dispose_engine, get_sessionmaker
from app.providers.factory import get_provider_registry
from app.storage.supabase_storage import get_storage_client
from app.workers.jobs import worker_loop

logger = logging.getLogger("app")


@contextlib.asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings = get_settings()
    stop = asyncio.Event()
    task: asyncio.Task | None = None
    if settings.run_worker and settings.database_url:
        task = asyncio.create_task(
            worker_loop(
                get_sessionmaker(), get_provider_registry().evaluation, get_storage_client(), settings, stop
            )
        )
    try:
        yield
    finally:
        stop.set()
        if task:
            with contextlib.suppress(Exception):
                await asyncio.wait_for(task, timeout=10)
        await dispose_engine()


def create_app() -> FastAPI:
    settings = get_settings()
    configure_logging("INFO")
    app = FastAPI(
        title=settings.app_name,
        version=settings.app_version,
        lifespan=lifespan,
        docs_url=None if settings.is_production else "/docs",
        redoc_url=None,
        openapi_url=None if settings.is_production else "/openapi.json",
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=False,
        allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type", "Idempotency-Key", "X-Request-Id"],
        expose_headers=["X-Request-Id"],
        max_age=600,
    )

    @app.middleware("http")
    async def request_context(request: Request, call_next):
        incoming = request.headers.get("x-request-id", "")
        request_id = incoming if 8 <= len(incoming) <= 64 and incoming.isascii() else uuid.uuid4().hex
        request.state.request_id = request_id
        response = await call_next(request)
        response.headers["X-Request-Id"] = request_id
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["Cache-Control"] = "no-store"
        return response

    install_error_handlers(app)
    api = APIRouter(prefix="/api/v1")
    api.include_router(health.router)
    api.include_router(documents.router)
    api.include_router(roles.router)
    api.include_router(interviews.router)
    api.include_router(recordings.router)
    api.include_router(admin.router)
    api.include_router(users.router)
    app.include_router(api)

    @app.get("/", include_in_schema=False)
    async def root() -> dict:
        return {"service": settings.app_name, "health": "/api/v1/health"}

    return app


app = create_app()
