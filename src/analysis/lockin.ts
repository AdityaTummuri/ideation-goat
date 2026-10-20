export const VENDOR_PATTERNS: Array<{ pattern: RegExp; vendor: string }> = [
  { pattern: /^(@aws-sdk\/.+|aws-sdk|boto3|botocore|aws-cdk.*|aws-cdk-lib|@aws-cdk\/.+|aws-amplify|serverless)$/i, vendor: 'AWS' },
  { pattern: /^(@vercel\/.+|vercel|@edge-runtime\/.+)$/i, vendor: 'Vercel' },
  { pattern: /^(@google-cloud\/.+|google-cloud-.+|firebase|firebase-admin|firebase-functions)$/i, vendor: 'Google Cloud / Firebase' },
  { pattern: /^(@azure\/.+|azure-.+)$/i, vendor: 'Microsoft Azure' },
  { pattern: /^(wrangler|@cloudflare\/.+)$/i, vendor: 'Cloudflare' },
  { pattern: /^(@supabase\/.+|supabase)$/i, vendor: 'Supabase' },
  { pattern: /^(@netlify\/.+|netlify-cli)$/i, vendor: 'Netlify' },
  { pattern: /^(@planetscale\/.+|@neondatabase\/.+)$/i, vendor: 'Managed Postgres/MySQL (serverless driver)' },
];

export interface LockinResult {
  grade: 'A' | 'B' | 'C' | 'D';
  vendors: string[];
  lockedDependencies: Array<{ package: string; vendor: string }>;
  dependenciesChecked: number;
  summary: string;
}

export function gradeLockin(dependencies: string[]): LockinResult {
  const locked: LockinResult['lockedDependencies'] = [];
  for (const dep of new Set(dependencies)) {
    const hit = VENDOR_PATTERNS.find((v) => v.pattern.test(dep));
    if (hit) locked.push({ package: dep, vendor: hit.vendor });
  }
  const vendors = [...new Set(locked.map((l) => l.vendor))];
  const grade = locked.length === 0 ? 'A' : vendors.length === 1 && locked.length <= 2 ? 'B' : vendors.length <= 2 && locked.length <= 5 ? 'C' : 'D';
  const summary =
    grade === 'A'
      ? 'No proprietary cloud SDKs in direct dependencies.'
      : `${locked.length} direct dependencies tie the project to ${vendors.join(', ')}.`;
  return { grade, vendors, lockedDependencies: locked, dependenciesChecked: new Set(dependencies).size, summary };
}
