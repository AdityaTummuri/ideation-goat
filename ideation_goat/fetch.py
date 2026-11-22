"""Async HTTP client shared by every data source.

It adds four things on top of httpx: a timeout on every call, retries with backoff
for 429 and 5xx responses, a minimum spacing between requests per host (arXiv asks
for one request every 3 seconds), and the SQLite TTL cache.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import time
from collections import defaultdict
from dataclasses import dataclass
from datetime import UTC, datetime
from types import TracebackType
from typing import Any
from urllib.parse import urlencode, urlsplit

import httpx

from ideation_goat.cache import HOUR, Cache, CachedEntry
from ideation_goat.config import Settings, get_settings
from ideation_goat.models import Source

logger = logging.getLogger(__name__)

RETRY_STATUSES = {429, 500, 502, 503, 504}
MAX_ATTEMPTS = 3
MAX_RETRY_AFTER = 10.0


@dataclass(frozen=True)
class HostPolicy:
    min_interval: float = 0.0
    concurrency: int = 8


HOST_POLICIES: dict[str, HostPolicy] = {
    "export.arxiv.org": HostPolicy(min_interval=3.0, concurrency=1),
    "api.semanticscholar.org": HostPolicy(min_interval=1.0, concurrency=1),
}

# Next time each host may be called. Module-level so spacing holds across clients
# in one process; reading and updating it never awaits, so it's safe in asyncio.
_next_slot: dict[str, float] = defaultdict(float)


@dataclass(frozen=True)
class Response:
    status: int
    text: str
    url: str
    fetched_at: datetime
    link: str | None = None
    from_cache: bool = False

    @property
    def ok(self) -> bool:
        return 200 <= self.status < 300

    def json(self) -> Any:
        return json.loads(self.text)

    @property
    def source(self) -> Source:
        return Source(url=self.url, fetched_at=self.fetched_at)


class FetchError(Exception):
    """The request failed after retries (network error or repeated 429/5xx)."""

    def __init__(self, url: str, reason: str) -> None:
        super().__init__(f"{url}: {reason}")
        self.url = url
        self.reason = reason


class Fetcher:
    """Use as ``async with Fetcher() as fetch:``; one per operation."""

    def __init__(
        self,
        settings: Settings | None = None,
        cache: Cache | None = None,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self.settings = settings or get_settings()
        if cache is None:
            cache = Cache(self.settings.cache_path if self.settings.cache_enabled else None)
        self.cache = cache
        self._client = client
        self._owns_client = client is None
        self._semaphores: dict[str, asyncio.Semaphore] = {}

    async def __aenter__(self) -> Fetcher:
        if self._client is None:
            self._client = httpx.AsyncClient(
                timeout=self.settings.http_timeout,
                follow_redirects=True,
                headers={"User-Agent": self.settings.user_agent},
            )
        return self

    async def __aexit__(
        self, exc_type: type[BaseException] | None, exc: BaseException | None, tb: TracebackType | None
    ) -> None:
        if self._owns_client and self._client is not None:
            await self._client.aclose()
            self._client = None

    async def get(
        self,
        url: str,
        *,
        params: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
        ttl: float = HOUR,
    ) -> Response:
        return await self._request("GET", url, params=params, headers=headers, ttl=ttl)

    async def post(
        self,
        url: str,
        *,
        json_body: Any,
        headers: dict[str, str] | None = None,
        ttl: float = HOUR,
    ) -> Response:
        return await self._request("POST", url, json_body=json_body, headers=headers, ttl=ttl)

    async def _request(
        self,
        method: str,
        url: str,
        *,
        params: dict[str, Any] | None = None,
        json_body: Any = None,
        headers: dict[str, str] | None = None,
        ttl: float,
    ) -> Response:
        full_url = f"{url}?{urlencode(params, doseq=True)}" if params else url
        body = json.dumps(json_body, sort_keys=True) if json_body is not None else None
        key = hashlib.sha256(f"{method} {full_url} {body or ''}".encode()).hexdigest()

        cached = self.cache.get(key)
        if cached is not None:
            return Response(
                status=cached.status,
                text=cached.body,
                url=full_url,
                fetched_at=datetime.fromtimestamp(cached.fetched_at, UTC),
                link=cached.link,
                from_cache=True,
            )

        response = await self._send(method, full_url, body, headers or {})
        if response.ok:
            store_for = ttl
        elif response.status == 404:
            store_for = min(ttl, HOUR)
        else:
            store_for = 0
        self.cache.set(
            key,
            CachedEntry(response.status, response.text, response.link, response.fetched_at.timestamp()),
            store_for,
        )
        return response

    async def _send(self, method: str, url: str, body: str | None, headers: dict[str, str]) -> Response:
        assert self._client is not None, "use Fetcher as an async context manager"
        host = urlsplit(url).hostname or ""
        policy = HOST_POLICIES.get(host, HostPolicy())
        semaphore = self._semaphores.setdefault(host, asyncio.Semaphore(policy.concurrency))
        request_headers = dict(headers)
        if body is not None:
            request_headers.setdefault("Content-Type", "application/json")

        last_reason = "no attempts made"
        for attempt in range(MAX_ATTEMPTS):
            async with semaphore:
                await _wait_for_slot(host, policy.min_interval)
                try:
                    raw = await self._client.request(method, url, content=body, headers=request_headers)
                except httpx.HTTPError as exc:
                    last_reason = f"{type(exc).__name__}: {exc}"
                    raw = None
            if raw is not None and raw.status_code not in RETRY_STATUSES:
                return Response(
                    status=raw.status_code,
                    text=raw.text,
                    url=url,
                    fetched_at=datetime.now(UTC),
                    link=raw.headers.get("link"),
                )
            delay = 2.0**attempt
            if raw is not None:
                last_reason = f"HTTP {raw.status_code}"
                retry_after = raw.headers.get("retry-after", "")
                if retry_after.isdigit():
                    delay = min(float(retry_after), MAX_RETRY_AFTER)
            if attempt < MAX_ATTEMPTS - 1:
                logger.info("Retrying %s %s in %.1fs (%s)", method, url, delay, last_reason)
                await asyncio.sleep(delay)
        raise FetchError(url, last_reason)


async def _wait_for_slot(host: str, min_interval: float) -> None:
    if min_interval <= 0:
        return
    now = time.monotonic()
    start = max(now, _next_slot[host])
    _next_slot[host] = start + min_interval
    if start > now:
        await asyncio.sleep(start - now)
