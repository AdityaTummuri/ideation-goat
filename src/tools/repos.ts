import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as github from '../clients/github.js';
import { searchGitlabProjects } from '../clients/gitlab.js';
import { clusterIssueTitles } from '../analysis/bugs.js';
import { estimateFootprint } from '../analysis/footprint.js';
import { scoreHealth, type HealthScore } from '../analysis/health.js';
import { gradeLockin } from '../analysis/lockin.js';
import { parseGoMod, parsePackageJson, parsePyproject, parseRequirements } from '../analysis/manifests.js';
import { remember, type SessionState } from '../lib/context.js';
import { getJson } from '../lib/http.js';
import { fail, ok, safe } from '../lib/result.js';
import { gather } from './research.js';

const READ_ONLY_WEB = { readOnlyHint: true, openWorldHint: true } as const;
const repoArg = z.string().min(3).describe('GitHub repository as owner/name or URL, e.g. "facebook/react".');

export const RepoSummary = z.object({
  platform: z.enum(['GitHub', 'GitLab']),
  fullName: z.string(),
  url: z.string(),
  description: z.string().nullable(),
  stars: z.number(),
  language: z.string().nullable(),
  license: z.string().nullable(),
  lastActivity: z.string(),
  archived: z.boolean().nullable(),
});
type RepoSummaryT = z.infer<typeof RepoSummary>;

export const HealthSchema = z.object({
  score: z.number(),
  rating: z.enum(['healthy', 'caution', 'high-risk']),
  breakdown: z.array(z.object({ factor: z.string(), points: z.number().nullable(), max: z.number(), detail: z.string() })),
  flags: z.array(z.string()),
});

export async function searchRepositories(query: string, limit: number, platforms: Array<'github' | 'gitlab'>) {
  const jobs: Array<[string, () => Promise<RepoSummaryT[]>]> = [];
  if (platforms.includes('github')) {
    jobs.push([
      'GitHub',
      async () =>
        (await github.searchRepos(query, limit)).items.map((r) => ({
          platform: 'GitHub' as const,
          fullName: r.full_name,
          url: r.html_url,
          description: r.description,
          stars: r.stargazers_count,
          language: r.language,
          license: r.license?.spdx_id ?? null,
          lastActivity: r.pushed_at,
          archived: r.archived,
        })),
    ]);
  }
  if (platforms.includes('gitlab')) {
    jobs.push([
      'GitLab',
      async () =>
        (await searchGitlabProjects(query, limit)).map((p) => ({
          platform: 'GitLab' as const,
          fullName: p.fullName,
          url: p.url,
          description: p.description,
          stars: p.stars,
          language: null,
          license: null,
          lastActivity: p.lastActivity,
          archived: null,
        })),
    ]);
  }
  const { items, errors } = await gather(jobs);
  items.sort((a, b) => b.stars - a.stars);
  return { repositories: items, errors };
}

export interface RepoHealthReport {
  repo: string;
  url: string;
  description: string | null;
  stars: number;
  forks: number;
  language: string | null;
  license: string | null;
  archived: boolean;
  lastPush: string;
  health: HealthScore;
  osvVulnsAtHead: string[];
}

export async function getRepoHealth(ownerRepo: string): Promise<RepoHealthReport> {
  const repo = await github.getRepo(ownerRepo);
  const since = new Date(Date.now() - 30 * 86_400_000);
  const [commits, contributors, pulls, sha] = await Promise.all([
    github.countCommitsSince(ownerRepo, since.toISOString()).catch(() => null),
    github.listContributors(ownerRepo).catch(() => null),
    github.listRecentPulls(ownerRepo).catch(() => null),
    github.latestCommitSha(ownerRepo).catch(() => null),
  ]);

  const totalContrib = contributors?.reduce((s, c) => s + c.contributions, 0) ?? 0;
  const top = contributors?.[0]?.contributions ?? 0;
  const mergedRecently = pulls ? pulls.filter((p) => p.merged_at && new Date(p.merged_at) >= since).length : null;

  let osvVulnsAtHead: string[] = [];
  if (sha) {
    try {
      const res = await getJson<{ vulns?: Array<{ id: string }> }>('https://api.osv.dev/v1/query', { method: 'POST', body: { commit: sha }, cacheTtlMs: 3_600_000 });
      osvVulnsAtHead = (res.vulns ?? []).map((v) => v.id);
    } catch {
      /* OSV lookup is supplementary */
    }
  }

  return {
    repo: repo.full_name,
    url: repo.html_url,
    description: repo.description,
    stars: repo.stargazers_count,
    forks: repo.forks_count,
    language: repo.language,
    license: repo.license?.spdx_id ?? null,
    archived: repo.archived,
    lastPush: repo.pushed_at,
    health: scoreHealth({
      archived: repo.archived,
      daysSinceLastPush: Math.floor((Date.now() - new Date(repo.pushed_at).getTime()) / 86_400_000),
      commitsLast30d: commits,
      contributors: contributors ? contributors.length : null,
      topContributorShare: totalContrib ? top / totalContrib : null,
      mergedPrsLast30d: mergedRecently,
      openIssues: repo.open_issues_count,
      stars: repo.stargazers_count,
    }),
    osvVulnsAtHead,
  };
}

function requireRepo(input: string): string {
  const r = github.parseOwnerRepo(input);
  if (!r) throw new Error(`'${input}' is not a GitHub repository (expected owner/name or a github.com URL).`);
  return r;
}

export function registerRepoTools(server: McpServer, state: SessionState): void {
  server.registerTool(
    'search_repositories',
    {
      title: 'Search open-source repositories',
      description: 'Search GitHub and GitLab for repositories matching a query, sorted by stars. Set GITHUB_TOKEN to avoid the unauthenticated search limit (10 requests/minute).',
      inputSchema: {
        query: z.string().min(2).describe('Keywords, e.g. "vector database rust". GitHub qualifiers like language:go work for GitHub.'),
        limit: z.number().int().min(1).max(30).default(5).describe('Max results per platform.'),
        platforms: z.array(z.enum(['github', 'gitlab'])).min(1).default(['github', 'gitlab']),
      },
      outputSchema: { query: z.string(), repositories: z.array(RepoSummary), errors: z.array(z.object({ source: z.string(), message: z.string() })) },
      annotations: READ_ONLY_WEB,
    },
    safe(async ({ query, limit, platforms }) => {
      const res = await searchRepositories(query, limit, platforms);
      remember(state, 'search_repositories', query, res.repositories);
      return ok({ query, ...res });
    }),
  );

  server.registerTool(
    'repo_health',
    {
      title: 'Repository maintenance health',
      description:
        'Score a GitHub repository 0-100 on maintenance signals: push recency, commits in the last 30 days, contributor count and concentration, merged PRs, and open-issue load. Every factor is returned in `health.breakdown`. Also lists OSV advisories that affect the latest commit.',
      inputSchema: { repo: repoArg },
      outputSchema: {
        repo: z.string(),
        url: z.string(),
        description: z.string().nullable(),
        stars: z.number(),
        forks: z.number(),
        language: z.string().nullable(),
        license: z.string().nullable(),
        archived: z.boolean(),
        lastPush: z.string(),
        health: HealthSchema,
        osvVulnsAtHead: z.array(z.string()),
      },
      annotations: READ_ONLY_WEB,
    },
    safe(async ({ repo }) => ok({ ...(await getRepoHealth(requireRepo(repo))) })),
  );

  server.registerTool(
    'repo_bug_patterns',
    {
      title: 'Recurring bug themes',
      description:
        'Fetch recent issues labelled "bug" (falling back to open issues) and group their titles by shared keywords to surface recurring problem areas. Keyword clustering, not semantic analysis.',
      inputSchema: { repo: repoArg, sample_size: z.number().int().min(10).max(100).default(100) },
      outputSchema: {
        repo: z.string(),
        issuesAnalyzed: z.number(),
        source: z.enum(['bug-label', 'open-issues', 'mixed']),
        clusters: z.array(
          z.object({
            label: z.string(),
            keywords: z.array(z.string()),
            count: z.number(),
            percentage: z.number(),
            severe: z.boolean(),
            examples: z.array(z.object({ title: z.string(), url: z.string() })),
          }),
        ),
      },
      annotations: READ_ONLY_WEB,
    },
    safe(async ({ repo, sample_size }) => {
      const ownerRepo = requireRepo(repo);
      const isIssue = (i: { pull_request?: unknown }) => !i.pull_request;
      const bugLabelled = (await github.listIssues(ownerRepo, { state: 'all', labels: 'bug', per_page: sample_size })).filter(isIssue);
      let issues = bugLabelled;
      let source: 'bug-label' | 'open-issues' | 'mixed' = 'bug-label';
      if (bugLabelled.length < 20) {
        const open = (await github.listIssues(ownerRepo, { state: 'open', per_page: sample_size })).filter(isIssue);
        const seen = new Set(bugLabelled.map((i) => i.html_url));
        issues = [...bugLabelled, ...open.filter((i) => !seen.has(i.html_url))].slice(0, sample_size);
        source = bugLabelled.length ? 'mixed' : 'open-issues';
      }
      const clusters = clusterIssueTitles(issues.map((i) => ({ title: i.title, url: i.html_url })));
      return ok({ repo: ownerRepo, issuesAnalyzed: issues.length, source, clusters });
    }),
  );

  server.registerTool(
    'repo_cloud_lockin',
    {
      title: 'Cloud vendor lock-in check',
      description:
        'Read a GitHub repository\'s root manifests (package.json, requirements.txt, pyproject.toml, go.mod) and flag direct dependencies on proprietary cloud SDKs (AWS, GCP/Firebase, Azure, Vercel, Cloudflare, Supabase, ...). Grades A (none) to D (heavy). Transitive dependencies and monorepo sub-packages are not inspected.',
      inputSchema: { repo: repoArg },
      outputSchema: {
        repo: z.string(),
        manifestsFound: z.array(z.string()),
        grade: z.enum(['A', 'B', 'C', 'D']),
        vendors: z.array(z.string()),
        lockedDependencies: z.array(z.object({ package: z.string(), vendor: z.string() })),
        dependenciesChecked: z.number(),
        summary: z.string(),
      },
      annotations: READ_ONLY_WEB,
    },
    safe(async ({ repo }) => {
      const ownerRepo = requireRepo(repo);
      const parsers: Record<string, (t: string) => Array<{ name: string }>> = {
        'package.json': parsePackageJson,
        'requirements.txt': parseRequirements,
        'pyproject.toml': parsePyproject,
        'go.mod': parseGoMod,
      };
      const found: string[] = [];
      const names: string[] = [];
      await Promise.all(
        Object.entries(parsers).map(async ([file, parse]) => {
          const text = await github.getFile(ownerRepo, file);
          if (text === null) return;
          found.push(file);
          names.push(...parse(text).map((d) => d.name));
        }),
      );
      if (!found.length) return fail(`No supported manifest found at the root of ${ownerRepo}.`);
      return ok({ repo: ownerRepo, manifestsFound: found.sort(), ...gradeLockin(names) });
    }),
  );

  server.registerTool(
    'estimate_edge_footprint',
    {
      title: 'Estimate microcontroller fit (heuristic)',
      description:
        'Rough guess at whether a GitHub repository could run on a microcontroller with the given RAM/flash, based on its language, embedded markers (no_std, PlatformIO, STL use) and size. LOW CONFIDENCE: nothing is compiled. Use it to rule things out early, then measure with a real build.',
      inputSchema: {
        repo: repoArg,
        sram_kb: z.number().positive().describe('Board RAM in KB, e.g. 520 for ESP32, 264 for RP2040.'),
        flash_kb: z.number().positive().describe('Board flash in KB.'),
        board: z.string().optional().describe('Board name, for the report only.'),
      },
      outputSchema: {
        repo: z.string(),
        board: z.string().nullable(),
        ecosystem: z.string(),
        estimatedSramKb: z.object({ low: z.number(), high: z.number() }),
        estimatedFlashKb: z.object({ low: z.number(), high: z.number() }),
        fit: z.enum(['likely', 'uncertain', 'unlikely']),
        findings: z.array(z.string()),
        confidence: z.literal('low'),
        method: z.string(),
      },
      annotations: READ_ONLY_WEB,
    },
    safe(async ({ repo, sram_kb, flash_kb, board }) => {
      const ownerRepo = requireRepo(repo);
      const [meta, rootFiles] = await Promise.all([github.getRepo(ownerRepo), github.listRootFiles(ownerRepo)]);
      const lower = rootFiles.map((f) => f.toLowerCase());
      const cargoToml = lower.includes('cargo.toml') ? await github.getFile(ownerRepo, 'Cargo.toml') : null;
      const header = rootFiles.find((f) => /\.(h|hpp)$/i.test(f));
      const sampleHeader = header ? await github.getFile(ownerRepo, header) : null;
      const est = estimateFootprint({ rootFiles, cargoToml, sampleHeader, repoSizeKb: meta.size ?? 0 });
      const fit =
        est.sramKb.high <= sram_kb && est.flashKb.high <= flash_kb ? 'likely' : est.sramKb.low > sram_kb || est.flashKb.low > flash_kb ? 'unlikely' : 'uncertain';
      return ok({
        repo: ownerRepo,
        board: board ?? null,
        ecosystem: est.ecosystem,
        estimatedSramKb: est.sramKb,
        estimatedFlashKb: est.flashKb,
        fit,
        findings: est.findings,
        confidence: est.confidence,
        method: est.method,
      });
    }),
  );
}
