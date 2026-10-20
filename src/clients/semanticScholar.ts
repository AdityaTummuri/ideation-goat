import { config } from '../config.js';
import { getJson, mapLimit } from '../lib/http.js';

export interface ScholarPaper {
  source: 'Semantic Scholar';
  id: string;
  title: string;
  summary: string;
  year: number | null;
  authors: string[];
  citations: number;
  doi: string | null;
  url: string;
  pdfUrl: string | null;
  fieldsOfStudy: string[];
}

interface S2Response {
  data?: Array<{
    paperId: string;
    title?: string;
    abstract?: string | null;
    year?: number | null;
    url?: string;
    citationCount?: number;
    authors?: Array<{ name?: string }>;
    externalIds?: { DOI?: string } | null;
    openAccessPdf?: { url?: string } | null;
    fieldsOfStudy?: string[] | null;
  }>;
}

export async function searchSemanticScholar(query: string, limit = 5): Promise<ScholarPaper[]> {
  const params = new URLSearchParams({
    query,
    limit: String(limit),
    fields: 'title,abstract,year,url,citationCount,authors,externalIds,openAccessPdf,fieldsOfStudy',
  });
  const headers: Record<string, string> = {};
  if (config.semanticScholarKey) headers['x-api-key'] = config.semanticScholarKey;

  const res = await getJson<S2Response>(`https://api.semanticscholar.org/graph/v1/paper/search?${params}`, {
    headers,
    cacheTtlMs: 6 * 60 * 60 * 1000,
    retries: 3,
  });

  const papers: ScholarPaper[] = (res.data ?? []).map((p) => ({
    source: 'Semantic Scholar',
    id: p.paperId,
    title: p.title ?? '(untitled)',
    summary: p.abstract ?? '',
    year: p.year ?? null,
    authors: (p.authors ?? []).map((a) => a.name ?? '').filter(Boolean),
    citations: p.citationCount ?? 0,
    doi: p.externalIds?.DOI ?? null,
    url: p.url ?? `https://www.semanticscholar.org/paper/${p.paperId}`,
    pdfUrl: p.openAccessPdf?.url || null,
    fieldsOfStudy: p.fieldsOfStudy ?? [],
  }));

  // Optional: fill missing open-access links from Unpaywall (requires a contact email by their terms).
  const email = config.unpaywallEmail;
  if (email) {
    await mapLimit(papers, 3, async (p) => {
      if (p.pdfUrl || !p.doi) return;
      try {
        const up = await getJson<{ best_oa_location?: { url_for_pdf?: string | null } | null }>(
          `https://api.unpaywall.org/v2/${encodeURIComponent(p.doi)}?email=${encodeURIComponent(email)}`,
          { cacheTtlMs: 24 * 60 * 60 * 1000, retries: 1 },
        );
        p.pdfUrl = up.best_oa_location?.url_for_pdf ?? null;
      } catch {
        // Unpaywall enrichment is best-effort.
      }
    });
  }
  return papers;
}
