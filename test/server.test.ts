import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearHttpCache } from '../src/lib/http.js';
import { createServer } from '../src/server.js';
import { ARXIV_XML, mockFetch, tmpDir, writeTree } from './helpers.js';

type ToolResult = { isError?: boolean; structuredContent?: Record<string, any>; content: Array<{ type: string; text?: string }> };

async function connect() {
  const server = createServer();
  const client = new Client({ name: 'test', version: '0.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  await client.listTools(); // primes output-schema validation in the client
  return { client, server };
}

const call = async (client: Client, name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as ToolResult;

let root: string;
beforeEach(() => {
  clearHttpCache();
  root = tmpDir();
  vi.stubEnv('WORKSPACE_ROOT', root);
  vi.stubEnv('SERPAPI_API_KEY', '');
  vi.stubEnv('GOOGLE_PATENTS_API_KEY', '');
  vi.stubEnv('UNPAYWALL_EMAIL', '');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('MCP surface', () => {
  it('exposes tools with schemas and annotations, prompts, and resources', async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        'dependency_injection_report', 'estimate_edge_footprint', 'estimate_hosting_cost', 'evaluate_idea', 'find_cross_domain_research',
        'hacker_news_trends', 'repo_bug_patterns', 'repo_cloud_lockin', 'repo_health', 'repo_workspace_fit', 'scaffold_project',
        'scan_dependency_vulnerabilities', 'search_papers', 'search_patents', 'search_repositories', 'workspace_profile',
      ].sort(),
    );
    for (const t of tools) {
      expect(t.outputSchema, t.name).toBeDefined();
      expect(t.annotations?.readOnlyHint, t.name).toBe(t.name !== 'scaffold_project');
      expect(t.description!.length, t.name).toBeGreaterThan(60);
    }
    expect((await client.listPrompts()).prompts.map((p) => p.name).sort()).toEqual(['breed_concepts', 'code_to_theory', 'cross_domain_brainstorm']);
    expect((await client.listResources()).resources.map((r) => r.uri).sort()).toEqual(['ideation-goat://session/last-search', 'ideation-goat://status']);
  });

  it('renders prompts with arguments', async () => {
    const { client } = await connect();
    const p = await client.getPrompt({ name: 'breed_concepts', arguments: { concept_a: 'distributed cache', concept_b: 'synaptic pruning' } });
    expect((p.messages[0]!.content as { text: string }).text).toContain('synaptic pruning');
  });

  it('status resource never leaks secrets', async () => {
    vi.stubEnv('GITHUB_TOKEN', 'ghp_supersecret');
    const { client } = await connect();
    const r = await client.readResource({ uri: 'ideation-goat://status' });
    const text = (r.contents[0] as { text: string }).text;
    expect(text).not.toContain('supersecret');
    expect(JSON.parse(text).integrations.github).toMatch(/token/);
  });
});

describe('research tools', () => {
  it('search_papers merges sources, reports per-source failures, and updates the session resource', async () => {
    mockFetch([
      [/export\.arxiv\.org/, () => ARXIV_XML],
      [/semanticscholar/, () => new Response('rate limited', { status: 400 })],
    ]);
    const { client } = await connect();
    const res = await call(client, 'search_papers', { query: 'synaptic pruning', limit: 2 });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent!.papers).toHaveLength(2);
    expect(res.structuredContent!.errors).toEqual([{ source: 'Semantic Scholar', message: expect.stringContaining('HTTP 400') }]);

    const last = await client.readResource({ uri: 'ideation-goat://session/last-search' });
    expect(JSON.parse((last.contents[0] as { text: string }).text)).toMatchObject({ tool: 'search_papers', query: 'synaptic pruning' });
  });

  it('find_cross_domain_research filters to non-CS categories', async () => {
    const { calls } = mockFetch([[/export\.arxiv\.org/, () => ARXIV_XML]]);
    const { client } = await connect();
    const res = await call(client, 'find_cross_domain_research', { mechanism: 'decay of rarely used signals', fields: ['biology'] });
    expect(res.structuredContent!.papers.map((p: { title: string }) => p.title)).toEqual(['Synaptic pruning & energy-efficient signalling']);
    expect(res.structuredContent!.papers[0].field).toBe('biology');
    expect(decodeURIComponent(calls[0]!)).toContain('cat:q-bio.NC');
  });

  it('search_patents refuses to fabricate when no key is configured', async () => {
    const { fn } = mockFetch([]);
    const { client } = await connect();
    const res = await call(client, 'search_patents', { query: 'lock-free eviction buffer' });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/SERPAPI_API_KEY/);
    expect(fn).not.toHaveBeenCalled();
  });

  it('hacker_news_trends uses real counts', async () => {
    mockFetch([
      [/hn\.algolia\.com.*hitsPerPage=0/, () => ({ nbHits: 0, hits: [] })],
      [/hn\.algolia\.com/, () => ({ nbHits: 1, hits: [{ objectID: '1', title: 'Show HN: htmx', url: 'https://htmx.org', points: 500, num_comments: 200, created_at: '2026-01-01T00:00:00Z' }] })],
    ]);
    const { client } = await connect();
    const res = await call(client, 'hacker_news_trends', { query: 'htmx', top_n: 1 });
    expect(res.structuredContent).toMatchObject({ trend: 'insufficient-data', topStories: [{ title: 'Show HN: htmx', hnUrl: 'https://news.ycombinator.com/item?id=1' }] });
  });
});

describe('repository tools', () => {
  const now = new Date().toISOString();
  const repo = { full_name: 'acme/widget', html_url: 'https://github.com/acme/widget', description: 'w', stargazers_count: 1000, forks_count: 10, open_issues_count: 5, language: 'TypeScript', license: { spdx_id: 'GPL-3.0', name: 'GPL' }, archived: false, fork: false, pushed_at: now, created_at: now, default_branch: 'main', size: 100 };

  it('repo_health returns a scored breakdown', async () => {
    mockFetch([
      [/\/repos\/acme\/widget\/commits\?since/, () => Array.from({ length: 12 }, () => ({}))],
      [/\/repos\/acme\/widget\/commits\?per_page=1/, () => [{ sha: 'abc' }]],
      [/\/repos\/acme\/widget\/contributors/, () => [{ contributions: 50 }, { contributions: 30 }, { contributions: 20 }]],
      [/\/repos\/acme\/widget\/pulls/, () => [{ state: 'closed', merged_at: now, updated_at: now }]],
      [/\/repos\/acme\/widget$/, () => repo],
      [/api\.osv\.dev\/v1\/query/, () => ({})],
    ]);
    const { client } = await connect();
    const res = await call(client, 'repo_health', { repo: 'https://github.com/acme/widget' });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent!.health.breakdown.map((b: { factor: string }) => b.factor)).toEqual(['recency', 'commit_activity', 'bus_factor', 'pr_throughput', 'issue_load']);
    expect(res.structuredContent!.health.score).toBe(30 + 20 + 8 + 5 + 10);
  });

  it('repo_workspace_fit flags GPL into an MIT project', async () => {
    writeTree(root, { 'package.json': JSON.stringify({ license: 'MIT' }), 'index.ts': '' });
    mockFetch([[/\/repos\/acme\/widget$/, () => repo]]);
    const { client } = await connect();
    const res = await call(client, 'repo_workspace_fit', { repo: 'acme/widget' });
    expect(res.structuredContent).toMatchObject({ overall: 'poor-fit', license: { verdict: 'conflict' }, language: { match: true } });
  });

  it('turns GitHub rate limiting into an actionable error', async () => {
    mockFetch([[/api\.github\.com/, () => new Response('{}', { status: 403 })]]);
    const { client } = await connect();
    const res = await call(client, 'repo_health', { repo: 'acme/widget' });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/set an API token/);
  });
});

describe('evaluate_idea', () => {
  it('combines sources, audits top repos, reports failures, and emits progress', async () => {
    const now = new Date().toISOString();
    mockFetch([
      [/search\/repositories/, () => ({ total_count: 1, items: [{ full_name: 'acme/widget', html_url: 'https://github.com/acme/widget', description: null, stargazers_count: 5, forks_count: 0, open_issues_count: 0, language: 'Go', license: null, archived: false, fork: false, pushed_at: now, created_at: now, default_branch: 'main' }] })],
      [/\/repos\/acme\/widget$/, () => new Response('{}', { status: 404 })],
      [/export\.arxiv\.org/, () => ARXIV_XML],
      [/semanticscholar/, () => ({ data: [{ paperId: 'p1', title: 'S2 paper', year: 2020, citationCount: 7 }] })],
      [/hn\.algolia\.com/, () => new Response('down', { status: 400 })],
    ]);
    const { client } = await connect();
    const progress: string[] = [];
    const res = (await client.callTool({ name: 'evaluate_idea', arguments: { idea: 'widget registry for Go' } }, undefined, {
      onprogress: (p) => progress.push(p.message ?? ''),
    })) as ToolResult;
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toMatchObject({
      existingProjects: [{ fullName: 'acme/widget' }],
      audits: [{ repo: 'acme/widget', health: null, error: expect.stringContaining('404') }],
      hackerNews: null,
      errors: [{ source: 'Hacker News' }],
    });
    expect(res.structuredContent!.papers).toHaveLength(3);
    expect(progress.at(-1)).toBe('Done');
  });
});

describe('local tools', () => {
  it('scan_dependency_vulnerabilities scans pinned versions only and applies the gate', async () => {
    writeTree(root, {
      'package.json': JSON.stringify({ dependencies: { lodash: '^4.17.0', leftpad: '^1.0.0' } }),
      'package-lock.json': JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/lodash': { version: '4.17.20' } } }),
    });
    mockFetch([
      [/querybatch/, (_u, init) => {
        const body = JSON.parse(String(init!.body));
        expect(body.queries).toEqual([{ package: { name: 'lodash', ecosystem: 'npm' }, version: '4.17.20' }]);
        return { results: [{ vulns: [{ id: 'GHSA-35jh-r3h4-6jhm' }] }] };
      }],
      [/\/v1\/vulns\/GHSA-35jh-r3h4-6jhm/, () => ({
        id: 'GHSA-35jh-r3h4-6jhm',
        summary: 'Command Injection in lodash',
        aliases: ['CVE-2021-23337'],
        severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:H/UI:N/S:U/C:H/I:H/A:H' }],
        affected: [{ package: { name: 'lodash', ecosystem: 'npm' }, ranges: [{ events: [{ introduced: '0' }, { fixed: '4.17.21' }] }] }],
      })],
    ]);
    const { client } = await connect();
    const res = await call(client, 'scan_dependency_vulnerabilities', { fail_on: 'high' });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toMatchObject({
      scanned: 1,
      unpinned: ['leftpad (^1.0.0, package.json)'],
      findings: [{ package: 'lodash', severity: 'HIGH', cvssScore: 7.2, fixedIn: '4.17.21' }],
      gate: { passed: false },
    });
  });

  it('local tools refuse paths outside WORKSPACE_ROOT', async () => {
    const { client } = await connect();
    for (const [tool, args] of [
      ['workspace_profile', { path: '../' }],
      ['scan_dependency_vulnerabilities', { path: '/etc' }],
      ['dependency_injection_report', { path: '../../' }],
      ['scaffold_project', { directory: '../outside', project_name: 'x', stack: 'node', blueprint_markdown: '# x' }],
    ] as const) {
      const res = await call(client, tool, args);
      expect(res.isError, tool).toBe(true);
      expect(res.content[0]!.text, tool).toMatch(/outside the workspace root/);
    }
  });

  it('scaffold_project writes inside the root', async () => {
    const { client } = await connect();
    const res = await call(client, 'scaffold_project', { directory: 'apps/demo', project_name: 'Demo', stack: 'python', blueprint_markdown: '# Demo plan' });
    expect(res.isError).toBeFalsy();
    expect(fs.existsSync(path.join(root, 'apps/demo/main.py'))).toBe(true);
    const again = await call(client, 'scaffold_project', { directory: 'apps/demo', project_name: 'Demo', stack: 'python', blueprint_markdown: '# Demo plan' });
    expect(again.isError).toBe(true);
  });

  it('rejects invalid arguments via the input schema', async () => {
    const { client } = await connect();
    const res = await call(client, 'estimate_hosting_cost', { provider: 'heroku', monthly_requests: 10 });
    expect(res.isError).toBe(true);
  });
});

describe.runIf(fs.existsSync(path.join(__dirname, '../dist/index.js')))('stdio binary', () => {
  it('speaks clean JSON-RPC on stdout (nothing else written there)', async () => {
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
    const client = new Client({ name: 'stdio-test', version: '0.0.0' });
    const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(__dirname, '../dist/index.js')], env: { ...process.env, WORKSPACE_ROOT: root } as Record<string, string>, stderr: 'pipe' });
    await client.connect(transport);
    expect((await client.listTools()).tools).toHaveLength(16);
    const res = (await client.callTool({ name: 'workspace_profile', arguments: {} })) as ToolResult;
    expect(res.isError).toBeFalsy();
    await client.close();
  });
});

describe('Streamable HTTP transport', () => {
  it('serves sessions over /mcp and health on /healthz', async () => {
    const { startHttp } = await import('../src/http.js');
    const port = 40000 + Math.floor(Math.random() * 20000);
    const httpServer = await startHttp({ host: '127.0.0.1', port });
    try {
      const health = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json();
      expect(health).toMatchObject({ status: 'ok' });

      const client = new Client({ name: 'http-test', version: '0.0.0' });
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
      expect((await client.listTools()).tools.length).toBe(16);
      const cost = (await client.callTool({ name: 'estimate_hosting_cost', arguments: { provider: 'vercel', monthly_requests: 1000 } })) as ToolResult;
      expect(cost.structuredContent!.totalUsd).toBe(0);
      await client.close();

      const bad = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
      expect(bad.status).toBe(400);

      const stale = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-session-id': 'nope' }, body: '{}' });
      expect(stale.status).toBe(404);
      const garbage = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json' });
      expect(garbage.status).toBe(400);
      expect(((await garbage.json()) as any).error.code).toBe(-32700);
    } finally {
      await new Promise((r) => httpServer.close(r));
    }
  });

  it('refuses non-loopback binds without a token and enforces bearer auth', async () => {
    const { startHttp } = await import('../src/http.js');
    await expect(startHttp({ host: '0.0.0.0', port: 1 })).rejects.toThrow(/MCP_AUTH_TOKEN/);

    const port = 40000 + Math.floor(Math.random() * 20000);
    const httpServer = await startHttp({ host: '127.0.0.1', port, authToken: 's3cret' });
    try {
      const url = new URL(`http://127.0.0.1:${port}/mcp`);
      const anon = new Client({ name: 'anon', version: '0' });
      await expect(anon.connect(new StreamableHTTPClientTransport(url))).rejects.toThrow();

      const authed = new Client({ name: 'authed', version: '0' });
      await authed.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: 'Bearer s3cret' } } }));
      expect((await authed.listPrompts()).prompts).toHaveLength(3);
      await authed.close();
    } finally {
      await new Promise((r) => httpServer.close(r));
    }
  });

  it('closes idle sessions', async () => {
    const { startHttp } = await import('../src/http.js');
    const port = 40000 + Math.floor(Math.random() * 20000);
    const httpServer = await startHttp({ host: '127.0.0.1', port, sessionIdleMs: 200 });
    try {
      const client = new Client({ name: 'idle', version: '0' });
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
      expect(((await (await fetch(`http://127.0.0.1:${port}/healthz`)).json()) as any).sessions).toBe(1);
      await new Promise((r) => setTimeout(r, 600));
      expect(((await (await fetch(`http://127.0.0.1:${port}/healthz`)).json()) as any).sessions).toBe(0);
    } finally {
      await new Promise((r) => httpServer.close(r));
    }
  });
});
