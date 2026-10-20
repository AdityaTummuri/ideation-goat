import type { Ecosystem } from '../clients/osv.js';
import { readRegularFile } from '../lib/paths.js';

export interface Dependency {
  name: string;
  ecosystem: Ecosystem;
  /** Exact resolved version, or null when only a range is known. */
  version: string | null;
  /** Declared spec, e.g. "^1.2.0" or ">=2". */
  spec: string | null;
  source: string;
  dev: boolean;
}

const EXACT_SEMVER = /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/;

/**
 * Collect dependencies from manifests and lockfiles at the root of `dir`.
 * Lockfiles win over manifests because they pin exact versions.
 */
export function collectDependencies(dir: string): Dependency[] {
  const deps = new Map<string, Dependency>();
  const add = (d: Dependency) => {
    const key = `${d.ecosystem}:${d.name.toLowerCase()}`;
    const existing = deps.get(key);
    if (!existing || (!existing.version && d.version)) deps.set(key, d);
  };
  const read = (f: string) => readRegularFile(dir, f);

  const lock = read('package-lock.json');
  if (lock) parsePackageLock(lock).forEach(add);
  const pkg = read('package.json');
  if (pkg) parsePackageJson(pkg).forEach(add);
  const poetryLock = read('poetry.lock');
  if (poetryLock) parseTomlPackages(poetryLock, 'PyPI', 'poetry.lock').forEach(add);
  const req = read('requirements.txt');
  if (req) parseRequirements(req).forEach(add);
  const pyproject = read('pyproject.toml');
  if (pyproject) parsePyproject(pyproject).forEach(add);
  const cargoLock = read('Cargo.lock');
  if (cargoLock) parseTomlPackages(cargoLock, 'crates.io', 'Cargo.lock').forEach(add);
  const gomod = read('go.mod');
  if (gomod) parseGoMod(gomod).forEach(add);

  return [...deps.values()];
}

export function parsePackageJson(text: string): Dependency[] {
  const data = safeJson(text);
  if (!data) return [];
  const out: Dependency[] = [];
  for (const [section, dev] of [['dependencies', false], ['devDependencies', true], ['optionalDependencies', false]] as const) {
    const block = data[section];
    if (!block || typeof block !== 'object') continue;
    for (const [name, spec] of Object.entries(block as Record<string, string>)) {
      const clean = String(spec).replace(/^[=v]/, '');
      out.push({ name, ecosystem: 'npm', version: EXACT_SEMVER.test(clean) ? clean : null, spec: String(spec), source: 'package.json', dev });
    }
  }
  return out;
}

/** package-lock.json v2/v3 ("packages") and v1 ("dependencies"). Top-level packages only. */
export function parsePackageLock(text: string): Dependency[] {
  const data = safeJson(text);
  if (!data) return [];
  const out: Dependency[] = [];
  const packages = data.packages as Record<string, { version?: string; dev?: boolean }> | undefined;
  if (packages) {
    for (const [key, info] of Object.entries(packages)) {
      const m = /^node_modules\/((?:@[^/]+\/)?[^/]+)$/.exec(key);
      if (m && info.version) out.push({ name: m[1] as string, ecosystem: 'npm', version: info.version, spec: null, source: 'package-lock.json', dev: !!info.dev });
    }
    return out;
  }
  const v1 = data.dependencies as Record<string, { version?: string; dev?: boolean }> | undefined;
  for (const [name, info] of Object.entries(v1 ?? {})) {
    if (info.version) out.push({ name, ecosystem: 'npm', version: info.version, spec: null, source: 'package-lock.json', dev: !!info.dev });
  }
  return out;
}

export function parseRequirements(text: string): Dependency[] {
  const out: Dependency[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.split('#')[0]!.trim();
    if (!line || line.startsWith('-')) continue;
    const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?\s*(.*)$/.exec(line);
    if (!m) continue;
    const spec = (m[2] ?? '').split(';')[0]!.trim();
    const exact = /^===?\s*([\w.!+-]+)$/.exec(spec);
    out.push({ name: normalizePyName(m[1] as string), ecosystem: 'PyPI', version: exact?.[1] ?? null, spec: spec || null, source: 'requirements.txt', dev: false });
  }
  return out;
}

/** PEP 621 `dependencies = [...]` in pyproject.toml. */
export function parsePyproject(text: string): Dependency[] {
  const block = /^\s*dependencies\s*=\s*\[([\s\S]*?)\]/m.exec(text)?.[1];
  if (!block) return [];
  const items = [...block.matchAll(/["']([^"']+)["']/g)].map((m) => m[1] as string);
  return parseRequirements(items.join('\n')).map((d) => ({ ...d, source: 'pyproject.toml' }));
}

/** `[[package]] name = "x" version = "y"` blocks (Cargo.lock, poetry.lock). */
export function parseTomlPackages(text: string, ecosystem: Ecosystem, source: string): Dependency[] {
  const out: Dependency[] = [];
  for (const block of text.split(/^\[\[package\]\]\s*$/m).slice(1)) {
    const name = /^name\s*=\s*"([^"]+)"/m.exec(block)?.[1];
    const version = /^version\s*=\s*"([^"]+)"/m.exec(block)?.[1];
    if (name && version) out.push({ name: ecosystem === 'PyPI' ? normalizePyName(name) : name, ecosystem, version, spec: null, source, dev: false });
  }
  return out;
}

export function parseGoMod(text: string): Dependency[] {
  const out: Dependency[] = [];
  const lines = [...(text.match(/require\s*\(([\s\S]*?)\)/)?.[1]?.split('\n') ?? []), ...[...text.matchAll(/^require\s+(\S+\s+\S+)/gm)].map((m) => m[1] as string)];
  for (const line of lines) {
    const m = /^\s*(\S+)\s+(v[\w.+-]+)/.exec(line);
    if (m) out.push({ name: m[1] as string, ecosystem: 'Go', version: m[2] as string, spec: null, source: 'go.mod', dev: line.includes('// indirect') });
  }
  return out;
}

function normalizePyName(n: string): string {
  return n.toLowerCase().replace(/[-_.]+/g, '-');
}

function safeJson(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}
