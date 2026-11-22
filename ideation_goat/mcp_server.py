"""MCP server: five read-only tools over the core operations."""

from __future__ import annotations

import logging
import sys
from typing import Annotated

from mcp.server.mcpserver import MCPServer
from mcp_types import ToolAnnotations
from pydantic import Field

from ideation_goat import core
from ideation_goat.models import (
    CompareResult,
    DependencyReport,
    FindLibrariesResult,
    PackageReport,
    PapersResult,
)

INSTRUCTIONS = (
    "Use these tools to pick open-source libraries and check they are safe to depend on. "
    "Every value carries a source URL and fetch time; null means unknown, never zero. "
    "Call verify_package before recommending a package you are not sure exists."
)
READ_ONLY = ToolAnnotations(
    read_only_hint=True, destructive_hint=False, idempotent_hint=True, open_world_hint=True
)

server = MCPServer(name="ideation-goat", instructions=INSTRUCTIONS)


@server.tool(annotations=READ_ONLY)
async def find_libraries(
    idea: Annotated[str, Field(description="What you want to build, in plain words")],
    language: Annotated[str | None, Field(description="Optional language filter, e.g. Python")] = None,
    limit: Annotated[int, Field(ge=1, le=10)] = 5,
) -> FindLibrariesResult:
    """Rank open-source libraries for an idea, each with live health, license and release signals."""
    return await core.find_libraries(idea, language, limit)


@server.tool(annotations=READ_ONLY)
async def compare_libraries(
    repos: Annotated[list[str], Field(min_length=2, max_length=5, description="GitHub repos as owner/name")],
) -> CompareResult:
    """Side-by-side scorecard for 2-5 GitHub repos: health, releases, security, license, lock-in."""
    return await core.compare_libraries(repos)


@server.tool(annotations=READ_ONLY)
async def verify_package(
    name: Annotated[str, Field(description="Package name, e.g. requests or @types/node")],
    ecosystem: Annotated[str, Field(description="pypi, npm, cargo or go")],
    version: Annotated[str | None, Field(description="Optional exact version to check")] = None,
) -> PackageReport:
    """Check a package exists, its latest version, deprecation, license and known vulnerabilities."""
    return await core.verify_package(name, ecosystem, version)


@server.tool(annotations=READ_ONLY)
async def check_dependencies(
    path: Annotated[str, Field(description="Project folder, relative to the server's workspace root")] = ".",
) -> DependencyReport:
    """Find vulnerable pinned dependencies and license conflicts in a project's manifests and lockfiles."""
    return await core.check_dependencies(path)


@server.tool(annotations=READ_ONLY)
async def find_papers(
    topic: Annotated[str, Field(description="Research topic")],
    limit: Annotated[int, Field(ge=1, le=20)] = 8,
) -> PapersResult:
    """Find papers on a topic from arXiv and Semantic Scholar, with citation counts and open PDFs."""
    return await core.find_papers(topic, limit)


def run(transport: str = "stdio", host: str = "127.0.0.1", port: int = 8000) -> None:
    # MCP over stdio reserves stdout for protocol messages, so logs go to stderr.
    logging.basicConfig(level=logging.WARNING, stream=sys.stderr)
    if transport == "stdio":
        server.run("stdio")
    else:
        server.run("streamable-http", host=host, port=port)
