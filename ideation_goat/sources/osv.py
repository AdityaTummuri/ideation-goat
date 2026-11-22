"""OSV.dev vulnerability lookups. Every query sends an exact version."""

from __future__ import annotations

import asyncio
from collections.abc import Sequence
from typing import Any

from ideation_goat.cache import HOUR
from ideation_goat.fetch import Fetcher
from ideation_goat.models import Ecosystem, Source, Vulnerability

API = "https://api.osv.dev/v1"
VULN_TTL = 6 * HOUR
BATCH_SIZE = 1000
OSV_ECOSYSTEMS: dict[Ecosystem, str] = {"pypi": "PyPI", "npm": "npm", "cargo": "crates.io", "go": "Go"}


async def query_batch(
    fetch: Fetcher, packages: Sequence[tuple[Ecosystem, str, str]]
) -> tuple[list[list[str]], Source | None]:
    """Return the vulnerability ids affecting each (ecosystem, name, version)."""
    ids: list[list[str]] = []
    source: Source | None = None
    for start in range(0, len(packages), BATCH_SIZE):
        chunk = packages[start : start + BATCH_SIZE]
        body = {
            "queries": [
                {"package": {"ecosystem": OSV_ECOSYSTEMS[eco], "name": name}, "version": version}
                for eco, name, version in chunk
            ]
        }
        response = await fetch.post(f"{API}/querybatch", json_body=body, ttl=VULN_TTL)
        if not response.ok:
            raise RuntimeError(f"OSV querybatch returned HTTP {response.status}")
        source = response.source
        for result in response.json().get("results", []):
            ids.append([v["id"] for v in (result or {}).get("vulns", [])])
    return ids, source


async def get_vulnerability(fetch: Fetcher, vuln_id: str, package: str) -> Vulnerability:
    url = f"https://osv.dev/vulnerability/{vuln_id}"
    response = await fetch.get(f"{API}/vulns/{vuln_id}", ttl=VULN_TTL)
    if not response.ok:
        return Vulnerability(id=vuln_id, url=url)
    return parse_vulnerability(response.json(), package)


def parse_vulnerability(data: dict[str, Any], package: str) -> Vulnerability:
    vuln_id = data["id"]
    fixed: list[str] = []
    for affected in data.get("affected", []):
        if affected.get("package", {}).get("name", "").lower() != package.lower():
            continue
        for rng in affected.get("ranges", []):
            fixed.extend(e["fixed"] for e in rng.get("events", []) if "fixed" in e)
    severity = (data.get("database_specific") or {}).get("severity")
    if not severity and data.get("severity"):
        severity = data["severity"][0].get("score")
    return Vulnerability(
        id=vuln_id,
        aliases=data.get("aliases", []),
        summary=data.get("summary") or (data.get("details") or "")[:200] or None,
        severity=severity,
        fixed_in=sorted(set(fixed)),
        url=f"https://osv.dev/vulnerability/{vuln_id}",
    )


def dedupe(vulns: list[Vulnerability]) -> list[Vulnerability]:
    """OSV lists one issue under several ids (GHSA, PYSEC, CVE). Keep one per issue."""
    seen: set[str] = set()
    result = []
    for vuln in sorted(vulns, key=lambda v: (not v.id.startswith("GHSA"), v.id)):
        names = {vuln.id, *vuln.aliases}
        if names & seen:
            continue
        seen |= names
        result.append(vuln)
    return result


async def vulnerabilities_for(
    fetch: Fetcher, packages: Sequence[tuple[Ecosystem, str, str]]
) -> tuple[list[list[Vulnerability]], Source | None]:
    ids, source = await query_batch(fetch, packages)

    async def details(index: int) -> list[Vulnerability]:
        name = packages[index][1]
        found = await asyncio.gather(*(get_vulnerability(fetch, i, name) for i in ids[index]))
        return dedupe(list(found))

    results = await asyncio.gather(*(details(i) for i in range(len(ids))))
    return list(results), source
