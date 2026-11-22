"""Plain-text (Markdown) rendering of results, used by the CLI."""

from __future__ import annotations

from ideation_goat.models import (
    CompareResult,
    DependencyReport,
    FindLibrariesResult,
    PackageReport,
    PapersResult,
    RepoReport,
    Signal,
    Vulnerability,
)


def show(signal: Signal) -> str:
    value = signal.value
    if value is None:
        return f"unknown ({signal.note})" if signal.note else "unknown"
    if isinstance(value, bool):
        return "yes" if value else "no"
    if isinstance(value, int):
        return f"{value:,}"
    if isinstance(value, str) and len(value) >= 10 and value[4] == "-" and "T" in value:
        return value[:10]
    return str(value)


def _health(report: RepoReport) -> str:
    if report.health is None or report.health.score is None:
        return "no score"
    text = f"{report.health.score}/100"
    if report.health.coverage < 1:
        text += f" ({round(report.health.coverage * 100)}% of inputs known)"
    return text


def render_find(result: FindLibrariesResult) -> str:
    lines = [f"# Libraries for: {result.query}", ""]
    if result.index_built_at:
        lines.append(f"_Index built {result.index_built_at[:10]}; retrieval: {result.retrieval}_\n")
    for match in result.matches:
        r = match.report
        lines.append(f"{match.rank}. **{r.repo}** — health {_health(r)}")
        lines.append(f"   {match.reason}")
        lines.append(
            f"   stars {show(r.stars)} · last push {show(r.last_push)}"
            f" · latest release {show(r.last_release)}"
            f" · license {show(r.license)}"
        )
        lines.append(f"   {r.url}")
        if r.note:
            lines.append(f"   note: {r.note}")
    if not result.matches:
        lines.append("No matches.")
    if result.summary:
        lines += ["", f"**Summary ({result.summary.generated_by}):** {result.summary.text}"]
    lines += [f"- {n}" for n in result.notes]
    return "\n".join(lines)


def render_compare(result: CompareResult) -> str:
    rows = [
        ("Health", _health),
        ("Stars", lambda r: show(r.stars)),
        ("Last push", lambda r: show(r.last_push)),
        ("Latest release", lambda r: show(r.last_release)),
        ("Contributors", lambda r: show(r.contributors)),
        ("Open issues+PRs", lambda r: show(r.open_issues)),
        ("License", lambda r: show(r.license)),
        ("OpenSSF Scorecard", lambda r: show(r.scorecard)),
        ("HN stories", lambda r: show(r.hn_stories)),
        ("Archived", lambda r: show(r.archived)),
        (
            "Cloud lock-in",
            lambda r: (
                "unknown"
                if r.lockin is None
                else (", ".join(sorted({f.vendor for f in r.lockin})) or "none found")
            ),
        ),
    ]
    header = "| | " + " | ".join(r.repo for r in result.repos) + " |"
    lines = [header, "|---" * (len(result.repos) + 1) + "|"]
    for label, fn in rows:
        lines.append(f"| {label} | " + " | ".join(fn(r) for r in result.repos) + " |")
    if result.summary:
        lines += ["", f"**Summary ({result.summary.generated_by}):** {result.summary.text}"]
    lines += [f"- {n}" for n in result.notes]
    return "\n".join(lines)


def _vuln_line(v: Vulnerability) -> str:
    fixed = f", fixed in {', '.join(v.fixed_in)}" if v.fixed_in else ""
    return f"- {v.id} [{v.severity or 'severity unknown'}] {v.summary or ''}{fixed} — {v.url}"


def render_package(report: PackageReport) -> str:
    title = f"{report.name} ({report.ecosystem})"
    if not report.exists:
        return "\n".join([f"# {title}: NOT FOUND", *report.notes])
    lines = [
        f"# {title}",
        f"latest version: {show(report.latest_version)}",
        f"checked version: {report.checked_version}",
        f"published: {show(report.published_at)}",
        f"license: {show(report.license)}",
        f"deprecated: {show(report.deprecated)}",
    ]
    if report.source_repo:
        lines.append(f"source: https://github.com/{report.source_repo}")
    lines.append(f"known vulnerabilities in {report.checked_version}: {len(report.vulnerabilities)}")
    lines += [_vuln_line(v) for v in report.vulnerabilities]
    lines += [f"- {n}" for n in report.notes]
    return "\n".join(lines)


def render_dependencies(report: DependencyReport) -> str:
    lines = [
        f"# Dependencies in {report.root}",
        f"project license: {report.project_license or 'unknown'}",
        f"manifests: {', '.join(report.manifests) or 'none'}",
        f"dependencies: {report.dependencies_found} found, {report.checked} pinned and checked",
        "",
        f"## Vulnerable ({len(report.vulnerable)})",
    ]
    for finding in report.vulnerable:
        d = finding.dependency
        lines.append(f"**{d.name} {d.version}** ({d.ecosystem}, {d.manifest})")
        lines += [_vuln_line(v) for v in finding.vulnerabilities]
    lines += ["", f"## License issues ({len(report.license_issues)})"]
    for issue in report.license_issues:
        d = issue.dependency
        lines.append(f"- {d.name} {d.version}: {issue.license or 'unknown'} — {issue.problem}")
    if report.unrecognised_licenses:
        lines += [
            "",
            "License not recognised in registry metadata (check manually): "
            + ", ".join(report.unrecognised_licenses),
        ]
    if report.unpinned:
        lines += ["", f"## Not checked (no exact version): {', '.join(report.unpinned)}"]
    lines += [f"- {n}" for n in report.notes]
    return "\n".join(lines)


def render_papers(result: PapersResult) -> str:
    lines = [f"# Papers on: {result.topic}", ""]
    for i, paper in enumerate(result.papers, 1):
        authors = ", ".join(paper.authors[:3]) + (" et al." if len(paper.authors) > 3 else "")
        lines.append(f"{i}. **{paper.title}** ({paper.year or 'n.d.'}) — {authors}")
        lines.append(
            f"   citations: {show(paper.citations)} · {paper.url}"
            + (f" · PDF {paper.pdf_url}" if paper.pdf_url else "")
        )
    if not result.papers:
        lines.append("No papers found.")
    lines += [f"- {n}" for n in result.notes]
    if any("semantic-scholar" in p.found_in for p in result.papers):
        lines.append("\nCitation data from Semantic Scholar (semanticscholar.org).")
    return "\n".join(lines)
