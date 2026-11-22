import os
import sys

import pytest
import respx
from mcp import Client, StdioServerParameters

from ideation_goat import core, mcp_server
from ideation_goat.config import Settings
from ideation_goat.sources import depsdev

TOOLS = {"find_libraries", "compare_libraries", "verify_package", "check_dependencies", "find_papers"}


@pytest.mark.anyio
async def test_lists_five_read_only_tools() -> None:
    async with Client(mcp_server.server) as client:
        tools = (await client.list_tools()).tools
    assert {t.name for t in tools} == TOOLS
    for tool in tools:
        assert tool.annotations is not None and tool.annotations.read_only_hint is True
        assert tool.annotations.destructive_hint is False
        assert tool.output_schema is not None, f"{tool.name} has no structured output"
        assert tool.description


@pytest.mark.anyio
async def test_tool_call_returns_structured_result(
    settings: Settings, mock: respx.MockRouter, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(core, "get_settings", lambda: settings)
    mock.get(f"{depsdev.API}/systems/npm/packages/not-real-pkg").respond(404)
    async with Client(mcp_server.server) as client:
        result = await client.call_tool("verify_package", {"name": "not-real-pkg", "ecosystem": "npm"})
    assert not result.is_error
    assert result.structured_content is not None
    assert result.structured_content["exists"] is False


@pytest.mark.anyio
async def test_bad_input_is_a_tool_error(settings: Settings, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(core, "get_settings", lambda: settings)
    async with Client(mcp_server.server) as client:
        result = await client.call_tool("verify_package", {"name": "x", "ecosystem": "maven"})
    assert result.is_error


@pytest.mark.anyio
async def test_stdio_server_keeps_stdout_clean(tmp_path) -> None:  # type: ignore[no-untyped-def]
    """Anything but protocol messages on stdout breaks MCP; a real handshake proves it's clean."""
    env = {**os.environ, "IDEATION_GOAT_HOME": str(tmp_path), "IDEATION_GOAT_CACHE": "false"}
    params = StdioServerParameters(command=sys.executable, args=["-m", "ideation_goat"], env=env)
    async with Client(params) as client:
        tools = (await client.list_tools()).tools
    assert {t.name for t in tools} == TOOLS
