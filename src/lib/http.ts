import { config } from '../config.js';
import { TtlCache } from './cache.js';
import { log } from './logger.js';

export const USER_AGENT = 'ideation-goat/2.0 (+https://github.com/AdityaTummuri/Ideation_GOAT)';

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly url: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: unknown;
  /** Retries for network errors, 429 and 5xx. */
  retries?: number;
  /** Cache successful responses for this many ms (0 = no cache). */
  cacheTtlMs?: number;
  timeoutMs?: number;
}

const cache = new TtlCache<unknown>(60 * 60 * 1000);

/** Exposed for tests. */
export function clearHttpCache(): void {
  cache.clear();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function request<T>(url: string, opts: RequestOptions, parse: (r: Response) => Promise<T>): Promise<T> {
  const method = opts.method ?? 'GET';
  const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  const cacheKey = `${method} ${url} ${body ?? ''}`;
  const ttl = opts.cacheTtlMs ?? 0;

  if (ttl > 0) {
    const hit = cache.get(cacheKey);
    if (hit !== undefined) return hit as T;
  }

  const retries = opts.retries ?? 2;
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        method,
        body,
        headers: {
          'User-Agent': USER_AGENT,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...opts.headers,
        },
        signal: AbortSignal.timeout(opts.timeoutMs ?? config.httpTimeoutMs),
      });

      if (res.ok) {
        const parsed = await parse(res);
        if (ttl > 0) cache.set(cacheKey, parsed);
        return parsed;
      }

      const retryable = res.status === 429 || res.status >= 500;
      lastError = new HttpError(`${method} ${redact(url)} -> HTTP ${res.status}`, res.status, url);
      if (!retryable) throw lastError;

      const retryAfter = Number(res.headers.get('retry-after'));
      if (attempt < retries) await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 10) * 1000 : backoff(attempt));
    } catch (err) {
      if (err instanceof HttpError && err.status < 500 && err.status !== 429) throw err;
      lastError = err;
      if (attempt < retries) {
        log.debug('request failed, retrying', { url: redact(url), attempt, error: String(err) });
        await sleep(backoff(attempt));
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function backoff(attempt: number): number {
  return 500 * 2 ** attempt + Math.floor(Math.random() * 250);
}

/** Strip credentials from URLs before they reach logs or error messages. */
export function redact(url: string): string {
  return url.replace(/([?&](?:api_key|key|token|email)=)[^&]*/gi, '$1***');
}

export function getJson<T = unknown>(url: string, opts: RequestOptions = {}): Promise<T> {
  return request(url, opts, (r) => r.json() as Promise<T>);
}

export function getText(url: string, opts: RequestOptions = {}): Promise<string> {
  return request(url, opts, (r) => r.text());
}

/** Run async work over items with a concurrency limit, preserving order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T, i);
    }
  });
  await Promise.all(workers);
  return out;
}
