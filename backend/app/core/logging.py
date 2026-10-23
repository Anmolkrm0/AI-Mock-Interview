"""Logging with secret redaction.

Never log document text, transcripts, API keys or bearer tokens. A filter scrubs
common secret shapes as a last line of defence.
"""

from __future__ import annotations

import logging
import re

_PATTERNS = [
    re.compile(r"(Bearer\s+)[A-Za-z0-9._\-]+", re.IGNORECASE),
    re.compile(r"(key=)[A-Za-z0-9._\-]+", re.IGNORECASE),
    re.compile(r"(access_token=)[A-Za-z0-9._\-/]+", re.IGNORECASE),
    re.compile(r"(AIza)[A-Za-z0-9_\-]{20,}"),
    re.compile(r"(gsk_)[A-Za-z0-9]{10,}"),
    re.compile(r"(sb_secret_)[A-Za-z0-9_\-]+"),
    re.compile(r"(eyJ)[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+"),
    re.compile(r"(auth_tokens/)[A-Za-z0-9_\-]+"),
]


def redact(text: str) -> str:
    for pattern in _PATTERNS:
        text = pattern.sub(lambda m: m.group(1) + "[REDACTED]", text)
    return text


class RedactingFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        try:
            message = record.getMessage()
        except Exception:  # pragma: no cover - defensive
            return True
        redacted = redact(message)
        if redacted != message:
            record.msg = redacted
            record.args = ()
        return True


def configure_logging(level: str = "INFO") -> None:
    root = logging.getLogger()
    if not any(isinstance(f, RedactingFilter) for f in root.filters):
        handler = logging.StreamHandler()
        handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s %(message)s"))
        handler.addFilter(RedactingFilter())
        root.handlers = [handler]
        root.setLevel(level)
    # httpx logs full URLs at INFO, which may include query-string credentials.
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)
