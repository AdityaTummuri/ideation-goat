/**
 * Rough monthly hosting-cost model.
 *
 * PRICES ARE HARDCODED and change often; verify against the providers'
 * pricing pages before relying on them. Every assumption is returned with the
 * estimate so the caller can see what the number depends on.
 */
export const PRICING = {
  vercel: { proMonthly: 20, includedRequestsM: 1, perExtraMillionRequests: 0.6, includedBandwidthGb: 1000, per100GbBandwidth: 40, hobbyRequests: 100_000, hobbyBandwidthGb: 100 },
  supabase: { proMonthly: 25, includedBandwidthGb: 250, perGbBandwidth: 0.09, includedDbGb: 8, perGbDb: 0.125, includedMau: 100_000, perMau: 0.00325, freeMau: 50_000, freeBandwidthGb: 5, freeDbGb: 0.5 },
  neon: { launchMonthly: 19, launchStorageGb: 10, launchComputeHours: 300, scaleMonthly: 69, scaleStorageGb: 50, perGbStorage: 0.15, scaleComputeHours: 750, perComputeHour: 0.16, freeStorageGb: 0.5, freeComputeHours: 190 },
  aws: { apiGatewayHttpPerMillion: 1.0, lambdaPerMillion: 0.2, lambdaPerGbSecond: 0.0000166667, egressPerGb: 0.09, dynamoStoragePerGb: 0.25, freeLambdaRequestsM: 1, freeLambdaGbSeconds: 400_000, freeDynamoGb: 25, freeEgressGb: 100 },
} as const;

export interface CostInput {
  provider: 'aws' | 'vercel' | 'supabase' | 'neon';
  monthlyRequests: number;
  avgResponseKb: number;
  monthlyActiveUsers?: number;
  databaseGb?: number;
  /** AWS Lambda: memory (MB) and average duration (ms). */
  lambdaMemoryMb?: number;
  lambdaDurationMs?: number;
  /** Neon: average active compute hours per month. */
  computeHours?: number;
}

export interface CostEstimate {
  provider: string;
  plan: string;
  totalUsd: number;
  lineItems: Array<{ item: string; usd: number }>;
  assumptions: Record<string, number | string>;
  caveat: string;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export function estimateCost(input: CostInput): CostEstimate {
  const bandwidthGb = (input.monthlyRequests * input.avgResponseKb) / 1_000_000;
  const items: Array<{ item: string; usd: number }> = [];
  const assumptions: Record<string, number | string> = { monthlyRequests: input.monthlyRequests, avgResponseKb: input.avgResponseKb, bandwidthGb: r2(bandwidthGb) };
  let plan = '';

  switch (input.provider) {
    case 'vercel': {
      const p = PRICING.vercel;
      if (input.monthlyRequests <= p.hobbyRequests && bandwidthGb <= p.hobbyBandwidthGb) {
        plan = 'Hobby (free, non-commercial use only)';
      } else {
        plan = 'Pro';
        items.push({ item: 'Pro seat', usd: p.proMonthly });
        items.push({ item: 'Extra requests', usd: Math.max(0, input.monthlyRequests / 1e6 - p.includedRequestsM) * p.perExtraMillionRequests });
        items.push({ item: 'Extra bandwidth', usd: (Math.max(0, bandwidthGb - p.includedBandwidthGb) / 100) * p.per100GbBandwidth });
      }
      break;
    }
    case 'supabase': {
      const p = PRICING.supabase;
      const mau = input.monthlyActiveUsers ?? 0;
      const db = input.databaseGb ?? 0.5;
      Object.assign(assumptions, { monthlyActiveUsers: mau, databaseGb: db });
      if (mau <= p.freeMau && bandwidthGb <= p.freeBandwidthGb && db <= p.freeDbGb) {
        plan = 'Free';
      } else {
        plan = 'Pro';
        items.push({ item: 'Pro plan', usd: p.proMonthly });
        items.push({ item: 'Extra bandwidth', usd: Math.max(0, bandwidthGb - p.includedBandwidthGb) * p.perGbBandwidth });
        items.push({ item: 'Extra database storage', usd: Math.max(0, db - p.includedDbGb) * p.perGbDb });
        items.push({ item: 'Extra MAU', usd: Math.max(0, mau - p.includedMau) * p.perMau });
      }
      break;
    }
    case 'neon': {
      const p = PRICING.neon;
      const db = input.databaseGb ?? 1;
      const hours = input.computeHours ?? 100;
      Object.assign(assumptions, { databaseGb: db, computeHours: hours });
      if (db <= p.freeStorageGb && hours <= p.freeComputeHours) plan = 'Free';
      else if (db <= p.launchStorageGb && hours <= p.launchComputeHours) {
        plan = 'Launch';
        items.push({ item: 'Launch plan', usd: p.launchMonthly });
      } else {
        plan = 'Scale';
        items.push({ item: 'Scale plan', usd: p.scaleMonthly });
        items.push({ item: 'Extra storage', usd: Math.max(0, db - p.scaleStorageGb) * p.perGbStorage });
        items.push({ item: 'Extra compute hours', usd: Math.max(0, hours - p.scaleComputeHours) * p.perComputeHour });
      }
      break;
    }
    case 'aws': {
      const p = PRICING.aws;
      const memGb = (input.lambdaMemoryMb ?? 128) / 1024;
      const durS = (input.lambdaDurationMs ?? 100) / 1000;
      const db = input.databaseGb ?? 1;
      const m = input.monthlyRequests / 1e6;
      const gbSeconds = input.monthlyRequests * memGb * durS;
      Object.assign(assumptions, { lambdaMemoryMb: input.lambdaMemoryMb ?? 128, lambdaDurationMs: input.lambdaDurationMs ?? 100, databaseGb: db, stack: 'API Gateway HTTP API + Lambda + DynamoDB' });
      plan = 'Pay-as-you-go (always-free tier applied)';
      items.push({ item: 'API Gateway (HTTP API)', usd: m * p.apiGatewayHttpPerMillion });
      items.push({ item: 'Lambda requests', usd: Math.max(0, m - p.freeLambdaRequestsM) * p.lambdaPerMillion });
      items.push({ item: 'Lambda compute', usd: Math.max(0, gbSeconds - p.freeLambdaGbSeconds) * p.lambdaPerGbSecond });
      items.push({ item: 'DynamoDB storage', usd: Math.max(0, db - p.freeDynamoGb) * p.dynamoStoragePerGb });
      items.push({ item: 'Data transfer out', usd: Math.max(0, bandwidthGb - p.freeEgressGb) * p.egressPerGb });
      break;
    }
  }

  const lineItems = items.map((i) => ({ item: i.item, usd: r2(i.usd) }));
  return {
    provider: input.provider,
    plan,
    totalUsd: r2(lineItems.reduce((s, i) => s + i.usd, 0)),
    lineItems,
    assumptions,
    caveat: 'Rough estimate from hardcoded list prices; excludes taxes, support plans, and usage dimensions not modelled. Verify on the provider pricing page.',
  };
}
