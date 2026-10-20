import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { vi } from 'vitest';

export function tmpDir(prefix = 'igoat-'): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

export function writeTree(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
}

type Route = [RegExp, (url: string, init?: RequestInit) => unknown];

/** Stub global fetch with URL-pattern routes. Unmatched URLs fail loudly. */
export function mockFetch(routes: Route[]) {
  const calls: string[] = [];
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    for (const [re, handler] of routes) {
      if (re.test(url)) {
        const body = handler(url, init);
        if (body instanceof Response) return body;
        return typeof body === 'string'
          ? new Response(body, { status: 200, headers: { 'content-type': 'application/atom+xml' } })
          : new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      }
    }
    return new Response(`no mock for ${url}`, { status: 404 });
  });
  vi.stubGlobal('fetch', fn);
  return { fn, calls };
}

export const ARXIV_XML = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
  <entry>
    <id>http://arxiv.org/abs/2101.00001v1</id>
    <published>2021-01-01T00:00:00Z</published>
    <title>Synaptic   pruning &amp; energy-efficient
      signalling</title>
    <summary>We model decay of rarely used synapses &lt;as&gt; an energy optimisation.</summary>
    <author><name>Ada Lovelace</name></author>
    <author><name>Alan Turing</name></author>
    <link href="http://arxiv.org/abs/2101.00001v1" rel="alternate" type="text/html"/>
    <link title="pdf" href="http://arxiv.org/pdf/2101.00001v1" rel="related" type="application/pdf"/>
    <arxiv:primary_category xmlns:arxiv="http://arxiv.org/schemas/atom" term="q-bio.NC" scheme="http://arxiv.org/schemas/atom"/>
    <category term="q-bio.NC" scheme="http://arxiv.org/schemas/atom"/>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/2202.00002v2</id>
    <published>2022-02-02T00:00:00Z</published>
    <title>A cache paper</title>
    <summary>LRU things.</summary>
    <author><name>Grace Hopper</name></author>
    <arxiv:primary_category xmlns:arxiv="http://arxiv.org/schemas/atom" term="q-bio.QM" scheme="http://arxiv.org/schemas/atom"/>
    <category term="q-bio.QM" scheme="http://arxiv.org/schemas/atom"/>
    <category term="cs.DS" scheme="http://arxiv.org/schemas/atom"/>
  </entry>
</feed>`;
