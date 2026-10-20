import { config } from '../config.js';
import { getJson, HttpError } from '../lib/http.js';

const API = 'https://api.github.com';

function headers(): Record<string, string> {
  const h: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (config.githubToken) h.Authorization = `Bearer ${config.githubToken}`;
  return h;
}

export function gh<T>(endpoint: string, params: Record<string, string | number> = {}, cacheTtlMs = 30 * 60 * 1000): Promise<T> {
  const qs = new URLSearchParams(Object.entries(params).map(([k, v]): [string, string] => [k, String(v)]));
  const url = `${API}${endpoint}${qs.size ? `?${qs}` : ''}`;
  return getJson<T>(url, { headers: headers(), cacheTtlMs });
}

/** Accepts `owner/repo`, `https://github.com/owner/repo(.git)`, or `git@github.com:owner/repo.git`. */
export function parseOwnerRepo(input: string): string | null {
  const s = input.trim().replace(/\.git$/, '').replace(/\/+$/, '');
  const m = /github\.com[/:]([\w.-]+)\/([\w.-]+)/.exec(s) ?? /^([\w.-]+)\/([\w.-]+)$/.exec(s);
  if (!m || [m[1], m[2]].some((seg) => seg === '.' || seg === '..')) return null;
  return `${m[1]}/${m[2]}`;
}

export interface GhRepo {
  full_name: string;
  html_url: string;
  description: string | null;
  stargazers_count: number;
  forks_count: number;
  open_issues_count: number;
  language: string | null;
  license: { spdx_id: string | null; name: string } | null;
  archived: boolean;
  fork: boolean;
  pushed_at: string;
  created_at: string;
  default_branch: string;
  size?: number;
  topics?: string[];
}

export const getRepo = (ownerRepo: string) => gh<GhRepo>(`/repos/${ownerRepo}`);

export async function searchRepos(query: string, limit: number): Promise<{ total: number; items: GhRepo[] }> {
  const res = await gh<{ total_count: number; items: GhRepo[] }>('/search/repositories', {
    q: `${query} fork:false`,
    sort: 'stars',
    order: 'desc',
    per_page: limit,
  });
  return { total: res.total_count, items: res.items };
}

export async function countCommitsSince(ownerRepo: string, sinceIso: string): Promise<number> {
  const commits = await gh<unknown[]>(`/repos/${ownerRepo}/commits`, { since: sinceIso, per_page: 100 });
  return commits.length; // capped at 100
}

export const listContributors = (ownerRepo: string) =>
  gh<Array<{ login?: string; contributions: number }>>(`/repos/${ownerRepo}/contributors`, { per_page: 100 });

export const listRecentPulls = (ownerRepo: string) =>
  gh<Array<{ state: string; merged_at: string | null; updated_at: string }>>(`/repos/${ownerRepo}/pulls`, {
    state: 'all',
    sort: 'updated',
    direction: 'desc',
    per_page: 100,
  });

export const listIssues = (ownerRepo: string, params: Record<string, string | number>) =>
  gh<Array<{ title: string; html_url: string; state: string; pull_request?: unknown; labels?: Array<{ name?: string }> }>>(
    `/repos/${ownerRepo}/issues`,
    params,
  );

export const latestCommitSha = async (ownerRepo: string): Promise<string | null> => {
  const commits = await gh<Array<{ sha: string }>>(`/repos/${ownerRepo}/commits`, { per_page: 1 });
  return commits[0]?.sha ?? null;
};

/** Fetch a text file from the repo's default branch; null if it does not exist. */
export async function getFile(ownerRepo: string, filePath: string): Promise<string | null> {
  try {
    const encoded = filePath.split('/').map(encodeURIComponent).join('/');
    const data = await gh<{ content?: string; encoding?: string }>(`/repos/${ownerRepo}/contents/${encoded}`);
    if (!data.content) return null;
    return Buffer.from(data.content, 'base64').toString('utf8');
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) return null;
    throw err;
  }
}

export async function listRootFiles(ownerRepo: string): Promise<string[]> {
  const items = await gh<Array<{ name: string; type: string }>>(`/repos/${ownerRepo}/contents`);
  return items.map((i) => i.name);
}
