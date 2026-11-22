from __future__ import annotations

import zlib
from collections.abc import Iterator
from pathlib import Path

import numpy as np
import pytest
import respx

from ideation_goat import fetch as fetch_module
from ideation_goat.cache import Cache
from ideation_goat.config import Settings
from ideation_goat.fetch import Fetcher
from ideation_goat.search import tokenize


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    return Settings(
        _env_file=None,  # type: ignore[call-arg]
        github_token=None,
        gemini_api_key=None,
        groq_api_key=None,
        semantic_scholar_api_key=None,
        home=tmp_path / "home",
        workspace_root=tmp_path,
        cache_enabled=False,
        index_url="https://example.invalid/index.tar.gz",
    )


@pytest.fixture
def fetcher(settings: Settings) -> Fetcher:
    return Fetcher(settings, cache=Cache(None))


@pytest.fixture(autouse=True)
def _no_waiting(monkeypatch: pytest.MonkeyPatch) -> None:
    """Skip host spacing and retry backoff so tests run instantly."""
    fetch_module._next_slot.clear()

    async def instant(_: float) -> None:
        return None

    monkeypatch.setattr(fetch_module.asyncio, "sleep", instant)


@pytest.fixture
def mock() -> Iterator[respx.MockRouter]:
    with respx.mock(assert_all_called=False, assert_all_mocked=True) as router:
        yield router


class FakeEmbedder:
    """Bag-of-words hashing embedder: deterministic, no model download."""

    name = "fake-embedder"
    dim = 64

    def _vec(self, text: str) -> np.ndarray:
        v = np.zeros(self.dim, dtype=np.float32)
        for token in tokenize(text):
            v[zlib.crc32(token.encode()) % self.dim] += 1.0
        n = np.linalg.norm(v)
        return v / n if n else v

    def embed_documents(self, texts: list[str]) -> np.ndarray:
        return np.array([self._vec(t) for t in texts], dtype=np.float32)

    def embed_query(self, text: str) -> np.ndarray:
        return self._vec(text)


@pytest.fixture
def fake_embedder() -> FakeEmbedder:
    return FakeEmbedder()
