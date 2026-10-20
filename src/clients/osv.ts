import { getJson, mapLimit } from '../lib/http.js';

export type Ecosystem = 'npm' | 'PyPI' | 'crates.io' | 'Go' | 'Maven' | 'RubyGems';
export type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';

export interface OsvQuery {
  name: string;
  ecosystem: Ecosystem;
  version: string;
}

export interface OsvVuln {
  id: string;
  summary?: string;
  details?: string;
  aliases?: string[];
  severity?: Array<{ type: string; score: string }>;
  database_specific?: { severity?: string };
  affected?: Array<{ package?: { name?: string; ecosystem?: string }; ranges?: Array<{ events?: Array<{ introduced?: string; fixed?: string; last_affected?: string; limit?: string }> }> }>;
}

/**
 * Batch-query OSV for exact package versions (POST /v1/querybatch, max 1000
 * per request). Returns vulnerability IDs per query, in input order.
 */
export async function queryBatch(queries: OsvQuery[]): Promise<string[][]> {
  const out: string[][] = [];
  for (let i = 0; i < queries.length; i += 1000) {
    const chunk = queries.slice(i, i + 1000);
    const res = await getJson<{ results: Array<{ vulns?: Array<{ id: string }> }> }>('https://api.osv.dev/v1/querybatch', {
      method: 'POST',
      body: { queries: chunk.map((q) => ({ package: { name: q.name, ecosystem: q.ecosystem }, version: q.version })) },
      cacheTtlMs: 60 * 60 * 1000,
    });
    for (const r of res.results) out.push((r.vulns ?? []).map((v) => v.id));
  }
  return out;
}

export async function getVulns(ids: string[]): Promise<Map<string, OsvVuln>> {
  const unique = [...new Set(ids)];
  const vulns = await mapLimit(unique, 8, (id) => getJson<OsvVuln>(`https://api.osv.dev/v1/vulns/${encodeURIComponent(id)}`, { cacheTtlMs: 24 * 60 * 60 * 1000 }));
  return new Map(vulns.map((v) => [v.id, v]));
}

const normName = (n: string) => n.toLowerCase().replace(/[-_.]+/g, '-');

/**
 * Generic version comparison: numeric-aware over dot/dash separated parts, a
 * release sorts after its pre-releases. Good enough to choose between fixed
 * versions; not a full semver/PEP 440 implementation.
 */
export function compareVersions(a: string, b: string): number {
  const split = (v: string) => v.replace(/^v/, '').split('+')[0]!.split(/[.-]/);
  const pa = split(a);
  const pb = split(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i];
    const y = pb[i];
    if (x === undefined) return y !== undefined && /^\d+$/.test(y) ? -1 : 1;
    if (y === undefined) return /^\d+$/.test(x) ? 1 : -1;
    const nx = /^\d+$/.test(x) ? Number(x) : NaN;
    const ny = /^\d+$/.test(y) ? Number(y) : NaN;
    if (!Number.isNaN(nx) && !Number.isNaN(ny)) {
      if (nx !== ny) return nx - ny;
    } else if (x !== y) {
      if (!Number.isNaN(nx)) return 1;
      if (!Number.isNaN(ny)) return -1;
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/**
 * Lowest "fixed" version above the installed one, from the ranges for this
 * package/ecosystem whose "introduced" is at or below the installed version.
 */
export function fixedVersion(vuln: OsvVuln, pkg: string, installed: string, ecosystem?: string): string | null {
  const candidates: string[] = [];
  for (const a of vuln.affected ?? []) {
    if (!a.package?.name || normName(a.package.name) !== normName(pkg)) continue;
    if (ecosystem && a.package.ecosystem && a.package.ecosystem !== ecosystem) continue;
    for (const r of a.ranges ?? []) {
      let introduced = '0';
      for (const e of r.events ?? []) {
        if (e.introduced !== undefined) introduced = e.introduced;
        if (e.fixed && (introduced === '0' || compareVersions(introduced, installed) <= 0) && compareVersions(e.fixed, installed) > 0) candidates.push(e.fixed);
      }
    }
  }
  return candidates.sort(compareVersions)[0] ?? null;
}

/** Severity from a CVSS v3.x vector if present, else the database's own label. */
export function vulnSeverity(vuln: OsvVuln): { severity: Severity; cvssScore: number | null } {
  for (const s of vuln.severity ?? []) {
    if (s.type === 'CVSS_V3') {
      const score = cvss3BaseScore(s.score);
      if (score !== null) return { severity: scoreToSeverity(score), cvssScore: score };
    }
  }
  const label = vuln.database_specific?.severity?.toUpperCase();
  if (label === 'CRITICAL' || label === 'HIGH' || label === 'LOW') return { severity: label, cvssScore: null };
  if (label === 'MODERATE' || label === 'MEDIUM') return { severity: 'MEDIUM', cvssScore: null };
  return { severity: 'UNKNOWN', cvssScore: null };
}

export function scoreToSeverity(score: number): Severity {
  if (score >= 9) return 'CRITICAL';
  if (score >= 7) return 'HIGH';
  if (score >= 4) return 'MEDIUM';
  if (score > 0) return 'LOW';
  return 'UNKNOWN';
}

/** CVSS v3.0/3.1 base score from a vector string (FIRST.org specification). */
export function cvss3BaseScore(vector: string): number | null {
  if (!/^CVSS:3\.[01]\//.test(vector)) return null;
  const m: Record<string, string> = {};
  for (const part of vector.split('/').slice(1)) {
    const [k, v] = part.split(':');
    if (k && v) m[k] = v;
  }
  const scopeChanged = m.S === 'C';
  const AV = { N: 0.85, A: 0.62, L: 0.55, P: 0.2 }[m.AV ?? ''];
  const AC = { L: 0.77, H: 0.44 }[m.AC ?? ''];
  const PR = (scopeChanged ? { N: 0.85, L: 0.68, H: 0.5 } : { N: 0.85, L: 0.62, H: 0.27 })[m.PR ?? ''];
  const UI = { N: 0.85, R: 0.62 }[m.UI ?? ''];
  const cia = { H: 0.56, L: 0.22, N: 0 } as Record<string, number>;
  const C = cia[m.C ?? ''];
  const I = cia[m.I ?? ''];
  const A = cia[m.A ?? ''];
  if ([AV, AC, PR, UI, C, I, A].some((x) => x === undefined) || (m.S !== 'U' && m.S !== 'C')) return null;

  const iss = 1 - (1 - C!) * (1 - I!) * (1 - A!);
  const impact = scopeChanged ? 7.52 * (iss - 0.029) - 3.25 * (iss - 0.02) ** 15 : 6.42 * iss;
  const exploitability = 8.22 * AV! * AC! * PR! * UI!;
  if (impact <= 0) return 0;
  return roundUp1(Math.min((scopeChanged ? 1.08 : 1) * (impact + exploitability), 10));
}

/** CVSS v3.1 "Roundup": smallest 1-decimal number >= input, robust to float error. */
function roundUp1(x: number): number {
  const i = Math.round(x * 100_000);
  return i % 10_000 === 0 ? i / 100_000 : (Math.floor(i / 10_000) + 1) / 10;
}
