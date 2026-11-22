"""The five operations. The MCP server, CLI and web demo are thin layers over these."""

from __future__ import annotations

import asyncio
import logging
import re
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from typing import Any, cast, get_args

from ideation_goat import licenses, manifests, scoring
from ideation_goat.config import Settings, get_settings
from ideation_goat.fetch import Fetcher, FetchError
from ideation_goat.index_store import IndexUnavailableError, get_index
from ideation_goat.lockin import check_lockin
from ideation_goat.models import (
    CompareResult,
    Dependency,
    DependencyFinding,
    DependencyReport,
    Ecosystem,
    FindLibrariesResult,
    LibraryMatch,
    LicenseIssue,
    PackageReport,
    Paper,
    PapersResult,
    RepoReport,
    Signal,
    Source,
)
from ideation_goat.sources import community, depsdev, github, osv, papers
from ideation_goat.summary import summarize

logger = logging.getLogger(__name__)

MAX_LICENSE_LOOKUPS = 300
UNRECOGNISED = "unrecognised"
ECOSYSTEM_ALIASES: dict[str, Ecosystem] = {
    "pypi": "pypi", "pip": "pypi", "python": "pypi",
    "npm": "npm", "node": "npm", "javascript": "npm",
    "cargo": "cargo", "crates.io": "cargo", "crates": "cargo", "rust": "cargo",
    "go": "go", "golang": "go",
}  # fmt: skip


def parse_ecosystem(value: str) -> Ecosystem:
    eco = ECOSYSTEM_ALIASES.get(value.strip().lower())
    if eco is None:
        raise ValueError(f"unsupported ecosystem {value!r}; use one of {', '.join(get_args(Ecosystem))}")
    return eco


@asynccontextmanager
async def _client(fetch: Fetcher | None, settings: Settings | None) -> AsyncIterator[Fetcher]:
    """Reuse a caller's open Fetcher, or open (and later close) a new one."""
    if fetch is not None:
        yield fetch
        return
    async with Fetcher(settings or get_settings()) as client:
        yield client


async def _safe[T](make: Callable[[], Awaitable[T]], fallback: T) -> T:
    """Run one signal fetch; a network failure becomes an unknown value, not an error."""
    try:
        return await make()
    except (FetchError, ValueError, KeyError) as exc:
        logger.info("signal fetch failed: %s", exc)
        return fallback


def _signal(value: Any, source: Source, note: str | None = None) -> Signal:
    return Signal(value=value, source=source, note=note) if value is not None else Signal(note=note)


# --- Repo reports ---------------------------------------------------------


async def repo_report(fetch: Fetcher, repo: str, *, deep: bool = False) -> RepoReport:
    """Live signals for one repo. ``deep`` adds Hacker News and cloud lock-in checks."""
    url = f"https://github.com/{repo}"
    try:
        meta = await github.get_repo(fetch, repo)
    except FetchError as exc:
        return RepoReport(repo=repo, url=url, note=f"GitHub unreachable: {exc.reason}")
    if meta.status == 404:
        return RepoReport(repo=repo, url=url, found=False, note="repository not found on GitHub")
    if not meta.ok:
        note = f"GitHub returned HTTP {meta.status}"
        if meta.status in {403, 429}:
            note += " (rate limit; set GITHUB_TOKEN for 5,000 requests an hour)"
        return RepoReport(repo=repo, url=url, note=note)

    data = meta.json()
    repo = data.get("full_name", repo)
    src = Source(url=data.get("html_url", url), fetched_at=meta.fetched_at)
    license_id = (data.get("license") or {}).get("spdx_id")
    report = RepoReport(
        repo=repo,
        url=src.url,
        description=data.get("description"),
        language=data.get("language"),
        stars=_signal(data.get("stargazers_count"), src),
        forks=_signal(data.get("forks_count"), src),
        open_issues=_signal(data.get("open_issues_count"), src),
        last_push=_signal(data.get("pushed_at"), src),
        license=_signal(license_id if license_id and license_id != "NOASSERTION" else None, src),
        archived=_signal(data.get("archived"), src),
    )

    async def release() -> Signal:
        response = await github.get_latest_release(fetch, repo)
        if response.status == 404:
            return Signal(note="no GitHub releases")
        if not response.ok:
            return Signal(note=f"HTTP {response.status}")
        body = response.json()
        page = Source(url=body.get("html_url", f"{url}/releases"), fetched_at=response.fetched_at)
        return _signal(body.get("published_at"), page, note=body.get("tag_name"))

    async def contributors() -> Signal:
        count, source = await github.get_contributor_count(fetch, repo)
        if count is None or source is None:
            return Signal(note="GitHub did not return a contributor count")
        return Signal(
            value=count, source=Source(url=f"{url}/graphs/contributors", fetched_at=source.fetched_at)
        )

    tasks: list[Awaitable[Any]] = [
        _safe(release, Signal(note="request failed")),
        _safe(contributors, Signal(note="request failed")),
        _safe(lambda: community.scorecard(fetch, repo), Signal(note="request failed")),
    ]
    if deep:
        tasks.append(_safe(lambda: community.hn_stories(fetch, repo), Signal(note="request failed")))
        tasks.append(_safe(lambda: check_lockin(fetch, repo), None))
    results = await asyncio.gather(*tasks)
    report.last_release, report.contributors, report.scorecard = results[0], results[1], results[2]
    if deep:
        report.hn_stories, report.lockin = results[3], results[4]
    report.health = scoring.health_score(report)
    return report


# --- find_libraries -------------------------------------------------------


def _reason(description: str | None, matched: list[str]) -> str:
    text = (description or "No description on GitHub.").strip()
    if len(text) > 160:
        text = text[:157].rstrip() + "..."
    if matched:
        text += f" (matches: {', '.join(matched[:5])})"
    return text


async def find_libraries(
    query: str,
    language: str | None = None,
    limit: int = 5,
    *,
    with_summary: bool = True,
    settings: Settings | None = None,
    fetch: Fetcher | None = None,
) -> FindLibrariesResult:
    query = query.strip()
    if not query:
        raise ValueError("describe what you want to build")
    limit = max(1, min(limit, 10))
    settings = settings or get_settings()
    async with _client(fetch, settings) as client:
        notes: list[str] = []
        candidates: list[tuple[str, float, str]] = []
        built_at = None
        retrieval = "index"
        try:
            index = await asyncio.to_thread(get_index, settings)
            hits = await asyncio.to_thread(index.search, query, language, limit + 3)
            built_at = index.meta.get("built_at")
            candidates = [(h.doc.repo, h.score, _reason(h.doc.description, h.matched_terms)) for h in hits]
        except (IndexUnavailableError, OSError, ValueError) as exc:
            retrieval = "github-search"
            notes.append(f"Search index unavailable ({exc}); used GitHub search instead.")
            response = await github.search_repositories(client, query, language, limit + 3)
            if not response.ok:
                raise RuntimeError(f"GitHub search returned HTTP {response.status}") from exc
            items = response.json().get("items", [])
            candidates = [
                (item["full_name"], round(1 / (i + 1), 4), _reason(item.get("description"), []))
                for i, item in enumerate(items)
            ]

        reports = await asyncio.gather(*(repo_report(client, repo) for repo, _, _ in candidates))
        matches: list[LibraryMatch] = []
        for (_, relevance, reason), report in zip(candidates, reports, strict=True):
            if not report.found:
                notes.append(f"{report.repo} is in the index but no longer on GitHub; skipped.")
                continue
            matches.append(
                LibraryMatch(rank=len(matches) + 1, report=report, relevance=relevance, reason=reason)
            )
            if len(matches) == limit:
                break
        if any(m.report.note for m in matches):
            notes.append("Some live signals are missing; see each repo's note.")
        result = FindLibrariesResult(
            query=query,
            language=language,
            retrieval=cast(Any, retrieval),
            index_built_at=built_at,
            matches=matches,
            notes=notes,
        )
        if with_summary:
            result.summary = await summarize(client, result)
        return result


# --- compare_libraries ----------------------------------------------------


async def compare_libraries(
    repos: list[str],
    *,
    with_summary: bool = True,
    settings: Settings | None = None,
    fetch: Fetcher | None = None,
) -> CompareResult:
    parsed: list[str] = []
    for raw in repos:
        repo = github.parse_repo(raw)
        if repo is None:
            raise ValueError(f"{raw!r} is not a GitHub repo; use owner/name or a github.com URL")
        if repo.lower() not in {p.lower() for p in parsed}:
            parsed.append(repo)
    if not 2 <= len(parsed) <= 5:
        raise ValueError("compare between 2 and 5 distinct repos")
    async with _client(fetch, settings) as client:
        reports = list(await asyncio.gather(*(repo_report(client, r, deep=True) for r in parsed)))
        result = CompareResult(repos=reports)
        result.notes = [f"{r.repo}: {r.note}" for r in reports if r.note]
        if with_summary:
            result.summary = await summarize(client, result)
        return result


# --- verify_package -------------------------------------------------------


async def verify_package(
    name: str,
    ecosystem: str,
    version: str | None = None,
    *,
    settings: Settings | None = None,
    fetch: Fetcher | None = None,
) -> PackageReport:
    eco = parse_ecosystem(ecosystem)
    name = depsdev.normalize_name(eco, name)
    if not name:
        raise ValueError("package name is empty")
    version = version.strip() if version else None
    async with _client(fetch, settings) as client:
        package = await depsdev.get_package(client, eco, name)
        report = PackageReport(ecosystem=eco, name=name, exists=False, requested_version=version)
        if package.status == 404:
            report.notes.append(
                f"No package named {name!r} in the {eco} registry according to deps.dev. If an assistant "
                "suggested it, it may not exist (deps.dev can lag new releases by a few hours)."
            )
            return report
        if not package.ok:
            raise RuntimeError(f"deps.dev returned HTTP {package.status}")
        report.exists = True
        versions = package.json().get("versions", [])
        default = next((v for v in versions if v.get("isDefault")), versions[-1] if versions else None)
        latest = default["versionKey"]["version"] if default else None
        page = Source(url=depsdev.package_page(eco, name), fetched_at=package.fetched_at)
        report.latest_version = _signal(latest, page)
        if version:
            report.version_exists = any(v["versionKey"]["version"] == version for v in versions)
            if not report.version_exists:
                report.notes.append(
                    f"Version {version} is not published; checked the latest version instead."
                )
        checked = version if version and report.version_exists else latest
        if checked is None:
            report.notes.append("The registry lists no versions for this package.")
            return report
        report.checked_version = checked

        detail = await depsdev.get_version(client, eco, name, checked)
        if detail.ok:
            data = detail.json()
            vsrc = Source(url=depsdev.package_page(eco, name, checked), fetched_at=detail.fetched_at)
            lic = " AND ".join(data.get("licenses") or []) or None
            report.license = _signal(lic, vsrc)
            report.published_at = _signal(data.get("publishedAt"), vsrc)
            report.deprecated = _signal(
                bool(data.get("isDeprecated")), vsrc, data.get("deprecatedReason") or None
            )
            for project in data.get("relatedProjects", []):
                if project.get("relationType") == "SOURCE_REPO":
                    key = project.get("projectKey", {}).get("id", "")
                    if key.startswith("github.com/"):
                        report.source_repo = key.removeprefix("github.com/")
                        break
        try:
            found, source = await osv.vulnerabilities_for(client, [(eco, name, checked)])
            report.vulnerabilities = found[0] if found else []
            report.vulnerabilities_source = source
        except (FetchError, RuntimeError) as exc:
            report.notes.append(f"OSV lookup failed ({exc}); vulnerabilities unknown.")
        return report


# --- check_dependencies ---------------------------------------------------


async def check_dependencies(
    path: str = ".",
    *,
    settings: Settings | None = None,
    fetch: Fetcher | None = None,
) -> DependencyReport:
    settings = settings or get_settings()
    root = manifests.resolve_inside(settings.workspace_root, path)
    if not root.is_dir():
        raise ValueError(f"{root} is not a folder")
    found = await asyncio.to_thread(manifests.find_manifests, root)
    deps = await asyncio.to_thread(manifests.collect_dependencies, root, found)
    pinned = [d for d in deps if d.version]
    unpinned = sorted({f"{d.ecosystem}:{d.name}" for d in deps if not d.version})
    project_license = manifests.detect_project_license(root)
    report = DependencyReport(
        root=str(root),
        project_license=project_license,
        manifests=[p.relative_to(root).as_posix() for p in found],
        dependencies_found=len(deps),
        checked=len(pinned),
        unpinned=unpinned,
        vulnerable=[],
        license_issues=[],
    )
    if not found:
        report.notes.append("No supported manifests or lockfiles found.")
        return report
    if unpinned:
        report.notes.append(
            f"{len(unpinned)} dependencies have no exact version, so they weren't checked. "
            "A lockfile fixes this."
        )
    if not pinned:
        return report

    async with _client(fetch, settings) as client:
        try:
            results, source = await osv.vulnerabilities_for(
                client, [(d.ecosystem, d.name, cast(str, d.version)) for d in pinned]
            )
            report.vulnerable = [
                DependencyFinding(dependency=d, vulnerabilities=v)
                for d, v in zip(pinned, results, strict=True)
                if v
            ]
            if source:
                report.sources.append(source)
        except (FetchError, RuntimeError) as exc:
            report.notes.append(f"OSV lookup failed ({exc}); vulnerabilities unknown.")

        to_check = pinned[:MAX_LICENSE_LOOKUPS]
        if len(pinned) > MAX_LICENSE_LOOKUPS:
            report.notes.append(
                f"Licenses checked for the first {MAX_LICENSE_LOOKUPS} pinned dependencies only."
            )

        async def license_issue(dep: Dependency) -> LicenseIssue | None:
            try:
                response = await depsdev.get_version(client, dep.ecosystem, dep.name, cast(str, dep.version))
            except FetchError:
                return None
            if response.status == 404:
                return LicenseIssue(
                    dependency=dep,
                    license=None,
                    problem="not found in the public registry (private or misspelled?)",
                )
            if not response.ok:
                return None
            lic = " AND ".join(response.json().get("licenses") or []) or None
            if licenses.classify(lic) == "unknown":
                return LicenseIssue(dependency=dep, license=lic, problem=UNRECOGNISED)
            problem = licenses.conflict(project_license, lic)
            return LicenseIssue(dependency=dep, license=lic, problem=problem) if problem else None

        issues = [i for i in await asyncio.gather(*(license_issue(d) for d in to_check)) if i is not None]
        report.license_issues = [i for i in issues if i.problem != UNRECOGNISED]
        report.unrecognised_licenses = [
            f"{i.dependency.name} {i.dependency.version} ({i.license or 'none listed'})"
            for i in issues
            if i.problem == UNRECOGNISED
        ]
        report.sources.append(Source(url="https://deps.dev", fetched_at=datetime.now(UTC)))
    return report


# --- find_papers ----------------------------------------------------------


def _title_key(title: str) -> str:
    return re.sub(r"[^a-z0-9]", "", title.lower())


async def find_papers(
    topic: str,
    limit: int = 8,
    *,
    settings: Settings | None = None,
    fetch: Fetcher | None = None,
) -> PapersResult:
    topic = topic.strip()
    if not topic:
        raise ValueError("topic is empty")
    limit = max(1, min(limit, 20))
    async with _client(fetch, settings) as client:
        arxiv_result, s2_result = await asyncio.gather(
            papers.search_arxiv(client, topic, limit),
            papers.search_semantic_scholar(client, topic, limit),
            return_exceptions=True,
        )
    result = PapersResult(topic=topic, papers=[])
    lists: list[list[Paper]] = []
    for label, outcome in (("arXiv", arxiv_result), ("Semantic Scholar", s2_result)):
        if isinstance(outcome, BaseException):
            result.notes.append(f"{label} unavailable: {outcome}")
            continue
        found, source = outcome
        lists.append(found)
        result.sources.append(source)

    merged: dict[str, Paper] = {}
    fused: dict[str, float] = {}
    for found in lists:
        for rank, paper in enumerate(found):
            key = _title_key(paper.title)
            fused[key] = fused.get(key, 0.0) + 1.0 / (60 + rank + 1)
            if key not in merged:
                merged[key] = paper.model_copy(deep=True)
                continue
            existing = merged[key]
            existing.found_in = sorted(set(existing.found_in) | set(paper.found_in))  # type: ignore[assignment]
            existing.pdf_url = existing.pdf_url or paper.pdf_url
            existing.year = existing.year or paper.year
            if not existing.citations.known:
                existing.citations = paper.citations
    order = sorted(merged, key=lambda k: -fused[k])
    result.papers = [merged[k] for k in order[:limit]]
    return result
