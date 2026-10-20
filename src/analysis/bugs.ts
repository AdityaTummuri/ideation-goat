const STOP = new Set(
  ('the a an and or but in on at to for with by from up about into over after is are was were be been being have has had do does did not no can could should would will ' +
    'just when where why how all any both each few more most other some such than that this these those it its of error bug issue fails failed failing using use doesnt dont ' +
    'work working works cannot cant unable get getting got new add support feature request question help version').split(' '),
);

const SEVERE = ['crash', 'leak', 'memory', 'deadlock', 'hang', 'freeze', 'security', 'vulnerability', 'panic', 'corrupt', 'segfault', 'oom', 'race', 'data loss'];

export interface BugCluster {
  label: string;
  keywords: string[];
  count: number;
  percentage: number;
  severe: boolean;
  examples: Array<{ title: string; url: string }>;
}

export function tokenize(title: string): string[] {
  const cleaned = title.toLowerCase().replace(/\[[^\]]*\]|\([^)]*\)|`[^`]*`/g, ' ');
  return (cleaned.match(/[a-z][a-z0-9_-]+/g) ?? []).filter((w) => w.length > 2 && !STOP.has(w));
}

/**
 * Greedy keyword clustering of issue titles: pick the most frequent remaining
 * term (document frequency), group every unclaimed title containing it, label
 * with the most common co-occurring term. Simple and explainable; not semantic.
 */
export function clusterIssueTitles(issues: Array<{ title: string; url: string }>, maxClusters = 5): BugCluster[] {
  const docs = issues.map((i) => ({ ...i, terms: new Set(tokenize(i.title)) }));
  const claimed = new Set<number>();
  const clusters: BugCluster[] = [];

  while (clusters.length < maxClusters) {
    const df = new Map<string, number>();
    docs.forEach((d, idx) => {
      if (!claimed.has(idx)) for (const t of d.terms) df.set(t, (df.get(t) ?? 0) + 1);
    });
    const top = [...df.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    if (!top || top[1] < 2) break;

    const members = docs.map((d, idx) => ({ d, idx })).filter(({ d, idx }) => !claimed.has(idx) && d.terms.has(top[0]));
    members.forEach(({ idx }) => claimed.add(idx));

    const co = new Map<string, number>();
    for (const { d } of members) for (const t of d.terms) if (t !== top[0]) co.set(t, (co.get(t) ?? 0) + 1);
    const second = [...co.entries()].sort((a, b) => b[1] - a[1])[0];
    const keywords = second && second[1] >= 2 ? [top[0], second[0]] : [top[0]];
    const text = members.map((m) => m.d.title.toLowerCase()).join(' ');

    clusters.push({
      label: keywords.join(' / '),
      keywords,
      count: members.length,
      percentage: Math.round((members.length / docs.length) * 1000) / 10,
      severe: SEVERE.some((s) => keywords.some((k) => k.includes(s)) || text.includes(s)),
      examples: members.slice(0, 3).map(({ d }) => ({ title: d.title, url: d.url })),
    });
  }
  return clusters;
}
