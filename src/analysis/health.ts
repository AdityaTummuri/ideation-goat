export interface HealthInputs {
  archived: boolean;
  daysSinceLastPush: number;
  /** null = could not be fetched (rate limit, API refused); the factor is then excluded. */
  commitsLast30d: number | null;
  contributors: number | null;
  /** Share of commits by the top contributor (0-1), when known. */
  topContributorShare: number | null;
  mergedPrsLast30d: number | null;
  openIssues: number;
  stars: number;
}

export interface HealthScore {
  score: number;
  rating: 'healthy' | 'caution' | 'high-risk';
  breakdown: Array<{ factor: string; points: number | null; max: number; detail: string }>;
  flags: string[];
}

/**
 * Transparent maintenance score (0-100). Each factor is reported so the
 * number can be audited rather than trusted. Factors whose data could not be
 * fetched are marked unknown and excluded; the score is rescaled over the rest.
 */
export function scoreHealth(i: HealthInputs): HealthScore {
  const breakdown: HealthScore['breakdown'] = [];
  const flags: string[] = [];
  const unknown = (factor: string, max: number) => breakdown.push({ factor, points: null, max, detail: 'unknown (data unavailable from API)' });

  if (i.archived) {
    return { score: 0, rating: 'high-risk', breakdown: [{ factor: 'archived', points: 0, max: 100, detail: 'Repository is archived (read-only).' }], flags: ['ARCHIVED'] };
  }

  const recency = i.daysSinceLastPush <= 7 ? 30 : i.daysSinceLastPush <= 30 ? 24 : i.daysSinceLastPush <= 90 ? 16 : i.daysSinceLastPush <= 180 ? 8 : i.daysSinceLastPush <= 365 ? 4 : 0;
  breakdown.push({ factor: 'recency', points: recency, max: 30, detail: `Last push ${i.daysSinceLastPush} days ago` });
  if (i.daysSinceLastPush > 365) flags.push('STALE: no pushes in over a year');

  if (i.commitsLast30d === null) unknown('commit_activity', 25);
  else {
    const c = i.commitsLast30d;
    breakdown.push({ factor: 'commit_activity', points: c >= 30 ? 25 : c >= 10 ? 20 : c >= 3 ? 12 : c >= 1 ? 6 : 0, max: 25, detail: `${c}${c >= 100 ? '+' : ''} commits in last 30 days` });
  }

  if (i.contributors === null) unknown('bus_factor', 20);
  else {
    const n = i.contributors;
    let bus = n >= 10 ? 20 : n >= 5 ? 15 : n >= 2 ? 8 : 0;
    if (i.topContributorShare !== null && i.topContributorShare > 0.8 && n > 1) bus = Math.min(bus, 8);
    breakdown.push({
      factor: 'bus_factor',
      points: bus,
      max: 20,
      detail: `${n}${n >= 100 ? '+' : ''} contributors${i.topContributorShare !== null ? `, top contributor ${(i.topContributorShare * 100).toFixed(0)}% of commits` : ''}`,
    });
    if (n <= 1 || (i.topContributorShare ?? 0) > 0.8) flags.push('BUS_FACTOR: one person does most of the work');
  }

  if (i.mergedPrsLast30d === null) unknown('pr_throughput', 15);
  else {
    const p = i.mergedPrsLast30d;
    breakdown.push({ factor: 'pr_throughput', points: p >= 10 ? 15 : p >= 3 ? 10 : p >= 1 ? 5 : 0, max: 15, detail: `${p} PRs merged in last 30 days (from latest 100 updated)` });
  }

  const ratio = i.openIssues / Math.max(i.stars, 1);
  breakdown.push({ factor: 'issue_load', points: ratio < 0.02 ? 10 : ratio < 0.05 ? 7 : ratio < 0.15 ? 4 : 0, max: 10, detail: `${i.openIssues} open issues+PRs vs ${i.stars} stars (ratio ${ratio.toFixed(3)})` });

  const known = breakdown.filter((b) => b.points !== null);
  const maxKnown = known.reduce((s, b) => s + b.max, 0);
  const score = Math.round((known.reduce((s, b) => s + (b.points ?? 0), 0) / maxKnown) * 100);
  if (known.length < breakdown.length) flags.push(`INCOMPLETE: ${breakdown.length - known.length} factor(s) unavailable; score rescaled over the rest`);
  return { score, rating: score >= 70 ? 'healthy' : score >= 40 ? 'caution' : 'high-risk', breakdown, flags };
}
