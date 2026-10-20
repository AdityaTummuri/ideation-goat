import fs from 'node:fs';
import path from 'node:path';
import { IGNORED_DIRS, readRegularFile } from '../lib/paths.js';
import { detectLicenseFromText } from './license.js';
import { collectDependencies, type Dependency } from './manifests.js';

const EXT_LANG: Record<string, string> = {
  '.ts': 'TypeScript', '.tsx': 'TypeScript', '.js': 'JavaScript', '.jsx': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript',
  '.py': 'Python', '.rs': 'Rust', '.go': 'Go', '.java': 'Java', '.kt': 'Kotlin', '.c': 'C', '.h': 'C', '.cpp': 'C++', '.cc': 'C++',
  '.hpp': 'C++', '.cs': 'C#', '.rb': 'Ruby', '.php': 'PHP', '.swift': 'Swift', '.dart': 'Dart', '.ino': 'Arduino',
};

export const FRAMEWORK_SIGNATURES: Record<string, string> = {
  fastapi: 'FastAPI', flask: 'Flask', django: 'Django', streamlit: 'Streamlit', torch: 'PyTorch', tensorflow: 'TensorFlow',
  langchain: 'LangChain', 'scikit-learn': 'scikit-learn', opencv: 'OpenCV', 'opencv-python': 'OpenCV', numpy: 'NumPy',
  express: 'Express', fastify: 'Fastify', '@nestjs/core': 'NestJS', next: 'Next.js', react: 'React', vue: 'Vue', svelte: 'Svelte',
  '@modelcontextprotocol/sdk': 'MCP SDK', 'actix-web': 'Actix Web', axum: 'Axum', tokio: 'Tokio', rocket: 'Rocket',
  'github.com/gin-gonic/gin': 'Gin', 'github.com/gofiber/fiber/v2': 'Fiber', 'github.com/labstack/echo/v4': 'Echo',
};

const BUILD_FILES: Record<string, string> = {
  'package.json': 'npm', 'pnpm-lock.yaml': 'pnpm', 'yarn.lock': 'yarn', 'bun.lockb': 'bun', 'pyproject.toml': 'pyproject',
  'requirements.txt': 'pip', 'poetry.lock': 'poetry', 'uv.lock': 'uv', 'Cargo.toml': 'cargo', 'go.mod': 'go modules',
  'CMakeLists.txt': 'CMake', Makefile: 'make', 'platformio.ini': 'PlatformIO', Dockerfile: 'Docker', 'pom.xml': 'Maven', 'build.gradle': 'Gradle',
};

const PATTERNS: Array<{ name: string; dirs: string[] }> = [
  { name: 'Clean / Hexagonal (ports & adapters)', dirs: ['domain', 'ports', 'adapters', 'infrastructure', 'application', 'usecases', 'entities'] },
  { name: 'MVC', dirs: ['models', 'views', 'controllers', 'templates'] },
  { name: 'Layered (N-tier)', dirs: ['services', 'repositories', 'api', 'controllers', 'dao', 'db', 'routes'] },
  { name: 'Feature modules', dirs: ['modules', 'features'] },
];

export interface WorkspaceProfile {
  path: string;
  primaryLanguage: string | null;
  languages: Array<{ language: string; files: number }>;
  frameworks: string[];
  buildTools: string[];
  license: string | null;
  architecture: { pattern: string; evidence: string[] };
  dependencyCount: number;
  dependencies: Dependency[];
  filesScanned: number;
  truncated: boolean;
}

export function profileWorkspace(dir: string, maxFiles = 20_000): WorkspaceProfile {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`'${dir}' is not a directory.`);

  const langCounts = new Map<string, number>();
  let filesScanned = 0;
  let truncated = false;

  const walk = (d: string, depth: number) => {
    if (depth > 8 || truncated) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (!IGNORED_DIRS.has(e.name) && !e.name.startsWith('.')) walk(path.join(d, e.name), depth + 1);
      } else if (e.isFile()) {
        if (++filesScanned > maxFiles) {
          truncated = true;
          return;
        }
        const lang = EXT_LANG[path.extname(e.name).toLowerCase()];
        if (lang) langCounts.set(lang, (langCounts.get(lang) ?? 0) + 1);
      }
    }
  };
  walk(dir, 0);

  const languages = [...langCounts.entries()].map(([language, files]) => ({ language, files })).sort((a, b) => b.files - a.files);
  const dependencies = collectDependencies(dir);
  const frameworks = [...new Set(dependencies.map((d) => FRAMEWORK_SIGNATURES[d.name.toLowerCase()]).filter((f): f is string => !!f))];
  const rootFiles = safeReaddir(dir);
  const buildTools = [...new Set(rootFiles.map((f) => BUILD_FILES[f]).filter((b): b is string => !!b))];

  return {
    path: dir,
    primaryLanguage: languages[0]?.language ?? null,
    languages,
    frameworks,
    buildTools,
    license: detectWorkspaceLicense(dir, rootFiles),
    architecture: detectArchitecture(dir),
    dependencyCount: dependencies.length,
    dependencies,
    filesScanned: Math.min(filesScanned, maxFiles),
    truncated,
  };
}

export function detectWorkspaceLicense(dir: string, rootFiles = safeReaddir(dir)): string | null {
  try {
    const pkg = JSON.parse(readRegularFile(dir, 'package.json') ?? '{}');
    if (typeof pkg.license === 'string' && pkg.license !== 'UNLICENSED') return pkg.license;
  } catch {
    /* invalid package.json */
  }
  for (const manifest of ['Cargo.toml', 'pyproject.toml']) {
    const m = /^\s*license\s*=\s*["']([^"']+)["']/m.exec(readRegularFile(dir, manifest) ?? '');
    if (m) return m[1] as string;
  }
  const licenseFile = rootFiles.find((f) => /^(licen[sc]e|copying)(\.(md|txt))?$/i.test(f));
  const text = licenseFile ? readRegularFile(dir, licenseFile) : null;
  return text ? detectLicenseFromText(text) : null;
}

export function detectArchitecture(dir: string): { pattern: string; evidence: string[] } {
  const dirs = new Set<string>();
  for (const base of [dir, path.join(dir, 'src'), path.join(dir, 'app')]) {
    for (const e of safeReaddir(base, true)) dirs.add(e.toLowerCase());
  }
  let best = { pattern: 'No conventional layout detected', evidence: [] as string[] };
  for (const p of PATTERNS) {
    const hits = p.dirs.filter((d) => dirs.has(d));
    if (hits.length >= 2 && hits.length > best.evidence.length) best = { pattern: p.name, evidence: hits };
  }
  return best;
}

function safeReaddir(d: string, dirsOnly = false): string[] {
  try {
    return fs.readdirSync(d, { withFileTypes: true }).filter((e) => (dirsOnly ? e.isDirectory() : true)).map((e) => e.name);
  } catch {
    return [];
  }
}
