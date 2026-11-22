"""Flag cloud-vendor SDKs in a GitHub repo's top-level manifests."""

from __future__ import annotations

import asyncio
import json
import re
import tomllib
from collections.abc import Iterable

from ideation_goat import manifests
from ideation_goat.fetch import Fetcher, FetchError
from ideation_goat.models import Ecosystem, LockinFinding
from ideation_goat.sources import github

VENDOR_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"^(@aws-sdk/.*|aws-sdk|boto3|botocore|aws-cdk.*|aws-amplify|@aws-amplify/.*)$"), "AWS"),
    (re.compile(r"^(@google-cloud/.*|google-cloud-.*|firebase|firebase-admin)$"), "Google Cloud / Firebase"),
    (re.compile(r"^(@azure/.*|azure-.*)$"), "Microsoft Azure"),
    (re.compile(r"^(@vercel/.*|vercel)$"), "Vercel"),
    (re.compile(r"^(wrangler|@cloudflare/.*)$"), "Cloudflare"),
    (re.compile(r"^(@supabase/.*|supabase)$"), "Supabase"),
    (
        re.compile(
            r"^(github\.com/aws/aws-sdk-go.*|cloud\.google\.com/go.*|github\.com/azure/azure-sdk-.*)$"
        ),
        "Cloud SDK",
    ),
]
MANIFEST_FILES = ("package.json", "requirements.txt", "pyproject.toml", "go.mod", "Cargo.toml")


def match_vendor(package: str) -> str | None:
    name = package.lower()
    for pattern, vendor in VENDOR_PATTERNS:
        if pattern.match(name):
            return vendor
    return None


def _names(filename: str, text: str) -> Iterable[tuple[Ecosystem, str, str | None]]:
    if filename == "package.json":
        return manifests.parse_package_json(json.loads(text))
    if filename == "requirements.txt":
        return manifests.parse_requirements(text)
    if filename == "pyproject.toml":
        return manifests.parse_pyproject(tomllib.loads(text))
    if filename == "go.mod":
        return manifests.parse_go_mod(text)
    return manifests.parse_cargo_toml(tomllib.loads(text))


async def check_lockin(fetch: Fetcher, repo: str) -> list[LockinFinding] | None:
    """Return vendor SDK findings, or None when no manifest could be read."""

    async def read(filename: str) -> tuple[str, str | None]:
        try:
            response = await github.get_raw_file(fetch, repo, filename)
        except FetchError:
            return filename, None
        return filename, response.text if response.ok else None

    files = await asyncio.gather(*(read(f) for f in MANIFEST_FILES))
    read_any = False
    findings: dict[str, LockinFinding] = {}
    for filename, text in files:
        if text is None:
            continue
        try:
            entries = list(_names(filename, text))
        except (ValueError, tomllib.TOMLDecodeError):
            continue
        read_any = True
        for _, package, _ in entries:
            vendor = match_vendor(package)
            if vendor and package not in findings:
                findings[package] = LockinFinding(package=package, vendor=vendor, manifest=filename)
    return list(findings.values()) if read_any else None
