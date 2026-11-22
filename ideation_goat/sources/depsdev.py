"""deps.dev API v3: package existence, versions, deprecation and licenses."""

from __future__ import annotations

import re
from urllib.parse import quote

from ideation_goat.cache import DAY
from ideation_goat.fetch import Fetcher, Response
from ideation_goat.models import Ecosystem

API = "https://api.deps.dev/v3"
SYSTEMS: dict[Ecosystem, str] = {"pypi": "pypi", "npm": "npm", "cargo": "cargo", "go": "go"}


def normalize_name(ecosystem: Ecosystem, name: str) -> str:
    name = name.strip()
    if ecosystem == "pypi":
        return re.sub(r"[-_.]+", "-", name).lower()
    return name


def package_page(ecosystem: Ecosystem, name: str, version: str | None = None) -> str:
    url = f"https://deps.dev/{SYSTEMS[ecosystem]}/{quote(name, safe='')}"
    return f"{url}/{quote(version, safe='')}" if version else url


async def get_package(fetch: Fetcher, ecosystem: Ecosystem, name: str) -> Response:
    return await fetch.get(f"{API}/systems/{SYSTEMS[ecosystem]}/packages/{quote(name, safe='')}", ttl=DAY)


async def get_version(fetch: Fetcher, ecosystem: Ecosystem, name: str, version: str) -> Response:
    return await fetch.get(
        f"{API}/systems/{SYSTEMS[ecosystem]}/packages/{quote(name, safe='')}"
        f"/versions/{quote(version, safe='')}",
        ttl=DAY,
    )
