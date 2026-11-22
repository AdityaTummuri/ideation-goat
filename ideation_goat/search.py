"""Hybrid retrieval over the prebuilt repo index.

Two rankers run over every repo: BM25 on the README, description and topics, and
cosine similarity on MiniLM embeddings. Their rankings are merged with reciprocal
rank fusion (RRF), which needs no score calibration between the two.

The index is a few thousand repos, so plain numpy arrays beat a vector database:
no server, no version coupling, a single download.
"""

from __future__ import annotations

import json
import math
import os
import re
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal, Protocol

import numpy as np
from numpy.typing import NDArray

Mode = Literal["hybrid", "bm25", "embeddings"]
RRF_K = 60
FUSION_DEPTH = 200
INDEX_FORMAT = 1
LANGUAGE_BOOST = 1.25
# Popularity prior: fused score x (stars + 1) ** 0.2. Without it, small look-alike repos crowd out the
# libraries people actually use. Chosen from a flat plateau (0.15-0.3) on the labeled query set.
POPULARITY_WEIGHT = 0.2
_LANGUAGE_WORDS = {
    "python": {"python"}, "javascript": {"javascript", "typescript"}, "node": {"javascript", "typescript"},
    "nodejs": {"javascript", "typescript"}, "typescript": {"typescript", "javascript"},
    "golang": {"go"}, "go": {"go"}, "rust": {"rust"}, "java": {"java"},
}  # fmt: skip

_STOPWORDS = frozenset(
    "a an and are as at be by for from has have i in is it its of on or that the this to was with "
    "you your we our can will using use used based simple fast library framework tool tools "
    "want need build building make written".split()
)
_TOKEN_RE = re.compile(r"[a-z0-9]+(?:\+\+|#)?")


def tokenize(text: str) -> list[str]:
    tokens = []
    for token in _TOKEN_RE.findall(text.lower()):
        if token in _STOPWORDS or len(token) < 2:
            continue
        if len(token) > 4 and token.endswith("ies"):
            token = token[:-3] + "y"
        elif len(token) > 3 and token.endswith("s") and not token.endswith("ss"):
            token = token[:-1]
        tokens.append(token)
    return tokens


def mentioned_languages(query: str) -> set[str]:
    words = re.findall(r"[a-z]+", query.lower())
    found: set[str] = set()
    for word in words:
        found |= _LANGUAGE_WORDS.get(word, set())
    return found


class Embedder(Protocol):
    name: str

    def embed_documents(self, texts: list[str]) -> NDArray[np.float32]: ...

    def embed_query(self, text: str) -> NDArray[np.float32]: ...


class FastEmbedder:
    """Local ONNX embeddings via fastembed; no API key, runs on CPU."""

    def __init__(self, model_name: str, cache_dir: Path) -> None:
        self.name = model_name
        self._cache_dir = cache_dir
        self._model: Any = None

    def _load(self) -> Any:
        if self._model is None:
            os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")
            from fastembed import TextEmbedding

            self._model = TextEmbedding(model_name=self.name, cache_dir=str(self._cache_dir))
        return self._model

    def embed_documents(self, texts: list[str]) -> NDArray[np.float32]:
        vectors = np.array(list(self._load().passage_embed(texts, batch_size=64)), dtype=np.float32)
        return _normalize(vectors)

    def embed_query(self, text: str) -> NDArray[np.float32]:
        vector = np.array(next(iter(self._load().query_embed(text))), dtype=np.float32)
        normalized: NDArray[np.float32] = _normalize(vector[None, :])[0]
        return normalized


def _normalize(vectors: NDArray[np.float32]) -> NDArray[np.float32]:
    norms = np.linalg.norm(vectors, axis=1, keepdims=True)
    return (vectors / np.maximum(norms, 1e-12)).astype(np.float32)


@dataclass
class RepoDoc:
    repo: str
    description: str = ""
    topics: list[str] = field(default_factory=list)
    language: str | None = None
    stars: int = 0
    license: str | None = None
    pushed_at: str | None = None
    text: str = ""

    def bm25_text(self) -> str:
        name = self.repo.split("/")[1].replace("-", " ").replace("_", " ").replace(".", " ")
        topics = " ".join(t.replace("-", " ") for t in self.topics)
        return f"{name} {name} {name} {self.description} {self.description} {topics} {topics} {self.text}"

    def embedding_texts(self) -> list[str]:
        name = self.repo.split("/")[1]
        head = f"{name}: {self.description}".strip()
        if self.topics:
            head += f" Topics: {', '.join(self.topics)}."
        readme = " ".join(self.text.split()[:180])
        return [head, f"{name}. {readme}"] if readme else [head]


class BM25:
    def __init__(self, documents: list[list[str]], k1: float = 1.5, b: float = 0.75) -> None:
        self.k1, self.b = k1, b
        self.n = len(documents)
        self.lengths = np.array([len(d) for d in documents], dtype=np.float32)
        self.avg_length = float(self.lengths.mean()) if self.n else 0.0
        self.postings: dict[str, list[tuple[int, int]]] = defaultdict(list)
        for doc_id, tokens in enumerate(documents):
            for term, count in Counter(tokens).items():
                self.postings[term].append((doc_id, count))

    def scores(self, query: list[str]) -> NDArray[np.float32]:
        result = np.zeros(self.n, dtype=np.float32)
        for term in set(query):
            postings = self.postings.get(term)
            if not postings:
                continue
            idf = math.log(1 + (self.n - len(postings) + 0.5) / (len(postings) + 0.5))
            for doc_id, tf in postings:
                norm = tf + self.k1 * (1 - self.b + self.b * self.lengths[doc_id] / self.avg_length)
                result[doc_id] += idf * tf * (self.k1 + 1) / norm
        return result


@dataclass(frozen=True)
class Hit:
    doc: RepoDoc
    score: float
    matched_terms: list[str]


class RepoIndex:
    def __init__(
        self,
        docs: list[RepoDoc],
        embeddings: NDArray[np.float32],
        owners: NDArray[np.int32],
        embedder: Embedder,
        meta: dict[str, Any] | None = None,
    ) -> None:
        self.docs = docs
        self.embeddings = embeddings
        self.owners = owners
        self.embedder = embedder
        self.meta = meta or {}
        self.bm25 = BM25([tokenize(d.bm25_text()) for d in docs])
        self._languages = np.array([(d.language or "").lower() for d in docs])

    @classmethod
    def load(cls, directory: Path, embedder: Embedder) -> RepoIndex:
        meta = json.loads((directory / "meta.json").read_text(encoding="utf-8"))
        if meta.get("format") != INDEX_FORMAT:
            raise ValueError(f"index format {meta.get('format')} is not supported; rebuild or re-download it")
        if meta.get("embedding_model") != embedder.name:
            raise ValueError(
                f"index was built with {meta.get('embedding_model')}, "
                f"but the configured model is {embedder.name}"
            )
        with (directory / "repos.jsonl").open(encoding="utf-8") as fh:
            docs = [RepoDoc(**json.loads(line)) for line in fh if line.strip()]
        embeddings = np.load(directory / "embeddings.npy").astype(np.float32)
        owners = np.load(directory / "owners.npy")
        return cls(docs, embeddings, owners, embedder, meta)

    @classmethod
    def build(cls, docs: list[RepoDoc], embedder: Embedder, meta: dict[str, Any]) -> RepoIndex:
        texts: list[str] = []
        owners: list[int] = []
        for i, doc in enumerate(docs):
            for text in doc.embedding_texts():
                texts.append(text)
                owners.append(i)
        embeddings = embedder.embed_documents(texts) if texts else np.zeros((0, 1), dtype=np.float32)
        meta = {**meta, "format": INDEX_FORMAT, "embedding_model": embedder.name, "count": len(docs)}
        return cls(docs, embeddings, np.array(owners, dtype=np.int32), embedder, meta)

    def save(self, directory: Path) -> None:
        directory.mkdir(parents=True, exist_ok=True)
        with (directory / "repos.jsonl").open("w", encoding="utf-8") as fh:
            for doc in self.docs:
                fh.write(json.dumps(doc.__dict__, ensure_ascii=False) + "\n")
        np.save(directory / "embeddings.npy", self.embeddings.astype(np.float16))
        np.save(directory / "owners.npy", self.owners)
        (directory / "meta.json").write_text(json.dumps(self.meta, indent=2), encoding="utf-8")

    def _mask(self, language: str | None) -> NDArray[np.bool_]:
        if not language:
            return np.ones(len(self.docs), dtype=bool)
        wanted = {language.lower()}
        if language.lower() in {"javascript", "typescript", "js", "ts"}:
            wanted = {"javascript", "typescript"}
        return np.isin(self._languages, list(wanted))

    def bm25_ranking(self, query: str, mask: NDArray[np.bool_]) -> list[int]:
        scores = self.bm25.scores(tokenize(query))
        scores[~mask] = 0
        order = np.argsort(-scores, kind="stable")
        return [int(i) for i in order[:FUSION_DEPTH] if scores[i] > 0]

    def embedding_ranking(self, query: str, mask: NDArray[np.bool_]) -> list[int]:
        if len(self.embeddings) == 0:
            return []
        sims = self.embeddings @ self.embedder.embed_query(query)
        best = np.full(len(self.docs), -np.inf, dtype=np.float32)
        np.maximum.at(best, self.owners, sims)
        best[~mask] = -np.inf
        order = np.argsort(-best, kind="stable")
        return [int(i) for i in order[:FUSION_DEPTH] if np.isfinite(best[i])]

    def search(
        self, query: str, language: str | None = None, k: int = 10, mode: Mode = "hybrid"
    ) -> list[Hit]:
        mask = self._mask(language)
        rankings: list[list[int]] = []
        if mode in {"hybrid", "bm25"}:
            rankings.append(self.bm25_ranking(query, mask))
        if mode in {"hybrid", "embeddings"}:
            rankings.append(self.embedding_ranking(query, mask))
        fused: dict[int, float] = defaultdict(float)
        for ranking in rankings:
            for rank, doc_id in enumerate(ranking):
                fused[doc_id] += 1.0 / (RRF_K + rank + 1)
        # A language named in the query ("... for a Python API") is a soft preference, not a filter.
        preferred = set() if language else mentioned_languages(query)
        for doc_id in fused:
            doc = self.docs[doc_id]
            fused[doc_id] *= (doc.stars + 1) ** POPULARITY_WEIGHT
            if preferred and (doc.language or "").lower() in preferred:
                fused[doc_id] *= LANGUAGE_BOOST
        query_terms = set(tokenize(query))
        hits = []
        for doc_id, score in sorted(fused.items(), key=lambda kv: (-kv[1], kv[0]))[:k]:
            doc = self.docs[doc_id]
            doc_terms = set(tokenize(f"{doc.repo} {doc.description} {' '.join(doc.topics)}"))
            hits.append(Hit(doc=doc, score=round(score, 5), matched_terms=sorted(query_terms & doc_terms)))
        return hits
