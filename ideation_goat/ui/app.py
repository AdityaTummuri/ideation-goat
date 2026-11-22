"""Streamlit demo over the same core the MCP server uses.

Run locally:  streamlit run streamlit_app.py
"""

from __future__ import annotations

import asyncio
import os
from collections.abc import Coroutine
from typing import Any

import streamlit as st

for key in ("GITHUB_TOKEN", "GEMINI_API_KEY", "GROQ_API_KEY", "SEMANTIC_SCHOLAR_API_KEY"):
    try:
        if key in st.secrets and not os.environ.get(key):
            os.environ[key] = str(st.secrets[key])
    except FileNotFoundError:  # no secrets file locally
        break

from ideation_goat import core  # noqa: E402 - secrets must be in the environment first
from ideation_goat.models import RepoReport, Signal, Vulnerability  # noqa: E402
from ideation_goat.render import show  # noqa: E402

MCP_CONFIG = """{
  "mcpServers": {
    "ideation-goat": {
      "command": "uvx",
      "args": ["ideation-goat"],
      "env": { "GITHUB_TOKEN": "<optional, raises GitHub rate limits>" }
    }
  }
}"""


def run[T](coro: Coroutine[Any, Any, T]) -> T:
    return asyncio.run(coro)


def sourced(signal: Signal) -> str:
    text = show(signal)
    return f"[{text}]({signal.source.url})" if signal.source else text


def health_badge(report: RepoReport) -> str:
    if not report.health or report.health.score is None:
        return "no score"
    score = report.health.score
    colour = "green" if score >= 75 else "orange" if score >= 50 else "red"
    text = f":{colour}[**{score}/100**]"
    if report.health.coverage < 1:
        text += f" · {round(report.health.coverage * 100)}% of inputs known"
    return text


def vuln_table(vulns: list[Vulnerability]) -> None:
    st.dataframe(
        [
            {
                "id": v.id,
                "severity": v.severity or "unknown",
                "summary": v.summary,
                "fixed in": ", ".join(v.fixed_in),
                "link": v.url,
            }
            for v in vulns
        ],
        column_config={"link": st.column_config.LinkColumn()},
        hide_index=True,
        width="stretch",
    )


st.set_page_config(page_title="Ideation GOAT", page_icon="🐐", layout="wide")
st.title("Ideation GOAT")
st.caption(
    "Find open-source libraries for an idea and check they're safe to depend on. "
    "Every number links to where it came from; anything we couldn't fetch shows as unknown."
)

find_tab, compare_tab, verify_tab, papers_tab, mcp_tab = st.tabs(
    ["Find libraries", "Compare", "Verify a package", "Papers", "Use with MCP"]
)

with find_tab:
    with st.form("find"):
        idea = st.text_input("What do you want to build?", placeholder="rate limiter for a Python API")
        language = st.selectbox(
            "Language", ["Any", "Python", "JavaScript", "TypeScript", "Go", "Rust", "Java"]
        )
        submitted = st.form_submit_button("Find libraries")
    if submitted and idea.strip():
        with st.spinner("Searching the index and fetching live signals..."):
            result = run(core.find_libraries(idea, None if language == "Any" else language))
        st.session_state["last_matches"] = [m.report.repo for m in result.matches]
        if result.summary:
            st.info(f"{result.summary.text}  \n_summary: {result.summary.generated_by}_")
        for match in result.matches:
            r = match.report
            with st.container(border=True):
                st.markdown(f"### {match.rank}. [{r.repo}]({r.url})  {health_badge(r)}")
                st.write(match.reason)
                cols = st.columns(4)
                cols[0].markdown(f"**Stars**  \n{sourced(r.stars)}")
                cols[1].markdown(f"**Last push**  \n{sourced(r.last_push)}")
                cols[2].markdown(f"**Latest release**  \n{sourced(r.last_release)}")
                cols[3].markdown(f"**License**  \n{sourced(r.license)}")
                if r.note:
                    st.warning(r.note)
        for note in result.notes:
            st.caption(note)
        if result.index_built_at:
            st.caption(f"Index built {result.index_built_at[:10]} · retrieval: {result.retrieval}")

with compare_tab:
    default = ", ".join(st.session_state.get("last_matches", [])[:3]) or "fastapi/fastapi, pallets/flask"
    raw = st.text_input("GitHub repos (2-5, comma separated)", value=default)
    if st.button("Compare"):
        try:
            with st.spinner("Fetching signals..."):
                result = run(core.compare_libraries([r for r in raw.replace(" ", "").split(",") if r]))
        except ValueError as exc:
            st.error(str(exc))
        else:
            rows = {
                "Health": lambda r: health_badge(r),
                "Stars": lambda r: sourced(r.stars),
                "Last push": lambda r: sourced(r.last_push),
                "Latest release": lambda r: sourced(r.last_release),
                "Contributors": lambda r: sourced(r.contributors),
                "Open issues + PRs": lambda r: sourced(r.open_issues),
                "License": lambda r: sourced(r.license),
                "OpenSSF Scorecard": lambda r: sourced(r.scorecard),
                "HN stories": lambda r: sourced(r.hn_stories),
                "Archived": lambda r: sourced(r.archived),
                "Cloud lock-in": lambda r: (
                    "unknown"
                    if r.lockin is None
                    else (", ".join(sorted({f.vendor for f in r.lockin})) or "none found")
                ),
            }
            table = "| | " + " | ".join(f"[{r.repo}]({r.url})" for r in result.repos) + " |\n"
            table += "|---" * (len(result.repos) + 1) + "|\n"
            for label, fn in rows.items():
                table += f"| {label} | " + " | ".join(fn(r) for r in result.repos) + " |\n"
            st.markdown(table)
            if result.summary:
                st.info(f"{result.summary.text}  \n_summary: {result.summary.generated_by}_")
            for note in result.notes:
                st.caption(note)
            with st.expander("How the health score works"):
                st.markdown(
                    "Maintenance 30 (last push) · Releases 15 · Community 15 (contributors) · "
                    "Adoption 15 (stars, log scale) · Security 25 (OpenSSF Scorecard). Unknown inputs are "
                    "left out and the score is rescaled. These are signals, not a security audit."
                )

with verify_tab:
    with st.form("verify"):
        cols = st.columns([3, 1, 1])
        name = cols[0].text_input("Package", placeholder="requests")
        ecosystem = cols[1].selectbox("Ecosystem", ["pypi", "npm", "cargo", "go"])
        version = cols[2].text_input("Version (optional)")
        submitted = st.form_submit_button("Verify")
    if submitted and name.strip():
        with st.spinner("Checking deps.dev and OSV..."):
            report = run(core.verify_package(name, ecosystem, version or None))
        if not report.exists:
            st.error(" ".join(report.notes))
        else:
            cols = st.columns(4)
            cols[0].markdown(f"**Latest**  \n{sourced(report.latest_version)}")
            cols[1].markdown(f"**License**  \n{sourced(report.license)}")
            cols[2].markdown(f"**Deprecated**  \n{sourced(report.deprecated)}")
            cols[3].markdown(f"**Published**  \n{sourced(report.published_at)}")
            if report.vulnerabilities:
                st.error(f"{len(report.vulnerabilities)} known vulnerabilities in {report.checked_version}")
                vuln_table(report.vulnerabilities)
            else:
                st.success(f"No known vulnerabilities in {report.checked_version} (OSV.dev).")
            for note in report.notes:
                st.caption(note)

with papers_tab:
    topic = st.text_input("Research topic", placeholder="probabilistic data structures")
    if st.button("Find papers") and topic.strip():
        with st.spinner("Querying arXiv and Semantic Scholar..."):
            result = run(core.find_papers(topic))
        for paper in result.papers:
            pdf = f" · [PDF]({paper.pdf_url})" if paper.pdf_url else ""
            authors = ", ".join(paper.authors[:3]) + (" et al." if len(paper.authors) > 3 else "")
            st.markdown(
                f"**[{paper.title}]({paper.url})** ({paper.year or 'n.d.'}) — {authors}  \n"
                f"citations: {sourced(paper.citations)}{pdf}"
            )
        for note in result.notes:
            st.caption(note)
        st.caption(
            "Citation data from Semantic Scholar. "
            "Thank you to arXiv for use of its open access interoperability."
        )

with mcp_tab:
    st.markdown(
        "The same five tools are available to AI coding agents over MCP. "
        "Add this to your client's MCP config "
        "(Claude Desktop, Claude Code, VS Code, Cursor):"
    )
    st.code(MCP_CONFIG, language="json")
    st.markdown("`check_dependencies` scans a local project, so it's only available through MCP and the CLI.")
