import { getJson } from '../lib/http.js';

const API = 'https://hn.algolia.com/api/v1';

interface AlgoliaResponse {
  nbHits: number;
  hits: Array<{
    objectID: string;
    title?: string | null;
    url?: string | null;
    points?: number | null;
    num_comments?: number | null;
    created_at: string;
  }>;
}

export interface HnStory {
  title: string;
  url: string | null;
  hnUrl: string;
  points: number;
  comments: number;
  createdAt: string;
}

/** Count stories matching `query` created within [fromSec, toSec). */
export async function countStories(query: string, fromSec: number, toSec: number): Promise<number> {
  const params = new URLSearchParams({
    query,
    tags: 'story',
    numericFilters: `created_at_i>=${fromSec},created_at_i<${toSec}`,
    hitsPerPage: '0',
  });
  const res = await getJson<AlgoliaResponse>(`${API}/search?${params}`, { cacheTtlMs: 60 * 60 * 1000 });
  return res.nbHits;
}

/** Most relevant/popular stories since `fromSec`. */
export async function topStories(query: string, fromSec: number, limit: number): Promise<HnStory[]> {
  const params = new URLSearchParams({
    query,
    tags: 'story',
    numericFilters: `created_at_i>=${fromSec}`,
    hitsPerPage: String(limit),
  });
  const res = await getJson<AlgoliaResponse>(`${API}/search?${params}`, { cacheTtlMs: 60 * 60 * 1000 });
  return res.hits.map((h) => ({
    title: h.title ?? '(untitled)',
    url: h.url ?? null,
    hnUrl: `https://news.ycombinator.com/item?id=${h.objectID}`,
    points: h.points ?? 0,
    comments: h.num_comments ?? 0,
    createdAt: h.created_at,
  }));
}
