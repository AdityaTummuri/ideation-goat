import { getText } from '../lib/http.js';

export interface ArxivPaper {
  source: 'arXiv';
  id: string;
  title: string;
  summary: string;
  authors: string[];
  published: string;
  primaryCategory: string;
  categories: string[];
  url: string;
  pdfUrl: string | null;
}

const API = 'https://export.arxiv.org/api/query';

const STOP = new Set(['a', 'an', 'the', 'and', 'or', 'of', 'for', 'to', 'in', 'on', 'with', 'using', 'via', 'how', 'what', 'is', 'are', 'that', 'this', 'by', 'from', 'at', 'as', 'into', 'i', 'we', 'want', 'build', 'make']);

/**
 * Build an arXiv search_query: the most informative terms AND-ed together,
 * optionally restricted to a set of categories.
 */
export function buildArxivQuery(query: string, categories: string[] = []): string {
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9+-]+/)
    .filter((t) => t.length > 1 && !STOP.has(t))
    .slice(0, 6);
  const text = terms.length ? terms.map((t) => `all:${t}`).join(' AND ') : `all:${query.trim()}`;
  if (!categories.length) return text;
  return `(${text}) AND (${categories.map((c) => `cat:${c}`).join(' OR ')})`;
}

export async function searchArxiv(query: string, maxResults = 5, categories: string[] = []): Promise<ArxivPaper[]> {
  const params = new URLSearchParams({
    search_query: buildArxivQuery(query, categories),
    start: '0',
    max_results: String(maxResults),
    sortBy: 'relevance',
  });
  const xml = await getText(`${API}?${params}`, { cacheTtlMs: 6 * 60 * 60 * 1000 });
  return parseArxivAtom(xml);
}

export function parseArxivAtom(xml: string): ArxivPaper[] {
  const entries = xml.match(/<entry>[\s\S]*?<\/entry>/g) ?? [];
  return entries.map((entry) => {
    const id = text(entry, 'id');
    const categories = [...entry.matchAll(/<category[^>]*term="([^"]+)"/g)].map((m) => m[1] as string);
    const primary = /<arxiv:primary_category[^>]*term="([^"]+)"/.exec(entry)?.[1] ?? categories[0] ?? '';
    const pdf = /<link[^>]*title="pdf"[^>]*href="([^"]+)"/.exec(entry)?.[1] ?? /<link[^>]*href="([^"]+)"[^>]*title="pdf"/.exec(entry)?.[1] ?? null;
    const authors = [...entry.matchAll(/<author>\s*<name>([\s\S]*?)<\/name>/g)].map((m) => clean(m[1] as string));
    return {
      source: 'arXiv' as const,
      id: id.replace(/^https?:\/\/arxiv\.org\/abs\//, ''),
      title: clean(text(entry, 'title')),
      summary: clean(text(entry, 'summary')),
      authors,
      published: text(entry, 'published').slice(0, 10),
      primaryCategory: primary,
      categories,
      url: id.replace(/^http:/, 'https:'),
      pdfUrl: pdf ? pdf.replace(/^http:/, 'https:') : null,
    };
  });
}

function text(xml: string, tag: string): string {
  return new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(xml)?.[1] ?? '';
}

export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function clean(s: string): string {
  return decodeEntities(s).replace(/\s+/g, ' ').trim();
}

/**
 * Non-CS arXiv categories grouped by field, used for cross-domain discovery.
 * Explicit category codes (rather than wildcards) keep the query portable.
 */
export const DISCOVERY_FIELDS: Record<string, string[]> = {
  biology: ['q-bio.BM', 'q-bio.CB', 'q-bio.GN', 'q-bio.MN', 'q-bio.NC', 'q-bio.PE', 'q-bio.QM', 'q-bio.SC', 'q-bio.TO'],
  physics: ['physics.bio-ph', 'physics.comp-ph', 'physics.flu-dyn', 'physics.soc-ph', 'physics.app-ph', 'cond-mat.stat-mech', 'cond-mat.soft', 'cond-mat.dis-nn'],
  complex_systems: ['nlin.AO', 'nlin.CD', 'nlin.CG', 'nlin.PS', 'nlin.SI', 'physics.soc-ph'],
  economics: ['econ.GN', 'econ.TH', 'q-fin.TR', 'q-fin.RM', 'q-fin.CP'],
  mathematics: ['math.OC', 'math.PR', 'math.DS', 'math.CO'],
  engineering: ['eess.SY', 'eess.SP', 'physics.app-ph'],
};
