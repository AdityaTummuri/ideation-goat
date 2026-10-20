import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { searchArxiv } from '../clients/arxiv.js';
import { countStories } from '../clients/hackerNews.js';
import { searchSemanticScholar } from '../clients/semanticScholar.js';
import { remember, reportProgress, type SessionState } from '../lib/context.js';
import { errorMessage, ok, safe } from '../lib/result.js';
import { classifyTrend, fromArxiv, fromScholar, gather } from './research.js';
import { getRepoHealth, HealthSchema, RepoSummary, searchRepositories } from './repos.js';

export function registerPipelineTools(server: McpServer, state: SessionState): void {
  server.registerTool(
    'evaluate_idea',
    {
      title: 'Evaluate a project idea end-to-end',
      description:
        'One-call landscape check for a project idea: existing open-source projects (GitHub), maintenance health of the top matches, related papers (arXiv + Semantic Scholar), and Hacker News interest. Sends progress notifications. Use the individual tools to dig deeper.',
      inputSchema: {
        idea: z.string().min(5).describe('Short description of what you want to build.'),
        keywords: z.string().optional().describe('Optional search keywords; defaults to the idea text.'),
        repos_to_audit: z.number().int().min(0).max(5).default(2),
      },
      outputSchema: {
        idea: z.string(),
        existingProjects: z.array(RepoSummary),
        audits: z.array(z.object({ repo: z.string(), health: HealthSchema.nullable(), error: z.string().nullable() })),
        papers: z.array(z.object({ source: z.string(), title: z.string(), year: z.number().nullable(), url: z.string(), citations: z.number().nullable() })),
        hackerNews: z.object({ storiesLast30d: z.number(), monthlyAvgPrior11Months: z.number(), trend: z.string() }).nullable(),
        errors: z.array(z.object({ source: z.string(), message: z.string() })),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async ({ idea, keywords, repos_to_audit }, extra) => {
      const q = keywords ?? idea;
      const errors: Array<{ source: string; message: string }> = [];
      await reportProgress(extra, 0, 3, 'Searching repositories, papers, and Hacker News');

      const now = Math.floor(Date.now() / 1000);
      const [repos, papers, hn] = await Promise.all([
        searchRepositories(q, 5, ['github']),
        gather([
          ['arXiv', async () => (await searchArxiv(q, 3)).map(fromArxiv)],
          ['Semantic Scholar', async () => (await searchSemanticScholar(q, 3)).map(fromScholar)],
        ]),
        Promise.all([countStories(q, now - 30 * 86_400, now), countStories(q, now - 365 * 86_400, now - 30 * 86_400)]).then(
          ([recent, prior]) => {
            const avg = Math.round((prior / 11) * 10) / 10;
            return { storiesLast30d: recent, monthlyAvgPrior11Months: avg, trend: classifyTrend(recent, avg) };
          },
          (err) => {
            errors.push({ source: 'Hacker News', message: errorMessage(err) });
            return null;
          },
        ),
      ]);
      errors.push(...repos.errors, ...papers.errors);

      await reportProgress(extra, 1, 3, 'Auditing top repositories');
      const audits = await Promise.all(
        repos.repositories.slice(0, repos_to_audit).map(async (r) => {
          try {
            return { repo: r.fullName, health: (await getRepoHealth(r.fullName)).health, error: null };
          } catch (err) {
            return { repo: r.fullName, health: null, error: errorMessage(err) };
          }
        }),
      );

      await reportProgress(extra, 3, 3, 'Done');
      const result = {
        idea,
        existingProjects: repos.repositories,
        audits,
        papers: papers.items.map((p) => ({ source: p.source, title: p.title, year: p.year, url: p.url, citations: p.citations })),
        hackerNews: hn,
        errors,
      };
      remember(state, 'evaluate_idea', idea, result);
      return ok(result);
    }),
  );
}
