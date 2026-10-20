import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

export class PathSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathSecurityError';
  }
}

/**
 * Resolve a user-supplied path inside the workspace root.
 *
 * - Relative paths resolve against the root, not the process cwd.
 * - Symlinks are resolved (via the nearest existing ancestor), so a link
 *   pointing outside the root is rejected.
 * - Uses path.relative rather than startsWith, so `/root-evil` is not
 *   accepted as being inside `/root`.
 */
export function resolveInWorkspace(input: string | undefined, root: string = config.workspaceRoot): string {
  const realRoot = realpathOrSelf(path.resolve(root));
  const candidate = path.resolve(realRoot, input ?? '.');
  const real = realpathOfNearestAncestor(candidate);

  if (!isInside(realRoot, real)) {
    throw new PathSecurityError(`Path '${input}' resolves outside the workspace root '${realRoot}'. Set WORKSPACE_ROOT to allow it.`);
  }
  return real;
}

export function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function realpathOrSelf(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

function realpathOfNearestAncestor(p: string): string {
  const suffix: string[] = [];
  let current = p;
  for (;;) {
    try {
      const real = fs.realpathSync(current);
      return suffix.length ? path.join(real, ...suffix.reverse()) : real;
    } catch {
      // realpath failed but the entry exists: a dangling symlink, whose target we cannot vet.
      if (lstatOrNull(current)) throw new PathSecurityError(`Path component '${current}' is a broken symlink.`);
      const parent = path.dirname(current);
      if (parent === current) return p;
      suffix.push(path.basename(current));
      current = parent;
    }
  }
}

function lstatOrNull(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

/**
 * Read a regular file directly inside `dir`, refusing symlinks so a
 * repository cannot point a manifest at e.g. ~/.aws/credentials.
 */
export function readRegularFile(dir: string, name: string): string | null {
  const p = path.join(dir, name);
  const st = lstatOrNull(p);
  if (!st || !st.isFile()) return null;
  return fs.readFileSync(p, 'utf8');
}

/** True if `target` or any existing component between `root` and it is a symlink. */
export function hasSymlinkBetween(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  let current = root;
  for (const part of rel.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const st = lstatOrNull(current);
    if (!st) return false;
    if (st.isSymbolicLink()) return true;
  }
  return false;
}

export const IGNORED_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build', 'target', '.next', 'chroma_data']);
