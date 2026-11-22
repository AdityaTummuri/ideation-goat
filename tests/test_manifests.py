import json
from pathlib import Path

import pytest

from ideation_goat.manifests import (
    OutsideWorkspaceError,
    collect_dependencies,
    detect_project_license,
    find_manifests,
    parse_go_mod,
    parse_requirement,
    resolve_inside,
)


def write(path: Path, text: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def deps_of(root: Path) -> set[tuple[str, str, str | None]]:
    return {(d.ecosystem, d.name, d.version) for d in collect_dependencies(root, find_manifests(root))}


@pytest.mark.parametrize(
    ("spec", "expected"),
    [
        ("requests==2.31.0", ("requests", "2.31.0")),
        ("Requests[socks] == 2.31.0 ; python_version > '3.8'", ("Requests", "2.31.0")),
        ("httpx>=0.27", ("httpx", None)),
        ("django==4.*", ("django", None)),
        ("numpy  # comment", ("numpy", None)),
        ("-r other.txt", None),
        ("git+https://github.com/o/r.git", None),
        ("pkg @ https://example.com/pkg.whl", None),
        ("", None),
    ],
)
def test_parse_requirement(spec: str, expected: tuple[str, str | None] | None) -> None:
    assert parse_requirement(spec) == expected


def test_python_manifests_and_lockfile_preference(tmp_path: Path) -> None:
    write(tmp_path / "requirements.txt", "Flask==3.0.0\nrequests>=2\n")
    write(
        tmp_path / "pyproject.toml",
        '[project]\nname="x"\ndependencies=["httpx>=0.27", "Pydantic_Core==2.1.0"]\n'
        '[project.optional-dependencies]\ndev=["pytest"]\n',
    )
    write(
        tmp_path / "uv.lock",
        '[[package]]\nname = "httpx"\nversion = "0.28.1"\nsource = { registry = "https://pypi.org/simple" }\n'
        '[[package]]\nname = "x"\nversion = "0.1.0"\nsource = { editable = "." }\n',
    )
    found = deps_of(tmp_path)
    assert ("pypi", "flask", "3.0.0") in found
    assert ("pypi", "pydantic-core", "2.1.0") in found
    assert ("pypi", "httpx", "0.28.1") in found
    assert ("pypi", "httpx", None) not in found  # the lockfile pins it
    assert ("pypi", "requests", None) in found
    assert not any(name == "x" for _, name, _ in found)  # editable self-reference skipped


def test_poetry_and_pipfile(tmp_path: Path) -> None:
    write(
        tmp_path / "pyproject.toml",
        '[tool.poetry.dependencies]\npython="^3.12"\nrich="13.7.0"\nclick="^8"\nlocal={path="../x"}\n',
    )
    write(tmp_path / "sub" / "Pipfile.lock", json.dumps({"default": {"six": {"version": "==1.16.0"}}}))
    found = deps_of(tmp_path)
    assert ("pypi", "rich", "13.7.0") in found
    assert ("pypi", "click", None) in found
    assert ("pypi", "six", "1.16.0") in found
    assert not any(name in {"python", "local"} for _, name, _ in found)


def test_npm_manifests(tmp_path: Path) -> None:
    write(
        tmp_path / "package.json",
        json.dumps(
            {
                "license": "MIT",
                "dependencies": {"lodash": "4.17.20", "react": "^18.0.0", "mine": "workspace:*"},
                "devDependencies": {"typescript": "=5.4.0"},
            }
        ),
    )
    write(
        tmp_path / "package-lock.json",
        json.dumps(
            {
                "lockfileVersion": 3,
                "packages": {
                    "": {"name": "app"},
                    "node_modules/react": {"version": "18.2.0"},
                    "node_modules/a/node_modules/@scope/b": {"version": "1.0.0"},
                    "node_modules/linked": {"link": True},
                },
            }
        ),
    )
    found = deps_of(tmp_path)
    assert {("npm", "lodash", "4.17.20"), ("npm", "typescript", "5.4.0"), ("npm", "react", "18.2.0")} <= found
    assert ("npm", "@scope/b", "1.0.0") in found
    assert ("npm", "react", None) not in found
    assert not any(name in {"mine", "linked"} for _, name, _ in found)
    assert detect_project_license(tmp_path) == "MIT"


def test_cargo_and_go(tmp_path: Path) -> None:
    write(
        tmp_path / "Cargo.toml",
        '[package]\nname="x"\nlicense="MIT OR Apache-2.0"\n[dependencies]\nserde="1"\ntokio={version="=1.38.0"}\n'
        'mine={path="../mine"}\n',
    )
    write(
        tmp_path / "Cargo.lock",
        '[[package]]\nname="serde"\nversion="1.0.200"\nsource="registry+https://github.com/rust-lang/crates.io-index"\n'
        '[[package]]\nname="x"\nversion="0.1.0"\n',
    )
    write(
        tmp_path / "go.mod",
        "module example.com/app\n\ngo 1.22\n\nrequire github.com/gin-gonic/gin v1.9.0\n"
        "require (\n\tgolang.org/x/net v0.20.0 // indirect\n)\n",
    )
    found = deps_of(tmp_path)
    assert {("cargo", "serde", "1.0.200"), ("cargo", "tokio", "1.38.0")} <= found
    assert {("go", "github.com/gin-gonic/gin", "v1.9.0"), ("go", "golang.org/x/net", "v0.20.0")} <= found
    assert not any(name in {"x", "mine"} for _, name, _ in found)
    assert detect_project_license(tmp_path) == "MIT OR Apache-2.0"


def test_go_mod_ignores_replace_and_module_lines() -> None:
    text = "module a/b\nreplace x/y => ../y\nrequire (\n  x/y v1.0.0\n)\n"
    assert list(parse_go_mod(text)) == [("go", "x/y", "v1.0.0")]


def test_walker_skips_vendor_dirs_and_bad_files(tmp_path: Path) -> None:
    write(tmp_path / "node_modules" / "pkg" / "package.json", '{"dependencies": {"evil": "1.0.0"}}')
    write(tmp_path / ".venv" / "requirements.txt", "evil==1.0.0")
    write(tmp_path / "pyproject.toml", "this is [ not toml")
    write(tmp_path / "app" / "requirements-dev.txt", "pytest==8.0.0")
    assert deps_of(tmp_path) == {("pypi", "pytest", "8.0.0")}


def test_resolve_inside_rejects_sibling_prefix(tmp_path: Path) -> None:
    root = tmp_path / "proj"
    (root / "sub").mkdir(parents=True)
    (tmp_path / "proj-evil").mkdir()
    assert resolve_inside(root, "sub") == (root / "sub").resolve()
    with pytest.raises(OutsideWorkspaceError):
        resolve_inside(root, tmp_path / "proj-evil")
    with pytest.raises(OutsideWorkspaceError):
        resolve_inside(root, "../proj-evil")


def test_symlink_leaving_root_is_skipped(tmp_path: Path) -> None:
    outside = write(tmp_path / "outside" / "requirements.txt", "evil==1.0.0")
    root = tmp_path / "root"
    root.mkdir()
    (root / "requirements.txt").symlink_to(outside)
    assert find_manifests(root) == []
