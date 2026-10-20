import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { DISCOVERY_FIELDS, searchArxiv, type ArxivPaper } from '../clients/arxiv.js';
import { countStories, topStories } from '../clients/hackerNews.js';
import { searchPatents } from '../clients/patents.js';
import { searchSemanticScholar, type ScholarPaper } from '../clients/semanticScholar.js';
import { remember, truncate, type SessionState } from '../lib/context.js';
import { errorMessage, ok, safe } from '../lib/result.js';

const READ_ONLY_WEB = { readOnlyHint: true, openWorldHint: true } as const;

const Paper = z.object({
  source: z.string(),
  title: z.string(),
  summary: z.string(),
  authors: z.array(z.string()),
  year: z.number().nullable(),
  url: z.string(),
  pdfUrl: z.string().nullable(),
  citations: z.number().nullable(),
  categories: z.array(z.string()),
});
type PaperOut = z.infer<typeof Paper>;

const SourceError = z.object({ source: z.string(), message: z.string() });

export function fromArxiv(p: ArxivPaper): PaperOut {
  return {
    source: 'arXiv',
    title: p.title,
    summary: truncate(p.summary, 700),
    authors: p.authors.slice(0, 6),
    year: p.published ? Number(p.published.slice(0, 4)) : null,
    url: p.url,
    pdfUrl: p.pdfUrl,
    citations: null,
    categories: p.categories,
  };
}

export function fromScholar(p: ScholarPaper): PaperOut {
  return {
    source: 'Semantic Scholar',
    title: p.title,
    summary: truncate(p.summary, 700),
    authors: p.authors.slice(0, 6),
    year: p.year,
    url: p.url,
    pdfUrl: p.pdfUrl,
    citations: p.citations,
    categories: p.fieldsOfStudy,
  };
}

/** Run labelled source queries in parallel; collect successes and per-source errors. */
export async function gather<T>(jobs: Array<[string, () => Promise<T[]>]>): Promise<{ items: T[]; errors: Array<{ source: string; message: string }> }> {
  const settled = await Promise.allSettled(jobs.map(([, fn]) => fn()));
  const items: T[] = [];
  const errors: Array<{ source: string; message: string }> = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') items.push(...r.value);
    else errors.push({ source: jobs[i]![0], message: errorMessage(r.reason) });
  });
  return { items, errors };
}

export function registerResearchTools(server: McpServer, state: SessionState): void {
  server.registerTool(
    'search_papers',
    {
      title: 'Search academic papers',
      description:
        'Search arXiv and Semantic Scholar in parallel for papers on a topic. Returns titles, abstracts (truncated), authors, year, links and citation counts (Semantic Scholar only). Sources that fail are listed in `errors` rather than failing the call.',
      inputSchema: {
        query: z.string().min(2).describe('Topic or technical concept, e.g. "lock-free LRU cache".'),
        limit: z.number().int().min(1).max(20).default(5).describe('Max results per source.'),
        sources: z.array(z.enum(['arxiv', 'semantic_scholar'])).min(1).default(['arxiv', 'semantic_scholar']),
      },
      outputSchema: { query: z.string(), papers: z.array(Paper), errors: z.array(SourceError) },
      annotations: READ_ONLY_WEB,
    },
    safe(async ({ query, limit, sources }) => {
      const jobs: Array<[string, () => Promise<PaperOut[]>]> = [];
      if (sources.includes('arxiv')) jobs.push(['arXiv', async () => (await searchArxiv(query, limit)).map(fromArxiv)]);
      if (sources.includes('semantic_scholar')) jobs.push(['Semantic Scholar', async () => (await searchSemanticScholar(query, limit)).map(fromScholar)]);
      const { items, errors } = await gather(jobs);
      remember(state, 'search_papers', query, items);
      return ok({ query, papers: items, errors });
    }),
  );

  const fieldNames = Object.keys(DISCOVERY_FIELDS) as [string, ...string[]];
  server.registerTool(
    'find_cross_domain_research',
    {
      title: 'Find analogous research outside computer science',
      description:
        'Search arXiv in non-CS fields (biology, physics, complex systems, economics, mathematics, engineering) for work on the same underlying mechanism as a software problem. ' +
        'Describe the mechanism in domain-neutral words for best results: "decay of rarely used signals to conserve energy" rather than "LRU cache eviction". ' +
        'Papers cross-listed under cs.* are removed. Pair with the `cross_domain_brainstorm` prompt to turn results into ideas.',
      inputSchema: {
        mechanism: z.string().min(3).describe('Domain-neutral description of the mechanism or problem.'),
        fields: z.array(z.enum(fieldNames)).min(1).default(['biology', 'physics', 'complex_systems']),
        limit: z.number().int().min(1).max(20).default(8),
      },
      outputSchema: {
        mechanism: z.string(),
        fields: z.array(z.string()),
        papers: z.array(Paper.extend({ field: z.string() })),
        note: z.string(),
      },
      annotations: READ_ONLY_WEB,
    },
    safe(async ({ mechanism, fields, limit }) => {
      const categories = [...new Set(fields.flatMap((f) => DISCOVERY_FIELDS[f] ?? []))];
      const raw = await searchArxiv(mechanism, Math.min(limit * 2, 40), categories);
      const fieldOf = (cat: string) => fields.find((f) => DISCOVERY_FIELDS[f]?.includes(cat)) ?? 'other';
      const papers = raw
        .filter((p) => !p.categories.some((c) => c.startsWith('cs.')))
        .slice(0, limit)
        .map((p) => ({ ...fromArxiv(p), field: fieldOf(p.primaryCategory) }));
      remember(state, 'find_cross_domain_research', mechanism, papers);
      return ok({
        mechanism,
        fields,
        papers,
        note: papers.length
          ? 'Analogies are for inspiration; check that the mechanism in each paper actually matches before borrowing its model.'
          : 'No non-CS papers matched. Rephrase the mechanism with fewer software-specific terms, or widen `fields`.',
      });
    }),
  );

  server.registerTool(
    'search_patents',
    {
      title: 'Search patents (Google Patents via SerpApi)',
      description:
        'Search Google Patents for prior art related to a design. Requires SERPAPI_API_KEY on the server. Returns real patent records only; an empty list means no matches, not "no risk". Not legal advice.',
      inputSchema: {
        query: z.string().min(3).describe('Key technical claims of the design, in plain words.'),
        limit: z.number().int().min(1).max(20).default(5),
      },
      outputSchema: {
        query: z.string(),
        patents: z.array(
          z.object({
            publicationNumber: z.string(),
            title: z.string(),
            snippet: z.string(),
            assignee: z.string().nullable(),
            priorityDate: z.string().nullable(),
            publicationDate: z.string().nullable(),
            url: z.string(),
          }),
        ),
        disclaimer: z.string(),
      },
      annotations: READ_ONLY_WEB,
    },
    safe(async ({ query, limit }) => {
      const patents = (await searchPatents(query, limit)).map(({ source: _s, ...rest }) => rest);
      remember(state, 'search_patents', query, patents);
      return ok({
        query,
        patents,
        disclaimer: 'Keyword search results only. Patent risk depends on the claims and jurisdiction; consult a patent attorney for freedom-to-operate questions.',
      });
    }),
  );

  server.registerTool(
    'hacker_news_trends',
    {
      title: 'Hacker News mention trends',
      description:
        'Measure how often a technology is discussed on Hacker News (Algolia HN Search API): story counts for the last 30 days vs. the monthly average of the prior 11 months, plus the top stories of the past year. Counts only; no sentiment scoring.',
      inputSchema: {
        query: z.string().min(2).describe('Technology or product name, e.g. "htmx".'),
        top_n: z.number().int().min(0).max(20).default(5),
      },
      outputSchema: {
        query: z.string(),
        storiesLast30d: z.number(),
        monthlyAvgPrior11Months: z.number(),
        storiesLast365d: z.number(),
        trend: z.enum(['rising', 'steady', 'declining', 'insufficient-data']),
        topStories: z.array(z.object({ title: z.string(), url: z.string().nullable(), hnUrl: z.string(), points: z.number(), comments: z.number(), createdAt: z.string() })),
      },
      annotations: READ_ONLY_WEB,
    },
    safe(async ({ query, top_n }) => {
      const now = Math.floor(Date.now() / 1000);
      const day = 86_400;
      const [last30, prior, stories] = await Promise.all([
        countStories(query, now - 30 * day, now),
        countStories(query, now - 365 * day, now - 30 * day),
        top_n ? topStories(query, now - 365 * day, top_n) : Promise.resolve([]),
      ]);
      const avg = Math.round((prior / 11) * 10) / 10;
      return ok({
        query,
        storiesLast30d: last30,
        monthlyAvgPrior11Months: avg,
        storiesLast365d: last30 + prior,
        trend: classifyTrend(last30, avg),
        topStories: stories,
      });
    }),
  );
}

export function classifyTrend(recent: number, baselineMonthly: number): 'rising' | 'steady' | 'declining' | 'insufficient-data' {
  if (recent + baselineMonthly * 11 < 10) return 'insufficient-data';
  if (recent > baselineMonthly * 1.5 && recent - baselineMonthly >= 3) return 'rising';
  if (recent < baselineMonthly * 0.5) return 'declining';
  return 'steady';
}
