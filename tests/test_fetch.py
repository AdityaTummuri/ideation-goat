import time
from pathlib import Path

import httpx
import pytest
import respx

from ideation_goat.cache import Cache
from ideation_goat.config import Settings
from ideation_goat.fetch import Fetcher, FetchError

URL = "https://api.example.com/thing"


@pytest.mark.anyio
async def test_retries_429_then_succeeds(fetcher: Fetcher, mock: respx.MockRouter) -> None:
    route = mock.get(URL).mock(
        side_effect=[
            httpx.Response(429, headers={"retry-after": "1"}),
            httpx.Response(200, json={"ok": True}),
        ]
    )
    async with fetcher as f:
        response = await f.get(URL)
    assert response.ok and response.json() == {"ok": True}
    assert route.call_count == 2


@pytest.mark.anyio
async def test_gives_up_after_repeated_errors(fetcher: Fetcher, mock: respx.MockRouter) -> None:
    mock.get(URL).mock(side_effect=httpx.ConnectError("down"))
    async with fetcher as f:
        with pytest.raises(FetchError, match="ConnectError"):
            await f.get(URL)


@pytest.mark.anyio
async def test_404_is_returned_not_raised(fetcher: Fetcher, mock: respx.MockRouter) -> None:
    mock.get(URL).respond(404)
    async with fetcher as f:
        response = await f.get(URL)
    assert response.status == 404 and not response.ok


@pytest.mark.anyio
async def test_cache_hit_keeps_original_fetch_time(
    settings: Settings, tmp_path: Path, mock: respx.MockRouter
) -> None:
    route = mock.get(URL).respond(200, json={"n": 1})
    cache = Cache(tmp_path / "c.sqlite")
    async with Fetcher(settings, cache=cache) as f:
        first = await f.get(URL, params={"a": 1})
        second = await f.get(URL, params={"a": 1})
    assert route.call_count == 1
    assert second.from_cache and second.fetched_at == first.fetched_at
    assert second.json() == {"n": 1}


@pytest.mark.anyio
async def test_server_errors_are_not_cached(
    settings: Settings, tmp_path: Path, mock: respx.MockRouter
) -> None:
    route = mock.get(URL).respond(500)
    cache = Cache(tmp_path / "c.sqlite")
    async with Fetcher(settings, cache=cache) as f:
        for _ in range(2):
            with pytest.raises(FetchError):
                await f.get(URL)
    assert route.call_count == 6  # 3 attempts each time, nothing served from cache


def test_cache_expiry(tmp_path: Path) -> None:
    from ideation_goat.cache import CachedEntry

    cache = Cache(tmp_path / "c.sqlite")
    cache.set("k", CachedEntry(200, "body", None, time.time()), ttl=-1)
    assert cache.get("k") is None
    cache.set("k", CachedEntry(200, "body", None, time.time()), ttl=60)
    assert cache.get("k") is not None
    cache.clear()
    assert cache.get("k") is None
    cache.close()
