"""Locate, download and load the prebuilt repo index."""

from __future__ import annotations

import logging
import shutil
import tarfile
import tempfile
import threading
from pathlib import Path

import httpx

from ideation_goat.config import Settings
from ideation_goat.search import FastEmbedder, RepoIndex

logger = logging.getLogger(__name__)
REQUIRED_FILES = ("meta.json", "repos.jsonl", "embeddings.npy", "owners.npy")
MAX_DOWNLOAD_BYTES = 500_000_000

_lock = threading.Lock()
_loaded: dict[tuple[Path, str], RepoIndex] = {}


class IndexUnavailableError(RuntimeError):
    pass


def index_present(directory: Path) -> bool:
    return all((directory / name).is_file() for name in REQUIRED_FILES)


def download_index(settings: Settings) -> Path:
    """Download the index tarball from the latest GitHub release and unpack it safely."""
    target = settings.index_dir
    target.parent.mkdir(parents=True, exist_ok=True)
    logger.info("Downloading index from %s", settings.index_url)
    with tempfile.TemporaryDirectory(dir=target.parent) as tmp:
        archive = Path(tmp) / "index.tar.gz"
        try:
            with httpx.stream(
                "GET",
                settings.index_url,
                follow_redirects=True,
                timeout=60,
                headers={"User-Agent": settings.user_agent},
            ) as response:
                response.raise_for_status()
                size = 0
                with archive.open("wb") as fh:
                    for chunk in response.iter_bytes():
                        size += len(chunk)
                        if size > MAX_DOWNLOAD_BYTES:
                            raise IndexUnavailableError("index download is larger than expected; aborting")
                        fh.write(chunk)
        except httpx.HTTPError as exc:
            raise IndexUnavailableError(f"could not download the index: {exc}") from exc
        unpacked = Path(tmp) / "unpacked"
        with tarfile.open(archive, "r:gz") as tar:
            tar.extractall(unpacked, filter="data")
        source = unpacked / "index" if (unpacked / "index").is_dir() else unpacked
        if not index_present(source):
            raise IndexUnavailableError("downloaded archive does not contain a complete index")
        if target.exists():
            shutil.rmtree(target)
        shutil.move(str(source), target)
    return target


def pack_index(directory: Path, archive: Path) -> Path:
    with tarfile.open(archive, "w:gz") as tar:
        for name in REQUIRED_FILES:
            tar.add(directory / name, arcname=f"index/{name}")
    return archive


def get_index(settings: Settings, allow_download: bool = True) -> RepoIndex:
    key = (settings.index_dir, settings.embedding_model)
    with _lock:
        if key in _loaded:
            return _loaded[key]
        if not index_present(settings.index_dir):
            if not allow_download:
                raise IndexUnavailableError(f"no index at {settings.index_dir}")
            download_index(settings)
        embedder = FastEmbedder(settings.embedding_model, settings.home / "models")
        index = RepoIndex.load(settings.index_dir, embedder)
        _loaded[key] = index
        return index


def forget_loaded() -> None:
    with _lock:
        _loaded.clear()
