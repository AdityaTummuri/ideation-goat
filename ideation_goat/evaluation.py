"""Retrieval evaluation on a labeled query set.

Metrics (binary relevance, counting only accepted repos present in the index):
- Recall@5: share of accepted repos in the top 5, out of min(5, accepted in index)
- MRR@10: 1 / rank of the first accepted repo in the top 10 (0 if none)
- nDCG@10: discounted gain of accepted repos in the top 10, normalised by the ideal order
"""

from __future__ import annotations

import json
import math
import statistics
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ideation_goat.search import Mode, RepoIndex

MODES: list[Mode] = ["embeddings", "bm25", "hybrid"]


@dataclass(frozen=True)
class Query:
    query: str
    accept: list[str]
    language: str | None = None


@dataclass
class ModeResult:
    mode: str
    recall_at_5: float = 0.0
    mrr_at_10: float = 0.0
    ndcg_at_10: float = 0.0
    p50_ms: float = 0.0
    p95_ms: float = 0.0
    misses: list[dict[str, Any]] = field(default_factory=list)


def load_queries(path: Path) -> list[Query]:
    try:
        import yaml
    except ImportError as exc:  # pragma: no cover - dev dependency
        raise RuntimeError("evaluation needs PyYAML: pip install 'ideation-goat[dev]'") from exc
    raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    return [Query(q["query"], list(q["accept"]), q.get("language")) for q in raw]


def recall_at(ranked: list[str], relevant: set[str], k: int) -> float:
    return len(set(ranked[:k]) & relevant) / min(k, len(relevant))


def mrr_at(ranked: list[str], relevant: set[str], k: int) -> float:
    return next((1.0 / (i + 1) for i, repo in enumerate(ranked[:k]) if repo in relevant), 0.0)


def ndcg_at(ranked: list[str], relevant: set[str], k: int) -> float:
    dcg = sum(1.0 / math.log2(i + 2) for i, repo in enumerate(ranked[:k]) if repo in relevant)
    ideal = sum(1.0 / math.log2(i + 2) for i in range(min(k, len(relevant))))
    return dcg / ideal


def _percentile(values: list[float], pct: float) -> float:
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, round(pct * (len(ordered) - 1)))]


def evaluate(index: RepoIndex, queries: list[Query], modes: list[Mode] = MODES) -> dict[str, Any]:
    present = {d.repo.lower() for d in index.docs}
    usable = []
    accepted_total = accepted_present = 0
    for q in queries:
        relevant = {r.lower() for r in q.accept if r.lower() in present}
        accepted_total += len(q.accept)
        accepted_present += len(relevant)
        if relevant:
            usable.append((q, relevant))

    index.search("warm up the embedding model")
    results = []
    for mode in modes:
        res = ModeResult(mode=mode)
        recalls, mrrs, ndcgs, latencies = [], [], [], []
        for q, relevant in usable:
            start = time.perf_counter()
            hits = index.search(q.query, language=q.language, k=10, mode=mode)
            latencies.append((time.perf_counter() - start) * 1000)
            ranked = [h.doc.repo.lower() for h in hits]
            recalls.append(recall_at(ranked, relevant, 5))
            mrrs.append(mrr_at(ranked, relevant, 10))
            ndcgs.append(ndcg_at(ranked, relevant, 10))
            if recalls[-1] == 0:
                res.misses.append({"query": q.query, "top3": ranked[:3], "wanted": sorted(relevant)})
        res.recall_at_5 = round(statistics.mean(recalls), 3)
        res.mrr_at_10 = round(statistics.mean(mrrs), 3)
        res.ndcg_at_10 = round(statistics.mean(ndcgs), 3)
        res.p50_ms = round(_percentile(latencies, 0.5), 1)
        res.p95_ms = round(_percentile(latencies, 0.95), 1)
        results.append(res)

    return {
        "index_built_at": index.meta.get("built_at"),
        "index_repos": len(index.docs),
        "embedding_model": index.embedder.name,
        "queries": len(queries),
        "queries_scored": len(usable),
        "label_coverage": round(accepted_present / max(accepted_total, 1), 3),
        "results": [r.__dict__ for r in results],
    }


def to_markdown(report: dict[str, Any]) -> str:
    lines = [
        f"{report['queries_scored']} of {report['queries']} queries scored; "
        f"{round(report['label_coverage'] * 100)}% of labeled repos are in the "
        f"{report['index_repos']:,}-repo index ({report['embedding_model']}).",
        "",
        "| Setup | Recall@5 | MRR@10 | nDCG@10 | p50 / p95 latency |",
        "|---|---|---|---|---|",
    ]
    names = {"embeddings": "Embeddings only", "bm25": "BM25 only", "hybrid": "Hybrid (RRF)"}
    for r in report["results"]:
        lines.append(
            f"| {names.get(r['mode'], r['mode'])} | {r['recall_at_5']:.3f} | {r['mrr_at_10']:.3f} "
            f"| {r['ndcg_at_10']:.3f} | {r['p50_ms']:.0f} / {r['p95_ms']:.0f} ms |"
        )
    return "\n".join(lines)


def regression(report: dict[str, Any], baseline: dict[str, Any], tolerance: float = 0.02) -> list[str]:
    """Return a message per mode whose Recall@5 dropped more than ``tolerance`` below the baseline."""
    base = {r["mode"]: r["recall_at_5"] for r in baseline["results"]}
    problems = []
    for r in report["results"]:
        if r["mode"] in base and r["recall_at_5"] < base[r["mode"]] - tolerance:
            problems.append(f"{r['mode']}: Recall@5 {r['recall_at_5']:.3f} < baseline {base[r['mode']]:.3f}")
    return problems


def save(report: dict[str, Any], path: Path) -> None:
    path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
