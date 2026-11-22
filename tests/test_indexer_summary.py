from datetime import UTC, datetime

import pytest
import respx

from ideation_goat import summary
from ideation_goat.config import Settings
from ideation_goat.fetch import Fetcher
from ideation_goat.indexer import clean_readme, is_list_repo, node_to_doc
from ideation_goat.models import CompareResult, HealthScore, RepoReport, Signal

NOW = datetime(2026, 11, 23, tzinfo=UTC)


def test_clean_readme_strips_markup() -> None:
    text = (
        "# Title\n[![badge](https://x/b.svg)](https://x)\n```python\ncode()\n```\n"
        "Use [the docs](https://docs) and `inline` <b>bold</b> **now**."
    )
    assert clean_readme(text) == "Title Use the docs and bold now."


def test_list_repos_are_filtered() -> None:
    assert is_list_repo("awesome-python", "", [])
    assert is_list_repo("x", "A curated list of things", [])
    assert is_list_repo("x", "", ["interview-questions"])
    assert not is_list_repo("fastapi", "web framework", ["api"])


def node(**overrides: object) -> dict[str, object]:
    base: dict[str, object] = {
        "nameWithOwner": "o/lib",
        "description": "A library",
        "stargazerCount": 1200,
        "pushedAt": "2026-11-01T00:00:00Z",
        "isArchived": False,
        "isFork": False,
        "isTemplate": False,
        "licenseInfo": {"spdxId": "MIT"},
        "primaryLanguage": {"name": "Go"},
        "repositoryTopics": {"nodes": [{"topic": {"name": "http"}}]},
        "r0": None,
        "r2": {"text": "Readme **text** here"},
    }
    base.update(overrides)
    return base


def test_node_to_doc() -> None:
    doc = node_to_doc(node(), NOW)
    assert doc is not None
    assert (doc.repo, doc.language, doc.topics, doc.text) == ("o/lib", "Go", ["http"], "Readme text here")
    assert node_to_doc(node(isFork=True), NOW) is None
    assert node_to_doc(node(pushedAt="2020-01-01T00:00:00Z"), NOW) is None
    assert node_to_doc(node(description="", r2=None), NOW) is None


def report(repo: str, score: int | None, coverage: float = 1.0, **kw: object) -> RepoReport:
    return RepoReport(
        repo=repo,
        url=f"https://github.com/{repo}",
        health=HealthScore(score=score, coverage=coverage, parts=[]),
        license=Signal(value="MIT"),
        **kw,  # type: ignore[arg-type]
    )


def test_template_summary_mentions_partial_data() -> None:
    text = summary.template_summary([report("a/x", 90, 0.75), report("b/y", 80)], "Compared.").text
    assert "a/x (90/100, based on 75% of the inputs)" in text
    assert summary.template_summary([report("a/x", None)], "Hi.").text.endswith("health score.")


@pytest.mark.anyio
async def test_gemini_summary_and_fallback(settings: Settings, mock: respx.MockRouter) -> None:
    keyed = settings.model_copy(update={"gemini_api_key": "k"})
    result = CompareResult(repos=[report("a/x", 90), report("b/y", 70)])
    route = mock.post(url__startswith="https://generativelanguage.googleapis.com/").respond(
        200, json={"candidates": [{"content": {"parts": [{"text": "a/x looks healthier."}]}}]}
    )
    async with Fetcher(keyed) as f:
        out = await summary.summarize(f, result)
    assert out.generated_by == "gemini" and out.text == "a/x looks healthier."
    assert route.calls[0].request.headers["x-goog-api-key"] == "k"

    route.respond(500)
    async with Fetcher(keyed) as f:
        out = await summary.summarize(f, result)
    assert out.generated_by == "template"


def test_ranking_metrics() -> None:
    from ideation_goat.evaluation import mrr_at, ndcg_at, recall_at, regression

    ranked = ["x", "a", "y", "b", "z"]
    relevant = {"a", "b", "c"}
    assert recall_at(ranked, relevant, 5) == 2 / 3
    assert mrr_at(ranked, relevant, 10) == 0.5
    assert 0 < ndcg_at(ranked, relevant, 10) < 1
    assert ndcg_at(["a", "b", "c"], relevant, 10) == 1.0
    base = {"results": [{"mode": "hybrid", "recall_at_5": 0.60}]}
    assert regression({"results": [{"mode": "hybrid", "recall_at_5": 0.59}]}, base) == []
    assert regression({"results": [{"mode": "hybrid", "recall_at_5": 0.55}]}, base)


def test_evaluate_on_tiny_index(tmp_path, fake_embedder) -> None:  # type: ignore[no-untyped-def]
    from ideation_goat.evaluation import Query, evaluate, to_markdown
    from ideation_goat.search import RepoDoc, RepoIndex

    docs = [RepoDoc("a/cache", "in-memory cache"), RepoDoc("b/web", "web framework")]
    index = RepoIndex.build(docs, fake_embedder, {})
    report = evaluate(index, [Query("cache in memory", ["a/cache", "zz/missing"]), Query("q", ["zz/none"])])
    assert report["queries_scored"] == 1 and report["label_coverage"] == 0.333
    hybrid = next(r for r in report["results"] if r["mode"] == "hybrid")
    assert hybrid["recall_at_5"] == 1.0 and hybrid["mrr_at_10"] == 1.0
    assert "Hybrid (RRF)" in to_markdown(report)
