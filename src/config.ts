import path from 'node:path';

/**
 * Runtime configuration, read from environment variables.
 *
 * Every integration works without credentials; keys only raise rate limits
 * or unlock optional sources (patents). Values are read lazily so tests and
 * long-running HTTP deployments see the current environment.
 */
export const config = {
  get githubToken(): string | undefined {
    return env('GITHUB_TOKEN') ?? env('GITHUB_API_TOKEN');
  },
  get gitlabToken(): string | undefined {
    return env('GITLAB_TOKEN') ?? env('GITLAB_API_TOKEN');
  },
  get gitlabBaseUrl(): string {
    return (env('GITLAB_API_BASE_URL') ?? 'https://gitlab.com/api/v4').replace(/\/$/, '');
  },
  get serpApiKey(): string | undefined {
    return env('SERPAPI_API_KEY') ?? env('GOOGLE_PATENTS_API_KEY');
  },
  get semanticScholarKey(): string | undefined {
    return env('SEMANTIC_SCHOLAR_API_KEY');
  },
  get unpaywallEmail(): string | undefined {
    return env('UNPAYWALL_EMAIL');
  },
  /** All local file access (reads and scaffold writes) is confined to this directory. */
  get workspaceRoot(): string {
    return path.resolve(env('WORKSPACE_ROOT') ?? process.cwd());
  },
  get httpTimeoutMs(): number {
    return intEnv('HTTP_TIMEOUT_MS', 10_000);
  },
  get logLevel(): 'debug' | 'info' | 'warn' | 'error' {
    const v = env('LOG_LEVEL');
    return v === 'debug' || v === 'warn' || v === 'error' ? v : 'info';
  },
};

function env(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v ? v : undefined;
}

function intEnv(name: string, fallback: number): number {
  const n = Number.parseInt(env(name) ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
