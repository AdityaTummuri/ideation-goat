import { randomUUID, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { log } from './lib/logger.js';
import { createServer, VERSION } from './server.js';

const MAX_BODY = 1024 * 1024;

export interface HttpOptions {
  host: string;
  port: number;
  /** Required when binding to a non-loopback address. Clients send `Authorization: Bearer <token>`. */
  authToken?: string;
  /** Close sessions idle for longer than this (default 30 min). */
  sessionIdleMs?: number;
}

class BadRequest extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: number,
  ) {
    super(message);
  }
}

export const isLoopback = (host: string) => host === '127.0.0.1' || host === 'localhost' || host === '::1';

/**
 * Streamable HTTP transport (MCP spec 2025-03-26+), stateful: each client
 * session gets its own server instance and state, keyed by Mcp-Session-Id.
 */
export async function startHttp(opts: HttpOptions): Promise<http.Server> {
  const { host, port } = opts;
  const localOnly = isLoopback(host);
  if (!localOnly && !opts.authToken) {
    throw new Error(`Refusing to listen on ${host} without authentication. Set MCP_AUTH_TOKEN, or bind to 127.0.0.1.`);
  }
  const expectedAuth = opts.authToken ? Buffer.from(`Bearer ${opts.authToken}`) : null;
  const idleMs = opts.sessionIdleMs ?? 30 * 60 * 1000;
  const sessions = new Map<string, { transport: StreamableHTTPServerTransport; lastSeen: number }>();

  const sweeper = setInterval(() => {
    const cutoff = Date.now() - idleMs;
    for (const [id, s] of sessions) {
      if (s.lastSeen < cutoff) {
        log.info('closing idle session', { id });
        sessions.delete(id);
        void s.transport.close();
      }
    }
  }, Math.min(60_000, idleMs)).unref();

  const httpServer = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname === '/healthz') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ status: 'ok', version: VERSION, sessions: sessions.size }));
        return;
      }
      if (url.pathname !== '/mcp') {
        res.writeHead(404).end();
        return;
      }
      if (expectedAuth) {
        const got = Buffer.from(req.headers.authorization ?? '');
        if (got.length !== expectedAuth.length || !timingSafeEqual(got, expectedAuth)) {
          res.writeHead(401, { 'www-authenticate': 'Bearer' });
          return void jsonRpcError(res, 401, -32001, 'Unauthorized');
        }
      }

      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      const existing = sessionId ? sessions.get(sessionId) : undefined;
      if (existing) existing.lastSeen = Date.now();
      // Per spec: an unknown session ID gets 404 so the client starts a new session.
      if (sessionId && !existing) return jsonRpcError(res, 404, -32001, 'Session not found');

      if (req.method === 'POST') {
        const body = await readJson(req);
        if (existing) return void (await existing.transport.handleRequest(req, res, body));
        if (!isInitializeRequest(body)) return jsonRpcError(res, 400, -32000, 'Bad Request: no Mcp-Session-Id and not an initialize request');

        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            sessions.set(id, { transport, lastSeen: Date.now() });
            log.info('session opened', { id });
          },
          enableDnsRebindingProtection: localOnly,
          allowedHosts: localOnly ? [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`] : undefined,
        });
        transport.onclose = () => {
          if (transport.sessionId) sessions.delete(transport.sessionId);
        };
        await createServer().connect(transport);
        return void (await transport.handleRequest(req, res, body));
      }

      if (req.method === 'GET' || req.method === 'DELETE') {
        if (!existing) return jsonRpcError(res, 400, -32000, 'Bad Request: Mcp-Session-Id header required');
        return void (await existing.transport.handleRequest(req, res));
      }
      res.writeHead(405, { allow: 'GET, POST, DELETE' }).end();
    } catch (err) {
      if (err instanceof BadRequest) return jsonRpcError(res, err.status, err.code, err.message);
      log.error('http handler error', { error: String(err) });
      if (!res.headersSent) jsonRpcError(res, 500, -32603, 'Internal server error');
    }
  });

  httpServer.on('close', () => {
    clearInterval(sweeper);
    for (const s of sessions.values()) void s.transport.close();
    sessions.clear();
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, host, resolve);
  });
  log.info(`Streamable HTTP listening on http://${host}:${port}/mcp${expectedAuth ? ' (bearer auth required)' : ''}`);
  return httpServer;
}

function jsonRpcError(res: http.ServerResponse, status: number, code: number, message: string): void {
  if (!res.headersSent) res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }));
}

function readJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new BadRequest('Request body too large', 413, -32600));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined);
      } catch {
        reject(new BadRequest('Parse error: invalid JSON', 400, -32700));
      }
    });
    req.on('error', reject);
  });
}
