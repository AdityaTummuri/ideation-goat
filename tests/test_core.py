from pathlib import Path

import httpx
import pytest
import respx

from ideation_goat import core
from ideation_goat.config import Settings
from ideation_goat.index_store import IndexUnavailableError
from ideation_goat.manifests import OutsideWorkspaceError
from ideation_goat.search import RepoDoc, RepoIndex
from ideation_goat.sources import community, depsdev, github, osv, papers

OSV_VULN = {
    "id": "GHSA-1",
    "aliases": ["CVE-2024-1"],
    "summary": "Session verify bypass",
    "affected": [{"package": {"name": "requests"}, "ranges": [{"events": [{"fixed": "2.32.0"}]}]}],
    "database_specific": {"severity": "MODERATE"},
}


def mock_repo(mock: respx.MockRouter, repo: str, **overrides: object) -> None:
    data = {
        "full_name": repo,
        "html_url": f"https://github.com/{repo}",
        "description": f"{repo} description",
        "language": "Python",
        "stargazers_count": 12_000,
        "forks_count": 100,
        "open_issues_count": 40,
        "pushed_at": "2026-11-20T00:00:00Z",
        "archived": False,
        "license": {"spdx_id": "MIT"},
        **overrides,
    }
    mock.get(f"{github.API}/repos/{repo}").respond(200, json=data)
    mock.get(f"{github.API}/repos/{repo}/releases/latest").respond(
        200, json={"published_at": "2026-10-01T00:00:00Z", "tag_name": "v1.0", "html_url": "https://x/rel"}
    )
    mock.get(f"{github.API}/repos/{repo}/contributors").respond(200, json=[{}] * 3)
    mock.get(f"{community.SCORECARD_API}/{repo}").respond(200, json={"score": 6.0, "date": "2026-11-01"})
    mock.get(community.HN_API).respond(200, json={"nbHits": 2})
    mock.get(url__startswith=f"{github.RAW}/{repo}/").respond(404)


# --- verify_package -------------------------------------------------------


def mock_requests_package(mock: respx.MockRouter) -> None:
    mock.get(f"{depsdev.API}/systems/pypi/packages/requests").respond(
        200,
        json={
            "versions": [
                {"versionKey": {"version": "2.31.0"}},
                {"versionKey": {"version": "2.34.2"}, "isDefault": True},
            ]
        },
    )
    mock.get(url__regex=rf"{depsdev.API}/systems/pypi/packages/requests/versions/.*").respond(
        200,
        json={
            "licenses": ["Apache-2.0"],
            "publishedAt": "2023-05-22T15:12:42Z",
            "isDeprecated": False,
            "relatedProjects": [
                {"projectKey": {"id": "github.com/psf/requests"}, "relationType": "SOURCE_REPO"}
            ],
        },
    )
    mock.post(f"{osv.API}/querybatch").respond(200, json={"results": [{"vulns": [{"id": "GHSA-1"}]}]})
    mock.get(f"{osv.API}/vulns/GHSA-1").respond(200, json=OSV_VULN)


@pytest.mark.anyio
async def test_verify_package_reports_vulnerabilities(settings: Settings, mock: respx.MockRouter) -> None:
    mock_requests_package(mock)
    report = await core.verify_package("Requests", "PyPI", "2.31.0", settings=settings)
    assert report.exists and report.version_exists
    assert report.name == "requests" and report.checked_version == "2.31.0"
    assert report.latest_version.value == "2.34.2" and report.latest_version.source is not None
    assert report.license.value == "Apache-2.0" and report.deprecated.value is False
    assert report.source_repo == "psf/requests"
    assert [(v.id, v.fixed_in) for v in report.vulnerabilities] == [("GHSA-1", ["2.32.0"])]


@pytest.mark.anyio
async def test_verify_unpublished_version_checks_latest(settings: Settings, mock: respx.MockRouter) -> None:
    mock_requests_package(mock)
    report = await core.verify_package("requests", "pip", "9.9.9", settings=settings)
    assert report.version_exists is False and report.checked_version == "2.34.2"
    assert any("not published" in n for n in report.notes)


@pytest.mark.anyio
async def test_verify_missing_package(settings: Settings, mock: respx.MockRouter) -> None:
    mock.get(f"{depsdev.API}/systems/npm/packages/left-padd-pro").respond(404)
    report = await core.verify_package("left-padd-pro", "npm", settings=settings)
    assert not report.exists and "may not exist" in report.notes[0]
    assert report.vulnerabilities == []


@pytest.mark.anyio
async def test_verify_osv_outage_is_reported(settings: Settings, mock: respx.MockRouter) -> None:
    mock_requests_package(mock)
    mock.post(f"{osv.API}/querybatch").respond(503)
    report = await core.verify_package("requests", "pypi", settings=settings)
    assert report.vulnerabilities_source is None
    assert any("vulnerabilities unknown" in n for n in report.notes)


@pytest.mark.anyio
async def test_verify_rejects_unknown_ecosystem(settings: Settings) -> None:
    with pytest.raises(ValueError, match="unsupported ecosystem"):
        await core.verify_package("x", "maven", settings=settings)


# --- compare_libraries ----------------------------------------------------


@pytest.mark.anyio
async def test_compare_builds_sourced_scorecards(settings: Settings, mock: respx.MockRouter) -> None:
    mock.get(f"{github.RAW}/a/one/HEAD/requirements.txt").respond(200, text="boto3==1.0\nflask\n")
    mock_repo(mock, "a/one")
    mock_repo(mock, "b/two", archived=True)
    result = await core.compare_libraries(
        ["a/one", "https://github.com/b/two", "A/one"], with_summary=True, settings=settings
    )
    one, two = result.repos
    assert one.stars.value == 12_000 and one.stars.source is not None
    assert one.contributors.value == 3 and one.scorecard.value == 6.0 and one.hn_stories.value == 2
    assert one.lockin is not None and [f.vendor for f in one.lockin] == ["AWS"]
    assert two.lockin is None  # no manifest could be read
    assert one.health is not None and one.health.score is not None
    assert two.health is not None and two.health.score == 20
    assert result.summary is not None and result.summary.generated_by == "template"
    assert "Archived: b/two" in result.summary.text


@pytest.mark.anyio
async def test_compare_handles_missing_and_rate_limited_repos(
    settings: Settings, mock: respx.MockRouter
) -> None:
    mock.get(f"{github.API}/repos/gone/repo").respond(404)
    mock.get(f"{github.API}/repos/busy/repo").respond(403)
    result = await core.compare_libraries(["gone/repo", "busy/repo"], with_summary=False, settings=settings)
    gone, busy = result.repos
    assert not gone.found and gone.stars.value is None
    assert busy.found and "rate limit" in (busy.note or "")
    assert len(result.notes) == 2


@pytest.mark.anyio
@pytest.mark.parametrize(
    "repos", [["a/b"], ["a/b"] * 2, ["a/b", "c/d", "e/f", "g/h", "i/j", "k/l"], ["a/b", "nope"]]
)
async def test_compare_validates_input(settings: Settings, repos: list[str]) -> None:
    with pytest.raises(ValueError):
        await core.compare_libraries(repos, settings=settings)


# --- find_libraries -------------------------------------------------------


@pytest.mark.anyio
async def test_find_libraries_uses_index(
    settings: Settings, mock: respx.MockRouter, monkeypatch: pytest.MonkeyPatch, fake_embedder
) -> None:  # type: ignore[no-untyped-def]
    docs = [
        RepoDoc(
            "a/limiter", "Rate limiter for Python web APIs", ["rate-limiting"], "Python", text="token bucket"
        ),
        RepoDoc("b/gone", "Rate limiting middleware", [], "Python", text="rate limit"),
        RepoDoc("c/charts", "Charting library", [], "JavaScript", text="plots"),
    ]
    index = RepoIndex.build(docs, fake_embedder, {"built_at": "2026-11-23T00:00:00+00:00"})
    monkeypatch.setattr(core, "get_index", lambda _settings: index)
    mock_repo(mock, "a/limiter")
    mock.get(f"{github.API}/repos/b/gone").respond(404)
    mock_repo(mock, "c/charts")
    result = await core.find_libraries("rate limiter for my API", limit=2, settings=settings)
    assert result.retrieval == "index" and result.index_built_at
    assert result.matches[0].report.repo == "a/limiter"
    assert "rate" in result.matches[0].reason
    assert all(m.report.repo != "b/gone" for m in result.matches)
    assert any("no longer on GitHub" in n for n in result.notes)
    assert [m.rank for m in result.matches] == list(range(1, len(result.matches) + 1))


@pytest.mark.anyio
async def test_find_libraries_falls_back_to_github_search(
    settings: Settings, mock: respx.MockRouter, monkeypatch: pytest.MonkeyPatch
) -> None:
    def no_index(_settings: Settings) -> RepoIndex:
        raise IndexUnavailableError("offline")

    monkeypatch.setattr(core, "get_index", no_index)
    mock.get(f"{github.API}/search/repositories").respond(
        200, json={"items": [{"full_name": "x/y", "description": "found live"}]}
    )
    mock_repo(mock, "x/y")
    result = await core.find_libraries("anything", settings=settings, with_summary=False)
    assert result.retrieval == "github-search"
    assert [m.report.repo for m in result.matches] == ["x/y"]
    assert "offline" in result.notes[0]


@pytest.mark.anyio
async def test_find_libraries_rejects_empty_query(settings: Settings) -> None:
    with pytest.raises(ValueError):
        await core.find_libraries("   ", settings=settings)


# --- check_dependencies ---------------------------------------------------


@pytest.mark.anyio
async def test_check_dependencies_end_to_end(
    settings: Settings, tmp_path: Path, mock: respx.MockRouter
) -> None:
    project = tmp_path / "app"
    project.mkdir()
    (project / "LICENSE").write_text(
        "MIT License\nPermission is hereby granted, free of charge, to any person"
    )
    (project / "requirements.txt").write_text(
        "requests==2.31.0\ngplthing==1.0\ninternal-lib==0.1\nodd==2.0\nflask>=3\n"
    )
    mock.post(f"{osv.API}/querybatch").respond(
        200, json={"results": [{}, {}, {}, {"vulns": [{"id": "GHSA-1"}]}]}
    )  # sorted order: gplthing, internal-lib, odd, requests
    mock.get(f"{osv.API}/vulns/GHSA-1").respond(200, json=OSV_VULN)
    mock.get(f"{depsdev.API}/systems/pypi/packages/requests/versions/2.31.0").respond(
        200, json={"licenses": ["Apache-2.0"]}
    )
    mock.get(f"{depsdev.API}/systems/pypi/packages/gplthing/versions/1.0").respond(
        200, json={"licenses": ["GPL-3.0-only"]}
    )
    mock.get(f"{depsdev.API}/systems/pypi/packages/internal-lib/versions/0.1").respond(404)
    mock.get(f"{depsdev.API}/systems/pypi/packages/odd/versions/2.0").respond(
        200, json={"licenses": ["non-standard"]}
    )

    report = await core.check_dependencies("app", settings=settings)
    assert report.project_license == "MIT"
    assert report.manifests == ["requirements.txt"]
    assert report.dependencies_found == 5 and report.checked == 4
    assert report.unpinned == ["pypi:flask"]
    assert [(f.dependency.name, [v.id for v in f.vulnerabilities]) for f in report.vulnerable] == [
        ("requests", ["GHSA-1"])
    ]
    problems = {i.dependency.name: i.problem for i in report.license_issues}
    assert "strong copyleft" in problems["gplthing"]
    assert "not found in the public registry" in problems["internal-lib"]
    assert "requests" not in problems and "odd" not in problems
    assert report.unrecognised_licenses == ["odd 2.0 (non-standard)"]


@pytest.mark.anyio
async def test_check_dependencies_refuses_paths_outside_workspace(settings: Settings, tmp_path: Path) -> None:
    with pytest.raises(OutsideWorkspaceError):
        await core.check_dependencies(str(tmp_path.parent), settings=settings)


@pytest.mark.anyio
async def test_check_dependencies_without_manifests(settings: Settings) -> None:
    report = await core.check_dependencies(".", settings=settings)
    assert report.manifests == [] and report.notes == ["No supported manifests or lockfiles found."]


# --- find_papers ----------------------------------------------------------

ARXIV = """<feed xmlns="http://www.w3.org/2005/Atom">
<entry><id>http://arxiv.org/abs/1</id><title>Shared Paper</title><published>2020-01-01</published></entry>
<entry><id>http://arxiv.org/abs/2</id><title>Only On ArXiv</title><published>2022-01-01</published></entry>
</feed>"""


@pytest.mark.anyio
async def test_find_papers_merges_sources(settings: Settings, mock: respx.MockRouter) -> None:
    mock.get(papers.ARXIV_API).respond(200, text=ARXIV)
    mock.get(papers.S2_API).respond(
        200,
        json={"data": [{"paperId": "p", "title": "Shared  paper", "citationCount": 50, "year": 2020}]},
    )
    result = await core.find_papers("filters", settings=settings)
    first = result.papers[0]
    assert first.title == "Shared Paper" and first.found_in == ["arxiv", "semantic-scholar"]
    assert first.citations.value == 50
    assert [p.title for p in result.papers] == ["Shared Paper", "Only On ArXiv"]
    assert len(result.sources) == 2 and not result.notes


@pytest.mark.anyio
async def test_find_papers_survives_one_source_failing(settings: Settings, mock: respx.MockRouter) -> None:
    mock.get(papers.ARXIV_API).respond(200, text=ARXIV)
    mock.get(papers.S2_API).mock(side_effect=httpx.ConnectError("down"))
    result = await core.find_papers("filters", limit=1, settings=settings)
    assert len(result.papers) == 1
    assert result.notes and result.notes[0].startswith("Semantic Scholar unavailable")
