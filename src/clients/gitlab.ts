import { config } from '../config.js';
import { getJson } from '../lib/http.js';

export interface GitlabProject {
  source: 'GitLab';
  fullName: string;
  url: string;
  description: string | null;
  stars: number;
  forks: number;
  lastActivity: string;
  topics: string[];
}

interface RawProject {
  path_with_namespace: string;
  web_url: string;
  description: string | null;
  star_count: number;
  forks_count: number;
  last_activity_at: string;
  topics?: string[];
}

export async function searchGitlabProjects(query: string, limit: number): Promise<GitlabProject[]> {
  const params = new URLSearchParams({
    search: query,
    order_by: 'star_count',
    sort: 'desc',
    per_page: String(limit),
    simple: 'true',
  });
  const headers: Record<string, string> = {};
  if (config.gitlabToken) headers['PRIVATE-TOKEN'] = config.gitlabToken;
  const raw = await getJson<RawProject[]>(`${config.gitlabBaseUrl}/projects?${params}`, { headers, cacheTtlMs: 30 * 60 * 1000 });
  return raw.map((p) => ({
    source: 'GitLab',
    fullName: p.path_with_namespace,
    url: p.web_url,
    description: p.description,
    stars: p.star_count,
    forks: p.forks_count,
    lastActivity: p.last_activity_at,
    topics: p.topics ?? [],
  }));
}
