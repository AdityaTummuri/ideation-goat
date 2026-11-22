import json
from pathlib import Path

import pytest
import respx

from ideation_goat import cli, core, render
from ideation_goat.config import Settings
from ideation_goat.models import (
    CompareResult,
    FindLibrariesResult,
    HealthScore,
    LibraryMatch,
    LockinFinding,
    Paper,
    PapersResult,
    RepoReport,
    Signal,
    Summary,
)
from ideation_goat.sources import depsdev


def test_show_formats_signals() -> None:
    assert render.show(Signal()) == "unknown"
    assert render.show(Signal(note="not scanned")) == "unknown (not scanned)"
    assert render.show(Signal(value=True)) == "yes"
    assert render.show(Signal(value=12345)) == "12,345"
    assert render.show(Signal(value="2026-11-20T00:00:00Z")) == "2026-11-20"


def _report() -> RepoReport:
    return RepoReport(
        repo="a/b",
        url="https://github.com/a/b",
        stars=Signal(value=10),
        health=HealthScore(score=80, coverage=0.75, parts=[]),
        lockin=[LockinFinding(package="boto3", vendor="AWS", manifest="requirements.txt")],
        note="partial",
    )


def test_render_find_and_compare() -> None:
    find = FindLibrariesResult(
        query="q",
        retrieval="index",
        index_built_at="2026-11-23T00:00:00+00:00",
        matches=[LibraryMatch(rank=1, report=_report(), relevance=0.03, reason="why")],
        summary=Summary(text="s", generated_by="template"),
        notes=["n"],
    )
    text = render.render_find(find)
    assert "**a/b** — health 80/100 (75% of inputs known)" in text and "note: partial" in text
    table = render.render_compare(CompareResult(repos=[_report(), RepoReport(repo="c/d", url="u")]))
    assert "| Cloud lock-in | AWS | unknown |" in table
    assert "No matches." in render.render_find(FindLibrariesResult(query="q", retrieval="index", matches=[]))


def test_render_papers() -> None:
    result = PapersResult(
        topic="t",
        papers=[Paper(title="P", authors=list("abcd"), url="u", pdf_url="p", found_in=["semantic-scholar"])],
    )
    text = render.render_papers(result)
    assert "a, b, c et al." in text and "Semantic Scholar" in text


def test_cli_verify_json(
    settings: Settings,
    mock: respx.MockRouter,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.setattr(core, "get_settings", lambda: settings)
    mock.get(f"{depsdev.API}/systems/pypi/packages/nope").respond(404)
    assert cli.main(["verify", "nope", "--json"]) == 0
    assert json.loads(capsys.readouterr().out)["exists"] is False
    assert cli.main(["verify", "nope"]) == 0
    assert "NOT FOUND" in capsys.readouterr().out


def test_cli_check_and_errors(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    (tmp_path / "requirements.txt").write_text("flask>=3\n")
    assert cli.main(["check", str(tmp_path)]) == 0
    out = capsys.readouterr().out
    assert "1 found, 0 pinned" in out and "pypi:flask" in out
    assert cli.main(["verify", "x", "-e", "maven"]) == 2
    assert "unsupported ecosystem" in capsys.readouterr().err
