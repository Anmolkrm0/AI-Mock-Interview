"""Consistent application errors.

Every error leaving the API has the shape::

    {"error": {"code": "...", "message": "...", "retryable": false, "request_id": "..."}}

Internal details (stack traces, SQL, provider payloads, secrets) never reach the client.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from sqlalchemy.exc import OperationalError, SQLAlchemyError
from starlette.exceptions import HTTPException as StarletteHTTPException

logger = logging.getLogger("app.errors")


class AppError(Exception):
    status_code: int = 400
    code: str = "BAD_REQUEST"
    message: str = "The request could not be processed."
    retryable: bool = False

    def __init__(
        self,
        message: str | None = None,
        *,
        code: str | None = None,
        status_code: int | None = None,
        retryable: bool | None = None,
        details: dict[str, Any] | None = None,
    ) -> None:
        self.message = message or self.message
        self.code = code or self.code
        self.status_code = status_code or self.status_code
        if retryable is not None:
            self.retryable = retryable
        self.details = details or {}
        super().__init__(self.message)


class ValidationFailed(AppError):
    status_code = 422
    code = "VALIDATION_FAILED"
    message = "Some of the submitted information is invalid."


class NotFound(AppError):
    status_code = 404
    code = "NOT_FOUND"
    message = "The requested resource was not found."


class Unauthorized(AppError):
    status_code = 401
    code = "AUTH_REQUIRED"
    message = "Sign in to continue."


class Forbidden(AppError):
    status_code = 403
    code = "FORBIDDEN"
    message = "You do not have access to this resource."


class Conflict(AppError):
    status_code = 409
    code = "CONFLICT"
    message = "The request conflicts with the current state."


class RateLimited(AppError):
    status_code = 429
    code = "RATE_LIMITED"
    message = "Too many requests. Wait a moment and try again."
    retryable = True


class ConfigurationError(AppError):
    status_code = 503
    code = "CONFIGURATION_ERROR"
    message = "The server is missing required configuration."


class ProviderError(AppError):
    """Errors raised by AI providers, mapped to stable application codes."""

    status_code = 502
    code = "AI_PROVIDER_ERROR"
    message = "The AI service returned an error."


class StorageError(AppError):
    status_code = 502
    code = "STORAGE_ERROR"
    message = "File storage is temporarily unavailable."
    retryable = True


def _request_id(request: Request) -> str:
    return getattr(request.state, "request_id", "")


def error_body(code: str, message: str, retryable: bool, request_id: str, **extra: Any) -> dict:
    body: dict[str, Any] = {
        "code": code,
        "message": message,
        "retryable": retryable,
        "request_id": request_id,
    }
    body.update({k: v for k, v in extra.items() if v})
    return {"error": body}


def install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(AppError)
    async def _app_error(request: Request, exc: AppError) -> JSONResponse:
        if exc.status_code >= 500:
            logger.warning("app_error code=%s status=%s", exc.code, exc.status_code)
        return JSONResponse(
            status_code=exc.status_code,
            content=error_body(
                exc.code, exc.message, exc.retryable, _request_id(request), details=exc.details
            ),
        )

    @app.exception_handler(RequestValidationError)
    async def _validation(request: Request, exc: RequestValidationError) -> JSONResponse:
        fields = []
        for err in exc.errors()[:20]:
            loc = ".".join(str(p) for p in err.get("loc", []) if p not in ("body", "query", "path"))
            fields.append({"field": loc, "message": err.get("msg", "Invalid value")})
        return JSONResponse(
            status_code=422,
            content=error_body(
                "VALIDATION_FAILED",
                "Some of the submitted information is invalid.",
                False,
                _request_id(request),
                details={"fields": fields},
            ),
        )

    @app.exception_handler(StarletteHTTPException)
    async def _http(request: Request, exc: StarletteHTTPException) -> JSONResponse:
        code = {404: "NOT_FOUND", 405: "METHOD_NOT_ALLOWED", 413: "PAYLOAD_TOO_LARGE"}.get(
            exc.status_code, "HTTP_ERROR"
        )
        message = exc.detail if isinstance(exc.detail, str) else "Request failed."
        return JSONResponse(
            status_code=exc.status_code,
            content=error_body(code, message, False, _request_id(request)),
        )

    @app.exception_handler(OperationalError)
    async def _db_down(request: Request, exc: OperationalError) -> JSONResponse:
        logger.error("database_unavailable request_id=%s", _request_id(request))
        return JSONResponse(
            status_code=503,
            content=error_body(
                "DATABASE_UNAVAILABLE",
                "The database is temporarily unavailable. Try again shortly.",
                True,
                _request_id(request),
            ),
        )

    @app.exception_handler(SQLAlchemyError)
    async def _db_error(request: Request, exc: SQLAlchemyError) -> JSONResponse:
        logger.error("database_error type=%s request_id=%s", type(exc).__name__, _request_id(request))
        return JSONResponse(
            status_code=500,
            content=error_body("DATABASE_ERROR", "A database error occurred.", True, _request_id(request)),
        )

    @app.exception_handler(Exception)
    async def _unhandled(request: Request, exc: Exception) -> JSONResponse:
        logger.exception("unhandled_error request_id=%s", _request_id(request))
        return JSONResponse(
            status_code=500,
            content=error_body("INTERNAL_ERROR", "An unexpected error occurred.", True, _request_id(request)),
        )
