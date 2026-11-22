"""Build the repo index from GitHub.

GraphQL search returns up to 50 repos per call together with their description,
topics and README text, so a few thousand repos cost about a hundred API points.
GitHub caps each search at 1,000 results, so every language is walked in star
ranges, highest first.
"""

from __future__ import annotations

import asyncio
import logging
import re
from datetime import UTC, datetime, timedelta
from typing import Any

from ideation_goat.config import Settings
from ideation_goat.fetch import Fetcher, FetchError
from ideation_goat.search import Embedder, RepoDoc, RepoIndex
from ideation_goat.sources import github

logger = logging.getLogger(__name__)

LANGUAGES = ["Python", "JavaScript", "TypeScript", "Go", "Rust", "Java"]
STAR_RANGES = [
    ">=20000", "10000..19999", "5000..9999", "3000..4999", "2000..2999",
    "1500..1999", "1000..1499", "700..999", "500..699", "300..499",
]  # fmt: skip
README_WORDS = 600
PAGE_SIZE = 25
MIN_PAGE_SIZE = 5
MAX_PAGE_FAILURES = 6
MAX_AGE = timedelta(days=3 * 365)
LIST_TOPICS = {
    "awesome", "awesome-list", "awesome-lists", "list", "lists", "books", "book", "education", "tutorial",
    "tutorials", "interview", "interview-questions", "interview-preparation", "course", "courses", "roadmap",
    "cheatsheet", "cheat-sheet", "resources", "curated-list", "leetcode", "algorithms-and-data-structures",
}  # fmt: skip
LIST_PHRASES = ("curated list", "a list of", "collection of awesome", "free programming books", "interview")

_README_ALIASES = ["README.md", "readme.md", "README.rst", "README", "Readme.md", "README.markdown"]
SEARCH_QUERY = """
query($q: String!, $first: Int!, $cursor: String) {
  rateLimit { remaining resetAt }
  search(query: $q, type: REPOSITORY, first: $first, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on Repository {
        nameWithOwner description stargazerCount pushedAt isArchived isFork isTemplate
        licenseInfo { spdxId }
        primaryLanguage { name }
        repositoryTopics(first: 20) { nodes { topic { name } } }
        %s
      }
    }
  }
}
""" % "\n        ".join(  # noqa: UP031 - GraphQL braces make str.format awkward
    f'r{i}: object(expression: "HEAD:{name}") {{ ... on Blob {{ text }} }}'
    for i, name in enumerate(_README_ALIASES)
)


def clean_readme(text: str) -> str:
    """Strip markdown/rst noise (code, badges, links, HTML) down to plain words."""
    if not text:
        return ""
    text = re.sub(r"```.*?```|~~~.*?~~~", " ", text, flags=re.DOTALL)
    text = re.sub(r"<!--.*?-->", " ", text, flags=re.DOTALL)
    text = re.sub(r"!\[[^\]]*\]\([^)]*\)", " ", text)
    text = re.sub(r"\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)", " ", text)
    text = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", text)
    text = re.sub(r"^\.\. .*$", " ", text, flags=re.MULTILINE)
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"https?://\S+", " ", text)
    text = re.sub(r"`[^`\n]*`", " ", text)
    text = re.sub(r"[#*_=|>~^-]{2,}|[#*|>]", " ", text)
    return re.sub(r"\s+([.,;:!?])", r"\1", " ".join(text.split()))


def is_list_repo(name: str, description: str, topics: list[str]) -> bool:
    lowered = description.lower()
    return (
        name.lower().startswith("awesome")
        or bool(LIST_TOPICS & set(topics))
        or any(p in lowered for p in LIST_PHRASES)
    )


def node_to_doc(node: dict[str, Any], now: datetime) -> RepoDoc | None:
    if not node or node.get("isFork") or node.get("isArchived") or node.get("isTemplate"):
        return None
    repo = node["nameWithOwner"]
    description = (node.get("description") or "").strip()
    topics = [t["topic"]["name"] for t in (node.get("repositoryTopics") or {}).get("nodes", [])]
    if is_list_repo(repo.split("/")[1], description, topics):
        return None
    pushed = node.get("pushedAt")
    if pushed and now - datetime.fromisoformat(pushed.replace("Z", "+00:00")) > MAX_AGE:
        return None
    readme = next(
        (node[f"r{i}"]["text"] for i in range(len(_README_ALIASES)) if (node.get(f"r{i}") or {}).get("text")),
        "",
    )
    words = clean_readme(readme).split()[:README_WORDS]
    if not description and len(words) < 20:
        return None
    return RepoDoc(
        repo=repo,
        description=description,
        topics=topics,
        language=(node.get("primaryLanguage") or {}).get("name"),
        stars=int(node.get("stargazerCount") or 0),
        license=(node.get("licenseInfo") or {}).get("spdxId"),
        pushed_at=pushed,
        text=" ".join(words),
    )


async def _search_pages(fetch: Fetcher, query: str, want: int) -> list[dict[str, Any]]:
    """Page through one search. A failed or truncated page is retried at half the size."""
    nodes: list[dict[str, Any]] = []
    cursor: str | None = None
    first = PAGE_SIZE
    failures = 0
    while len(nodes) < want:
        try:
            response = await github.graphql(
                fetch, SEARCH_QUERY, {"q": query, "first": first, "cursor": cursor}
            )
            if not response.ok:
                raise RuntimeError(f"HTTP {response.status}: {response.text[:200]}")
            body = response.json()
            if body.get("errors") and not body.get("data"):
                raise RuntimeError(f"GraphQL error: {body['errors'][0].get('message')}")
            search = body["data"]["search"]
        except (FetchError, RuntimeError, ValueError, KeyError, TypeError) as exc:
            failures += 1
            if failures > MAX_PAGE_FAILURES:
                raise RuntimeError(f"GitHub search kept failing for {query!r}: {exc}") from exc
            first = max(MIN_PAGE_SIZE, first // 2)
            logger.warning("GraphQL page failed (%s); retrying with %d per page", exc, first)
            continue
        failures = 0
        nodes.extend(n for n in search["nodes"] if n)
        if not search["pageInfo"]["hasNextPage"]:
            break
        cursor = search["pageInfo"]["endCursor"]
    return nodes


async def _collect_language(fetch: Fetcher, language: str, per_language: int, now: datetime) -> list[RepoDoc]:
    kept: dict[str, RepoDoc] = {}
    for stars in STAR_RANGES:
        query = f"language:{language} stars:{stars} archived:false fork:false sort:stars-desc"
        for node in await _search_pages(fetch, query, want=1000):
            doc = node_to_doc(node, now)
            if doc is not None:
                kept.setdefault(doc.repo, doc)
            if len(kept) >= per_language:
                break
        logger.info("%s stars:%s -> %d kept", language, stars, len(kept))
        if len(kept) >= per_language:
            break
    return list(kept.values())


async def collect_docs(fetch: Fetcher, languages: list[str], per_language: int) -> list[RepoDoc]:
    if not fetch.settings.github_token:
        raise RuntimeError("building the index needs GITHUB_TOKEN (GraphQL requires authentication)")
    now = datetime.now(UTC)
    limit = asyncio.Semaphore(3)

    async def one(language: str) -> list[RepoDoc]:
        async with limit:
            return await _collect_language(fetch, language, per_language, now)

    docs: dict[str, RepoDoc] = {}
    for batch in await asyncio.gather(*(one(lang) for lang in languages)):
        for doc in batch:
            docs.setdefault(doc.repo, doc)
    return list(docs.values())


async def build_index(
    settings: Settings, embedder: Embedder, languages: list[str], per_language: int
) -> RepoIndex:
    async with Fetcher(settings) as fetch:
        docs = await collect_docs(fetch, languages, per_language)
    logger.info("Embedding %d repos with %s", len(docs), embedder.name)
    meta = {
        "built_at": datetime.now(UTC).replace(microsecond=0).isoformat(),
        "languages": {lang: sum(1 for d in docs if d.language == lang) for lang in languages},
    }
    return RepoIndex.build(docs, embedder, meta)
