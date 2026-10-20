import fs from 'node:fs';
import path from 'node:path';
import { IGNORED_DIRS } from '../lib/paths.js';

const CODE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.py', '.java', '.kt', '.cs']);
/** Constructing these inline is normal, not a coupling smell. */
const BENIGN = new Set(['Map', 'Set', 'WeakMap', 'WeakSet', 'Date', 'Error', 'TypeError', 'RangeError', 'Promise', 'Array', 'Object', 'RegExp', 'URL', 'URLSearchParams', 'AbortController', 'TextEncoder', 'TextDecoder', 'Buffer', 'Response', 'Request', 'Headers', 'ArrayList', 'HashMap', 'HashSet', 'StringBuilder']);

export interface DiReport {
  filesScanned: number;
  classes: number;
  classesWithInjection: number;
  inlineConstructions: number;
  score: number;
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  hotspots: Array<{ file: string; inlineConstructions: number; examples: string[] }>;
  method: string;
}

/**
 * Regex heuristic: counts classes with constructor parameters / DI
 * decorators versus `new X()` / `self.x = X()` inside class bodies.
 * It does not build an AST, so treat the grade as a pointer, not a verdict.
 */
export function profileDependencyInjection(root: string, maxFiles = 5000): DiReport {
  let filesScanned = 0;
  let classes = 0;
  let injected = 0;
  let inline = 0;
  const hotspots: DiReport['hotspots'] = [];

  const classRe = /^\s*(export\s+)?(default\s+)?(abstract\s+)?class\s+\w+/;
  const ctorInjection = /constructor\s*\(\s*(?:(?:private|public|protected|readonly)\s+)*\w+\s*[:,)?]|def\s+__init__\s*\(\s*self\s*,\s*\w+|@(Inject|Injectable|injectable|inject|Service|Autowired|singleton)\b/;
  const newRe = /\bnew\s+([A-Z]\w*)\s*\(/g;
  const pyInline = /\bself\.\w+\s*=\s*([A-Z]\w*)\(/g;

  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (filesScanned >= maxFiles || e.isSymbolicLink()) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!IGNORED_DIRS.has(e.name) && !e.name.startsWith('.') && e.name !== 'test' && e.name !== 'tests') walk(full);
        continue;
      }
      if (!CODE_EXT.has(path.extname(e.name)) || /\.(test|spec)\./.test(e.name)) continue;
      filesScanned++;
      let content: string;
      try {
        content = fs.readFileSync(full, 'utf8');
      } catch {
        continue;
      }
      const fileClasses = content.split('\n').filter((l) => classRe.test(l)).length;
      if (!fileClasses) continue;
      classes += fileClasses;
      if (ctorInjection.test(content)) injected += Math.min(fileClasses, (content.match(new RegExp(ctorInjection.source, 'g')) ?? []).length);

      const examples: string[] = [];
      for (const re of [newRe, pyInline]) {
        for (const m of content.matchAll(re)) {
          if (!BENIGN.has(m[1] as string)) examples.push(m[0].trim());
        }
      }
      if (examples.length) {
        inline += examples.length;
        hotspots.push({ file: path.relative(root, full), inlineConstructions: examples.length, examples: [...new Set(examples)].slice(0, 3) });
      }
    }
  };
  walk(root);

  const injectionRatio = classes ? injected / classes : 1;
  const inlinePerClass = classes ? inline / classes : 0;
  const score = Math.round(Math.max(0, Math.min(100, 50 + injectionRatio * 50 - inlinePerClass * 15)));
  const grade = score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 70 ? 'C' : score >= 60 ? 'D' : 'F';

  return {
    filesScanned,
    classes,
    classesWithInjection: injected,
    inlineConstructions: inline,
    score,
    grade,
    hotspots: hotspots.sort((a, b) => b.inlineConstructions - a.inlineConstructions).slice(0, 10),
    method: 'Regex heuristic over source files (no AST). Test files excluded.',
  };
}
