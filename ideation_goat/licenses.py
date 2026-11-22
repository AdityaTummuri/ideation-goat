"""Classify SPDX license expressions and flag combinations worth a closer look.

These are signals for a human to check, not legal advice.
"""

from __future__ import annotations

import re
from typing import Literal

Category = Literal["permissive", "weak-copyleft", "strong-copyleft", "network-copyleft", "unknown"]

_RANK: dict[Category, int] = {
    "permissive": 0,
    "weak-copyleft": 1,
    "strong-copyleft": 2,
    "network-copyleft": 3,
    "unknown": 4,
}
_PERMISSIVE = {
    "MIT", "MIT-0", "ISC", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "0BSD", "Zlib", "Unlicense",
    "CC0-1.0", "PSF-2.0", "Python-2.0", "BSL-1.0", "Unicode-DFS-2016", "Unicode-3.0", "BlueOak-1.0.0",
    "WTFPL", "X11", "MIT-CMU", "Python-2.0.1", "Unicode-TOU",
    "PostgreSQL", "NCSA", "HPND", "CC-BY-4.0", "BSD-3-Clause-Clear", "Apache-1.1",
}  # fmt: skip
_WEAK_PREFIXES = ("LGPL-", "MPL-", "EPL-", "CDDL-", "CPL-")
_STRONG_PREFIXES = ("GPL-", "EUPL-", "OSL-")
_NETWORK_PREFIXES = ("AGPL-", "SSPL-")


def classify_id(spdx_id: str) -> Category:
    spdx_id = spdx_id.strip().strip("()").removesuffix("+")
    if spdx_id in _PERMISSIVE:
        return "permissive"
    if spdx_id.startswith(_NETWORK_PREFIXES):
        return "network-copyleft"
    if spdx_id.startswith(_WEAK_PREFIXES):
        return "weak-copyleft"
    if spdx_id.startswith(_STRONG_PREFIXES):
        return "strong-copyleft"
    return "unknown"


def classify(expression: str | None) -> Category:
    """OR picks the most permissive option; AND keeps the most restrictive part."""
    if not expression or not expression.strip():
        return "unknown"
    expression = re.sub(r"\s+WITH\s+\S+", "", expression.strip())
    alternatives = re.split(r"\s+OR\s+", expression.strip("()"), flags=re.IGNORECASE)
    best: Category = "unknown"
    for alternative in alternatives:
        parts = re.split(r"\s+AND\s+", alternative.strip("()"), flags=re.IGNORECASE)
        worst = max((classify_id(p) for p in parts), key=_RANK.__getitem__)
        if _RANK[worst] < _RANK[best]:
            best = worst
    return best


def conflict(project_license: str | None, dependency_license: str | None) -> str | None:
    """Return a short explanation when the pair needs a closer look, else None."""
    dep = classify(dependency_license)
    if dep == "unknown":
        return "no recognised open-source license"
    project = classify(project_license)
    if project in {"permissive", "weak-copyleft", "unknown"}:
        if dep == "network-copyleft":
            return "network copyleft: offering the software over a network can require releasing your source"
        if dep == "strong-copyleft":
            return (
                "strong copyleft: distributing a combined work requires releasing it under the same license"
            )
        return None
    project_ids = project_license or ""
    if project == "strong-copyleft" and "GPL-3.0" in project_ids:
        dep_ids = dependency_license or ""
        if re.search(r"(?<![AL])GPL-2\.0(-only)?\b(?!\+|-or-later)", dep_ids) and "OR" not in dep_ids:
            return "GPL-2.0-only code can't be combined with GPL-3.0 code"
    return None
