"""Read dependency manifests and lockfiles from a local folder.

Read-only by design: the walker never writes, skips symlinks that leave the root,
and refuses any folder outside the configured workspace root.
"""

from __future__ import annotations

import json
import os
import re
import tomllib
from collections.abc import Iterable, Iterator
from pathlib import Path
from typing import Any

from ideation_goat.models import Dependency, Ecosystem
from ideation_goat.sources.depsdev import normalize_name

SKIP_DIRS = {
    ".git", ".hg", ".svn", "node_modules", ".venv", "venv", "env", "__pycache__", "dist", "build",
    "target", "vendor", ".tox", ".nox", ".mypy_cache", ".ruff_cache", ".pytest_cache", "site-packages",
    ".next", ".cache",
}  # fmt: skip
EXACT_NAMES = {
    "pyproject.toml", "uv.lock", "poetry.lock", "Pipfile.lock", "package.json", "package-lock.json",
    "Cargo.toml", "Cargo.lock", "go.mod",
}  # fmt: skip
MAX_FILE_BYTES = 5_000_000

_REQ_RE = re.compile(r"^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*(\[[^\]]*\])?\s*([^;]*)")
_PIN_RE = re.compile(r"^==\s*([A-Za-z0-9][A-Za-z0-9.+!_-]*)$")
_SEMVER_RE = re.compile(r"^=?v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?)$")
_GO_REQ_RE = re.compile(r"^\s*([^\s/()]+(?:/[^\s()]+)*)\s+(v[^\s]+)")


class OutsideWorkspaceError(ValueError):
    pass


def resolve_inside(root: Path, path: str | Path) -> Path:
    """Resolve ``path`` and require it to sit inside ``root`` (no prefix tricks)."""
    root = root.resolve()
    candidate = Path(path).expanduser()
    if not candidate.is_absolute():
        candidate = root / candidate
    candidate = candidate.resolve()
    if not candidate.is_relative_to(root):
        raise OutsideWorkspaceError(f"{candidate} is outside the allowed workspace {root}")
    return candidate


def find_manifests(root: Path, max_files: int = 300, max_depth: int = 6) -> list[Path]:
    root = root.resolve()
    found: list[Path] = []
    for current, dirs, files in os.walk(root, followlinks=False):
        here = Path(current)
        depth = len(here.relative_to(root).parts)
        dirs[:] = (
            sorted(d for d in dirs if d not in SKIP_DIRS and not d.startswith("."))
            if depth < max_depth
            else []
        )
        for name in sorted(files):
            if name in EXACT_NAMES or (name.startswith("requirements") and name.endswith(".txt")):
                path = here / name
                if path.is_symlink() and not path.resolve().is_relative_to(root):
                    continue
                found.append(path)
                if len(found) >= max_files:
                    return found
    return found


def collect_dependencies(root: Path, manifests: Iterable[Path]) -> list[Dependency]:
    """Parse every manifest, then drop range-only entries that a lockfile pins."""
    deps: list[Dependency] = []
    for path in manifests:
        try:
            if path.stat().st_size > MAX_FILE_BYTES:
                continue
            deps.extend(parse_manifest(path, root))
        except (OSError, ValueError, tomllib.TOMLDecodeError, json.JSONDecodeError, UnicodeDecodeError):
            continue
    pinned = {(d.ecosystem, d.name) for d in deps if d.version}
    unique: dict[tuple[str, str, str | None], Dependency] = {}
    for dep in deps:
        if dep.version is None and (dep.ecosystem, dep.name) in pinned:
            continue
        unique.setdefault((dep.ecosystem, dep.name, dep.version), dep)
    return sorted(unique.values(), key=lambda d: (d.ecosystem, d.name, d.version or ""))


def parse_manifest(path: Path, root: Path) -> list[Dependency]:
    rel = path.resolve().relative_to(root.resolve()).as_posix()
    name = path.name
    text = path.read_text(encoding="utf-8")
    if name.startswith("requirements"):
        items: Iterable[tuple[Ecosystem, str, str | None]] = parse_requirements(text)
    elif name == "pyproject.toml":
        items = parse_pyproject(tomllib.loads(text))
    elif name in {"uv.lock", "poetry.lock"}:
        items = parse_python_lock(tomllib.loads(text))
    elif name == "Pipfile.lock":
        items = parse_pipfile_lock(json.loads(text))
    elif name == "package.json":
        items = parse_package_json(json.loads(text))
    elif name == "package-lock.json":
        items = parse_package_lock(json.loads(text))
    elif name == "Cargo.toml":
        items = parse_cargo_toml(tomllib.loads(text))
    elif name == "Cargo.lock":
        items = parse_cargo_lock(tomllib.loads(text))
    elif name == "go.mod":
        items = parse_go_mod(text)
    else:
        return []
    return [
        Dependency(ecosystem=eco, name=normalize_name(eco, pkg), version=version, manifest=rel)
        for eco, pkg, version in items
    ]


# --- Python ---------------------------------------------------------------


def parse_requirement(spec: str) -> tuple[str, str | None] | None:
    """Parse a PEP 508 string; return (name, exact version or None)."""
    spec = spec.split("#", 1)[0].strip()
    if not spec or spec.startswith(("-", "git+", "http:", "https:", "file:", ".", "/")) or " @ " in spec:
        return None
    match = _REQ_RE.match(spec)
    if not match:
        return None
    constraint = match.group(3).strip().replace(" ", "")
    pin = _PIN_RE.match(constraint)
    version = pin.group(1) if pin and "*" not in constraint else None
    return match.group(1), version


def parse_requirements(text: str) -> Iterator[tuple[Ecosystem, str, str | None]]:
    for line in text.splitlines():
        parsed = parse_requirement(line)
        if parsed:
            yield "pypi", parsed[0], parsed[1]


def parse_pyproject(data: dict[str, Any]) -> Iterator[tuple[Ecosystem, str, str | None]]:
    project = data.get("project", {})
    specs: list[str] = list(project.get("dependencies", []))
    for group in project.get("optional-dependencies", {}).values():
        specs.extend(group)
    for group in data.get("dependency-groups", {}).values():
        specs.extend(s for s in group if isinstance(s, str))
    for spec in specs:
        parsed = parse_requirement(spec)
        if parsed:
            yield "pypi", parsed[0], parsed[1]

    poetry = data.get("tool", {}).get("poetry", {})
    tables = [poetry.get("dependencies", {}), poetry.get("dev-dependencies", {})]
    tables += [g.get("dependencies", {}) for g in poetry.get("group", {}).values()]
    for table in tables:
        for pkg, spec in table.items():
            if pkg.lower() == "python":
                continue
            if isinstance(spec, dict):
                if any(k in spec for k in ("path", "git", "url")):
                    continue
                spec = spec.get("version", "")
            spec = str(spec).strip()
            exact = re.fullmatch(r"(?:==)?\s*(\d[\w.+!-]*)", spec)
            yield "pypi", pkg, exact.group(1) if exact else None


def parse_python_lock(data: dict[str, Any]) -> Iterator[tuple[Ecosystem, str, str | None]]:
    for pkg in data.get("package", []):
        source = pkg.get("source", {})
        if isinstance(source, dict) and (
            source.get("type") in {"directory", "git", "file", "url"}
            or any(k in source for k in ("editable", "virtual", "directory", "git", "path"))
        ):
            continue
        if pkg.get("name") and pkg.get("version"):
            yield "pypi", pkg["name"], str(pkg["version"])


def parse_pipfile_lock(data: dict[str, Any]) -> Iterator[tuple[Ecosystem, str, str | None]]:
    for section in ("default", "develop"):
        for pkg, info in (data.get(section) or {}).items():
            version = str(info.get("version", ""))
            yield "pypi", pkg, version[2:] if version.startswith("==") else None


# --- JavaScript -----------------------------------------------------------


def parse_package_json(data: dict[str, Any]) -> Iterator[tuple[Ecosystem, str, str | None]]:
    for section in ("dependencies", "devDependencies", "optionalDependencies"):
        for pkg, spec in (data.get(section) or {}).items():
            if not isinstance(spec, str) or spec.startswith(
                ("workspace:", "file:", "link:", "git", "http", "npm:")
            ):
                continue
            exact = _SEMVER_RE.match(spec.strip())
            yield "npm", pkg, exact.group(1) if exact else None


def parse_package_lock(data: dict[str, Any]) -> Iterator[tuple[Ecosystem, str, str | None]]:
    packages = data.get("packages")
    if isinstance(packages, dict):
        for key, info in packages.items():
            if not key or "node_modules/" not in key or info.get("link") or not info.get("version"):
                continue
            yield "npm", key.rsplit("node_modules/", 1)[1], str(info["version"])
        return

    def walk(deps: dict[str, Any]) -> Iterator[tuple[Ecosystem, str, str | None]]:
        for pkg, info in deps.items():
            if info.get("version") and not str(info["version"]).startswith(("file:", "git")):
                yield "npm", pkg, str(info["version"])
            yield from walk(info.get("dependencies") or {})

    yield from walk(data.get("dependencies") or {})


# --- Rust and Go ----------------------------------------------------------


def parse_cargo_toml(data: dict[str, Any]) -> Iterator[tuple[Ecosystem, str, str | None]]:
    tables = [data.get(k, {}) for k in ("dependencies", "dev-dependencies", "build-dependencies")]
    for target in data.get("target", {}).values():
        tables += [target.get(k, {}) for k in ("dependencies", "dev-dependencies", "build-dependencies")]
    for table in tables:
        for pkg, spec in table.items():
            if isinstance(spec, dict):
                if any(k in spec for k in ("path", "git", "workspace")):
                    continue
                pkg = spec.get("package", pkg)
                spec = spec.get("version", "")
            spec = str(spec).strip()
            exact = re.fullmatch(r"=\s*(\d[\w.+-]*)", spec)
            yield "cargo", pkg, exact.group(1) if exact else None


def parse_cargo_lock(data: dict[str, Any]) -> Iterator[tuple[Ecosystem, str, str | None]]:
    for pkg in data.get("package", []):
        if str(pkg.get("source", "")).startswith("registry+") and pkg.get("version"):
            yield "cargo", pkg["name"], str(pkg["version"])


def parse_go_mod(text: str) -> Iterator[tuple[Ecosystem, str, str | None]]:
    in_block = False
    for raw in text.splitlines():
        line = raw.split("//", 1)[0].strip()
        if line.startswith("require ("):
            in_block = True
            continue
        if in_block and line == ")":
            in_block = False
            continue
        if line.startswith("require "):
            line = line[len("require ") :]
        elif not in_block:
            continue
        match = _GO_REQ_RE.match(line)
        if match:
            yield "go", match.group(1), match.group(2)


# --- Project license ------------------------------------------------------


def detect_project_license(root: Path) -> str | None:
    """Best-effort SPDX id for the project at ``root``."""
    try:
        pyproject = root / "pyproject.toml"
        if pyproject.is_file():
            project = tomllib.loads(pyproject.read_text(encoding="utf-8")).get("project", {})
            lic = project.get("license")
            if isinstance(lic, str) and lic.strip():
                return lic.strip()
            if isinstance(lic, dict) and isinstance(lic.get("text"), str) and len(lic["text"]) < 60:
                return str(lic["text"]).strip()
        package_json = root / "package.json"
        if package_json.is_file():
            lic = json.loads(package_json.read_text(encoding="utf-8")).get("license")
            if isinstance(lic, str) and lic.strip():
                return lic.strip()
        cargo = root / "Cargo.toml"
        if cargo.is_file():
            lic = tomllib.loads(cargo.read_text(encoding="utf-8")).get("package", {}).get("license")
            if isinstance(lic, str) and lic.strip():
                return lic.strip()
    except (OSError, ValueError, tomllib.TOMLDecodeError):
        pass
    for name in ("LICENSE", "LICENSE.md", "LICENSE.txt", "COPYING", "LICENCE"):
        path = root / name
        if path.is_file():
            try:
                return license_from_text(path.read_text(encoding="utf-8", errors="ignore")[:4000])
            except OSError:
                return None
    return None


def license_from_text(text: str) -> str | None:
    """Identify common licenses by their headers, not by loose substrings."""
    t = " ".join(text.split()).lower()
    rules = [
        ("gnu affero general public license", "AGPL-3.0"),
        ("gnu lesser general public license", "LGPL-3.0" if "version 3" in t else "LGPL-2.1"),
        ("gnu general public license", "GPL-3.0" if "version 3" in t else "GPL-2.0"),
        ("mozilla public license version 2.0", "MPL-2.0"),
        ("apache license version 2.0", "Apache-2.0"),
        ("apache license, version 2.0", "Apache-2.0"),
        ("permission is hereby granted, free of charge", "MIT"),
        ("permission to use, copy, modify, and/or distribute this software for any purpose", "ISC"),
        ("this is free and unencumbered software released into the public domain", "Unlicense"),
    ]
    for needle, spdx in rules:
        if needle in t:
            return spdx
    if "redistribution and use in source and binary forms" in t:
        return "BSD-3-Clause" if "neither the name" in t else "BSD-2-Clause"
    return None
