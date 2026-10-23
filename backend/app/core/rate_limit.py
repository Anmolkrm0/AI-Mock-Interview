"""Per-user sliding-window rate limiting.

State is per process. On Render's free plan there is a single instance, so this
is effective; if you scale out, move this to Redis or Postgres.
"""

from __future__ import annotations

import time
from collections import defaultdict, deque
from threading import Lock

from app.core.errors import RateLimited


class RateLimiter:
    def __init__(self) -> None:
        self._hits: dict[str, deque[float]] = defaultdict(deque)
        self._lock = Lock()

    def check(self, key: str, limit: int, window_seconds: float = 60.0) -> None:
        now = time.monotonic()
        with self._lock:
            hits = self._hits[key]
            while hits and now - hits[0] > window_seconds:
                hits.popleft()
            if len(hits) >= limit:
                retry_after = max(1, int(window_seconds - (now - hits[0])))
                raise RateLimited(
                    f"Too many requests. Try again in {retry_after} seconds.",
                    details={"retry_after_seconds": retry_after},
                )
            hits.append(now)

    def reset(self) -> None:
        with self._lock:
            self._hits.clear()


rate_limiter = RateLimiter()
