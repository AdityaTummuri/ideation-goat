"""GitHub REST and GraphQL calls."""

from __future__ import annotations

import re
from typing import Any
from urllib.parse import quote

from ideation_goat.cache import DAY, HOUR
from ideation_goat.fetch import Fetcher, Response
from ideation_goat.models import Source

API = "https://api.github.com"
RAW = "https://raw.githubusercontent.com"

_REPO_RE = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})/[A-Za-z0-9._-]{1,100}$")
_URL_RE = re.compile(r"^(?:https?://)?(?:www\.)?github\.com/([^/\s]+)/([^/\s#?]+)", re.IGNORECASE)
_LAST_PAGE_RE = re.compile(r'[?&]page=(\d+)>;\s*rel="last"')


def parse_repo(text: str) -> str | None:
    """Return ``owner/name`` from a name or GitHub URL, or None if it isn't one."""
    text = text.strip()
    match = _URL_RE.match(text)
    if match:
        text = f"{match.group(1)}/{match.group(2)}"
    text = text.removesuffix(".git").strip("/")
    if not _REPO_RE.match(text) or text.split("/")[1] in {".", ".."}:
        return None
    return text


def headers(fetch: Fetcher) -> dict[str, str]:
    result = {"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"}
    if fetch.settings.github_token:
        result["Authorization"] = f"Bearer {fetch.settings.github_token}"
    return result


async def get_repo(fetch: Fetcher, repo: str) -> Response:
    return await fetch.get(f"{API}/repos/{repo}", headers=headers(fetch), ttl=DAY)


async def get_latest_release(fetch: Fetcher, repo: str) -> Response:
    return await fetch.get(f"{API}/repos/{repo}/releases/latest", headers=headers(fetch), ttl=DAY)


async def get_contributor_count(fetch: Fetcher, repo: str) -> tuple[int | None, Source | None]:
    """Count contributors from the pagination header of a one-per-page listing."""
    response = await fetch.get(
        f"{API}/repos/{repo}/contributors", params={"per_page": 1}, headers=headers(fetch), ttl=DAY
    )
    if response.status == 204:
        return 0, response.source
    if not response.ok:
        return None, None
    if response.link:
        match = _LAST_PAGE_RE.search(response.link)
        if match:
            return int(match.group(1)), response.source
    data = response.json()
    return (len(data) if isinstance(data, list) else None), response.source


async def search_repositories(fetch: Fetcher, query: str, language: str | None, limit: int) -> Response:
    q = f"{query} in:name,description,readme,topics archived:false fork:false"
    if language:
        q += f" language:{language}"
    return await fetch.get(
        f"{API}/search/repositories",
        params={"q": q, "per_page": limit},
        headers=headers(fetch),
        ttl=6 * HOUR,
    )


async def get_raw_file(fetch: Fetcher, repo: str, path: str) -> Response:
    return await fetch.get(f"{RAW}/{repo}/HEAD/{quote(path)}", ttl=DAY)


async def graphql(fetch: Fetcher, query: str, variables: dict[str, Any]) -> Response:
    return await fetch.post(
        f"{API}/graphql", json_body={"query": query, "variables": variables}, headers=headers(fetch), ttl=0
    )
