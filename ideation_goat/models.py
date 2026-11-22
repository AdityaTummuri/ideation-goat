"""Typed results shared by the MCP server, the CLI and the web demo.

Rule for every model: a value we could not fetch is ``None`` (shown as "unknown"),
never a guess, and every fetched value carries the URL it came from and when.
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

Ecosystem = Literal["pypi", "npm", "cargo", "go"]


class Source(BaseModel):
    url: str
    fetched_at: datetime


class Signal(BaseModel):
    """One sourced fact. ``value`` is None when the fact is unknown."""

    value: str | int | float | bool | None = None
    source: Source | None = None
    note: str | None = None

    @property
    def known(self) -> bool:
        return self.value is not None


class ScorePart(BaseModel):
    name: str
    points: float | None = Field(description="Points earned; null when the input signal is unknown")
    max_points: float
    reason: str


class HealthScore(BaseModel):
    score: int | None = Field(description="0-100, or null when under half the inputs are known")
    coverage: float = Field(description="Share of the score's weight backed by known signals (0-1)")
    parts: list[ScorePart]
    flags: list[str] = Field(default_factory=list)


class LockinFinding(BaseModel):
    package: str
    vendor: str
    manifest: str


class RepoReport(BaseModel):
    repo: str = Field(description="owner/name")
    url: str
    found: bool = True
    note: str | None = Field(default=None, description="Why data is missing, e.g. a rate limit")
    description: str | None = None
    language: str | None = None
    stars: Signal = Field(default_factory=Signal)
    forks: Signal = Field(default_factory=Signal)
    open_issues: Signal = Field(default_factory=Signal, description="Open issues plus open pull requests")
    last_push: Signal = Field(default_factory=Signal, description="ISO date of the last push")
    last_release: Signal = Field(default_factory=Signal, description="ISO date of the latest GitHub release")
    contributors: Signal = Field(default_factory=Signal)
    license: Signal = Field(default_factory=Signal, description="SPDX id")
    archived: Signal = Field(default_factory=Signal)
    scorecard: Signal = Field(default_factory=Signal, description="OpenSSF Scorecard, 0-10")
    hn_stories: Signal = Field(default_factory=Signal, description="Hacker News stories mentioning the repo")
    lockin: list[LockinFinding] | None = Field(
        default=None, description="Cloud-vendor SDKs in the repo's manifests; null when not checked"
    )
    health: HealthScore | None = None


class LibraryMatch(BaseModel):
    rank: int
    report: RepoReport
    relevance: float = Field(description="Fused retrieval score; only comparable within one query")
    reason: str


class Summary(BaseModel):
    text: str
    generated_by: Literal["gemini", "groq", "template"]


class FindLibrariesResult(BaseModel):
    query: str
    language: str | None = None
    retrieval: Literal["index", "github-search"]
    index_built_at: str | None = None
    matches: list[LibraryMatch]
    summary: Summary | None = None
    notes: list[str] = Field(default_factory=list)


class CompareResult(BaseModel):
    repos: list[RepoReport]
    summary: Summary | None = None
    notes: list[str] = Field(default_factory=list)


class Vulnerability(BaseModel):
    id: str
    aliases: list[str] = Field(default_factory=list)
    summary: str | None = None
    severity: str | None = None
    fixed_in: list[str] = Field(default_factory=list)
    url: str


class PackageReport(BaseModel):
    ecosystem: Ecosystem
    name: str
    exists: bool
    requested_version: str | None = None
    version_exists: bool | None = Field(default=None, description="Null when no version was requested")
    latest_version: Signal = Field(default_factory=Signal)
    published_at: Signal = Field(default_factory=Signal, description="Publish date of the checked version")
    deprecated: Signal = Field(default_factory=Signal)
    license: Signal = Field(default_factory=Signal)
    source_repo: str | None = None
    checked_version: str | None = Field(default=None, description="Version the vulnerabilities apply to")
    vulnerabilities: list[Vulnerability] = Field(default_factory=list)
    vulnerabilities_source: Source | None = None
    notes: list[str] = Field(default_factory=list)


class Dependency(BaseModel):
    ecosystem: Ecosystem
    name: str
    version: str | None = Field(description="Exact version, or null when only a range is declared")
    manifest: str = Field(description="Path relative to the checked folder")


class DependencyFinding(BaseModel):
    dependency: Dependency
    vulnerabilities: list[Vulnerability]


class LicenseIssue(BaseModel):
    dependency: Dependency
    license: str | None
    problem: str


class DependencyReport(BaseModel):
    root: str
    project_license: str | None
    manifests: list[str]
    dependencies_found: int
    checked: int = Field(description="Dependencies with an exact version, checked against OSV")
    unpinned: list[str] = Field(description="Dependencies without an exact version, so not checked")
    vulnerable: list[DependencyFinding]
    license_issues: list[LicenseIssue]
    unrecognised_licenses: list[str] = Field(
        default_factory=list, description="Dependencies whose registry license isn't a recognised SPDX id"
    )
    sources: list[Source] = Field(default_factory=list)
    notes: list[str] = Field(default_factory=list)


class Paper(BaseModel):
    title: str
    authors: list[str] = Field(default_factory=list)
    year: int | None = None
    url: str
    pdf_url: str | None = None
    citations: Signal = Field(default_factory=Signal)
    found_in: list[Literal["arxiv", "semantic-scholar"]]


class PapersResult(BaseModel):
    topic: str
    papers: list[Paper]
    sources: list[Source] = Field(default_factory=list)
    notes: list[str] = Field(default_factory=list)
