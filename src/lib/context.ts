import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';

export type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

export interface LastSearch {
  tool: string;
  query: string;
  at: string;
  results: unknown;
}

/** Per-connection state. Each MCP session gets its own server instance and state. */
export interface SessionState {
  lastSearch: LastSearch | null;
}

export function remember(state: SessionState, tool: string, query: string, results: unknown): void {
  state.lastSearch = { tool, query, at: new Date().toISOString(), results };
}

/** Send a progress notification if the client asked for one. */
export async function reportProgress(extra: Extra, progress: number, total: number, message: string): Promise<void> {
  const token = extra._meta?.progressToken;
  if (token === undefined) return;
  await extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress, total, message } });
}

export const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
