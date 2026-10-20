import { config } from '../config.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

/**
 * stderr-only logger.
 *
 * In stdio mode, stdout carries the JSON-RPC stream; anything else written
 * there corrupts the protocol. Never use console.log in this codebase.
 */
function write(level: Level, msg: string, meta?: Record<string, unknown>): void {
  if (LEVELS[level] < LEVELS[config.logLevel]) return;
  const line = meta ? `${msg} ${JSON.stringify(meta)}` : msg;
  process.stderr.write(`[ideation-goat] ${level.toUpperCase()} ${line}\n`);
}

export const log = {
  debug: (m: string, meta?: Record<string, unknown>) => write('debug', m, meta),
  info: (m: string, meta?: Record<string, unknown>) => write('info', m, meta),
  warn: (m: string, meta?: Record<string, unknown>) => write('warn', m, meta),
  error: (m: string, meta?: Record<string, unknown>) => write('error', m, meta),
};
