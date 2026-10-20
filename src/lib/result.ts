import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { HttpError } from './http.js';
import { PathSecurityError } from './paths.js';
import { NotConfiguredError } from '../clients/patents.js';

/**
 * Successful tool result: structured data (validated against the tool's
 * outputSchema by the SDK) plus a JSON text block for clients that only
 * read `content`.
 */
export function ok<T extends Record<string, unknown>>(data: T): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}

/** Tool-level error the model can see and react to (not a protocol error). */
export function fail(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

export function errorMessage(err: unknown): string {
  if (err instanceof PathSecurityError || err instanceof NotConfiguredError) return err.message;
  if (err instanceof HttpError) {
    if (err.status === 403 || err.status === 429) return `${err.message} (rate limited; set an API token to raise limits)`;
    return err.message;
  }
  if (err instanceof Error && err.name === 'TimeoutError') return 'Upstream request timed out.';
  return err instanceof Error ? err.message : String(err);
}

/** Wrap a handler so thrown errors become isError results. */
export function safe<A, E>(fn: (args: A, extra: E) => Promise<CallToolResult>): (args: A, extra: E) => Promise<CallToolResult> {
  return async (args: A, extra: E) => {
    try {
      return await fn(args, extra);
    } catch (err) {
      return fail(errorMessage(err));
    }
  };
}
