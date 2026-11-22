from pathlib import Path

import pytest

from ideation_goat.search import RepoDoc, RepoIndex, tokenize

DOCS = [
    RepoDoc("fastapi/fastapi", "FastAPI framework, high performance web APIs with Python type hints", ["api", "asgi"],
            "Python", 100_000, "MIT", None, "async web framework for building APIs with Python"),
    RepoDoc("pallets/flask", "The Python micro framework for building web applications", ["wsgi", "web"],
            "Python", 70_000, "BSD-3-Clause", None, "lightweight WSGI web application framework"),
    RepoDoc("expressjs/express", "Fast, unopinionated, minimalist web framework for node", ["nodejs", "web"],
            "JavaScript", 65_000, "MIT", None, "web framework for node javascript servers"),
    RepoDoc("redis/redis", "In-memory data store used as a cache, vector database and message broker", ["cache"],
            "C", 70_000, None, None, "key value store caching rate limiting queues"),
    RepoDoc("tokio-rs/tokio", "A runtime for writing reliable asynchronous applications with Rust", ["async"],
            "Rust", 28_000, "MIT", None, "asynchronous runtime networking io"),
]  # fmt: skip


def test_tokenize_normalises_plurals_and_drops_stopwords() -> None:
    assert tokenize("The libraries for caching APIs in C++ and C#") == [
        "library",
        "caching",
        "api",
        "c++",
        "c#",
    ]
    assert tokenize("process class") == ["process", "class"]


@pytest.fixture
def index(fake_embedder) -> RepoIndex:  # type: ignore[no-untyped-def]
    return RepoIndex.build(DOCS, fake_embedder, {"built_at": "2026-11-23T00:00:00+00:00"})


def test_hybrid_finds_relevant_repo(index: RepoIndex) -> None:
    hits = index.search("async python web framework for APIs", k=3)
    assert hits[0].doc.repo == "fastapi/fastapi"
    assert "python" in hits[0].matched_terms


@pytest.mark.parametrize("mode", ["bm25", "embeddings", "hybrid"])
def test_each_mode_returns_results(index: RepoIndex, mode: str) -> None:
    hits = index.search("in-memory cache", k=2, mode=mode)  # type: ignore[arg-type]
    assert "redis/redis" in [h.doc.repo for h in hits]


def test_language_filter(index: RepoIndex) -> None:
    hits = index.search("web framework", language="javascript", k=5)
    assert [h.doc.repo for h in hits] == ["expressjs/express"]
    assert index.search("web framework", language="cobol") == []


def test_save_and_load_round_trip(index: RepoIndex, tmp_path: Path, fake_embedder) -> None:  # type: ignore[no-untyped-def]
    index.save(tmp_path)
    loaded = RepoIndex.load(tmp_path, fake_embedder)
    assert [d.repo for d in loaded.docs] == [d.repo for d in DOCS]
    assert loaded.search("rust asynchronous runtime")[0].doc.repo == "tokio-rs/tokio"


def test_load_rejects_a_different_embedding_model(index: RepoIndex, tmp_path: Path, fake_embedder) -> None:  # type: ignore[no-untyped-def]
    index.save(tmp_path)
    fake_embedder.name = "other-model"
    with pytest.raises(ValueError, match="built with fake-embedder"):
        RepoIndex.load(tmp_path, fake_embedder)


def test_language_named_in_query_is_preferred_not_required(index: RepoIndex) -> None:
    from ideation_goat.search import mentioned_languages

    assert mentioned_languages("web framework for a Node API") == {"javascript", "typescript"}
    assert mentioned_languages("caching layer") == set()
    hits = index.search("web framework for node", k=5)
    assert hits[0].doc.repo == "expressjs/express"
    assert len(hits) > 1  # other languages still appear


def test_popularity_prior_breaks_ties(fake_embedder) -> None:  # type: ignore[no-untyped-def]
    docs = [
        RepoDoc("small/kv", "key value store", stars=50),
        RepoDoc("big/kv", "key value store", stars=50_000),
    ]
    hits = RepoIndex.build(docs, fake_embedder, {}).search("key value store")
    assert [h.doc.repo for h in hits] == ["big/kv", "small/kv"]
