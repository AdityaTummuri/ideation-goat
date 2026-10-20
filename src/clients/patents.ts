import { config } from '../config.js';
import { getJson } from '../lib/http.js';

export interface Patent {
  source: 'Google Patents (SerpApi)';
  publicationNumber: string;
  title: string;
  snippet: string;
  assignee: string | null;
  priorityDate: string | null;
  publicationDate: string | null;
  url: string;
}

export class NotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotConfiguredError';
  }
}

interface SerpApiResponse {
  error?: string;
  organic_results?: Array<{
    patent_id?: string;
    publication_number?: string;
    title?: string;
    snippet?: string;
    assignee?: string;
    priority_date?: string;
    publication_date?: string;
    patent_link?: string;
  }>;
}

/** Search Google Patents through SerpApi. Requires SERPAPI_API_KEY; never fabricates results. */
export async function searchPatents(query: string, limit: number): Promise<Patent[]> {
  const key = config.serpApiKey;
  if (!key) {
    throw new NotConfiguredError('Patent search needs a SerpApi key. Set SERPAPI_API_KEY (https://serpapi.com) in the server environment.');
  }
  const params = new URLSearchParams({ engine: 'google_patents', q: query, num: String(Math.max(10, limit)), api_key: key });
  const res = await getJson<SerpApiResponse>(`https://serpapi.com/search.json?${params}`, { cacheTtlMs: 24 * 60 * 60 * 1000 });
  if (res.error) {
    if (/hasn't returned any results/i.test(res.error)) return [];
    throw new Error(`SerpApi: ${res.error}`);
  }
  return (res.organic_results ?? []).slice(0, limit).map((r) => {
    const id = (r.patent_id ?? '').replace(/^patent\//, '').replace(/\/[a-z]{2}$/, '');
    return {
      source: 'Google Patents (SerpApi)',
      publicationNumber: r.publication_number ?? id,
      title: r.title ?? '(untitled)',
      snippet: r.snippet ?? '',
      assignee: r.assignee ?? null,
      priorityDate: r.priority_date ?? null,
      publicationDate: r.publication_date ?? null,
      url: r.patent_link ?? `https://patents.google.com/patent/${id}`,
    };
  });
}
