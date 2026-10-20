#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { config } from './config.js';
import { startHttp } from './http.js';
import { log } from './lib/logger.js';
import { createServer, VERSION } from './server.js';

const { values } = parseArgs({
  options: {
    http: { type: 'boolean', default: false },
    port: { type: 'string', default: process.env.PORT ?? '3333' },
    host: { type: 'string', default: process.env.HOST ?? '127.0.0.1' },
    help: { type: 'boolean', short: 'h', default: false },
    version: { type: 'boolean', short: 'v', default: false },
  },
});

if (values.help) {
  process.stderr.write(`ideation-goat ${VERSION}

Usage:
  ideation-goat                 Run over stdio (for Claude Desktop, Cursor, VS Code, ...)
  ideation-goat --http          Run Streamable HTTP on http://127.0.0.1:3333/mcp
    --port <n>                  Port (default 3333, or $PORT)
    --host <addr>               Bind address (default 127.0.0.1, or $HOST)
                                Non-loopback addresses require MCP_AUTH_TOKEN (Bearer auth)

Environment: WORKSPACE_ROOT, MCP_AUTH_TOKEN, GITHUB_TOKEN, GITLAB_TOKEN, SERPAPI_API_KEY,
             SEMANTIC_SCHOLAR_API_KEY, UNPAYWALL_EMAIL, LOG_LEVEL
`);
  process.exit(0);
}
if (values.version) {
  process.stderr.write(`${VERSION}\n`);
  process.exit(0);
}

async function main(): Promise<void> {
  if (values.http) {
    const port = Number(values.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid port: ${values.port}`);
    const server = await startHttp({ host: values.host!, port, authToken: process.env.MCP_AUTH_TOKEN?.trim() || undefined });
    const shutdown = () => server.close(() => process.exit(0));
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    return;
  }
  const server = createServer();
  await server.connect(new StdioServerTransport());
  log.info(`ideation-goat ${VERSION} ready on stdio`, { workspaceRoot: config.workspaceRoot });
}

main().catch((err) => {
  log.error('fatal', { error: err instanceof Error ? err.stack ?? err.message : String(err) });
  process.exit(1);
});
