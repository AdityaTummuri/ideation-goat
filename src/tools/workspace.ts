import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as github from '../clients/github.js';
import { fixedVersion, getVulns, queryBatch, vulnSeverity, type Severity } from '../clients/osv.js';
import { profileDependencyInjection } from '../analysis/di.js';
import { licenseCompatibility } from '../analysis/license.js';
import { collectDependencies } from '../analysis/manifests.js';
import { profileWorkspace } from '../analysis/workspace.js';
import { reportProgress, truncate } from '../lib/context.js';
import { resolveInWorkspace } from '../lib/paths.js';
import { ok, safe } from '../lib/result.js';

const pathArg = z.string().default('.').describe('Directory relative to the server WORKSPACE_ROOT (default: the root itself).');
const LOCAL_READ = { readOnlyHint: true, openWorldHint: false } as const;
const SEVERITY_RANK: Record<Severity, number> = { UNKNOWN: 0, LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };

const INTEGRATION_ADVICE: Record<string, string> = {
  'Clean / Hexagonal (ports & adapters)': 'Wrap the library in an adapter under infrastructure/ behind a port interface; keep it out of domain code.',
  MVC: 'Call the library from models or a service helper; keep controllers thin.',
  'Layered (N-tier)': 'Confine the library to the layer that owns its concern (e.g. a storage client in repositories/).',
  'Feature modules': 'Add it to the one feature module that needs it and expose a narrow interface to the others.',
};

export function registerWorkspaceTools(server: McpServer): void {
  server.registerTool(
    'workspace_profile',
    {
      title: 'Profile a local project',
      description:
        'Scan a local project directory (inside WORKSPACE_ROOT): languages by file count, frameworks, build tools, license, directory-layout pattern, and declared dependencies from manifests/lockfiles. Read-only, no network.',
      inputSchema: { path: pathArg },
      outputSchema: {
        path: z.string(),
        primaryLanguage: z.string().nullable(),
        languages: z.array(z.object({ language: z.string(), files: z.number() })),
        frameworks: z.array(z.string()),
        buildTools: z.array(z.string()),
        license: z.string().nullable(),
        architecture: z.object({ pattern: z.string(), evidence: z.array(z.string()) }),
        dependencyCount: z.number(),
        dependencies: z.array(z.object({ name: z.string(), ecosystem: z.string(), version: z.string().nullable(), dev: z.boolean() })),
        filesScanned: z.number(),
        truncated: z.boolean(),
      },
      annotations: LOCAL_READ,
    },
    safe(async ({ path }) => {
      const p = profileWorkspace(resolveInWorkspace(path));
      return ok({ ...p, dependencies: p.dependencies.slice(0, 200).map(({ name, ecosystem, version, dev }) => ({ name, ecosystem, version, dev })) });
    }),
  );

  server.registerTool(
    'repo_workspace_fit',
    {
      title: 'Check if a repo fits your project',
      description:
        'Compare a GitHub repository with a local project: language match, license compatibility (copyleft into permissive/proprietary is flagged), whether it is already a dependency, and where it should sit given the project\'s layout. License guidance is a coarse flag, not legal advice.',
      inputSchema: { repo: z.string().describe('GitHub owner/name or URL.'), workspace_path: pathArg },
      outputSchema: {
        repo: z.string(),
        workspace: z.string(),
        language: z.object({ workspace: z.array(z.string()), repo: z.string().nullable(), match: z.boolean() }),
        license: z.object({ workspace: z.string().nullable(), repo: z.string().nullable(), verdict: z.enum(['compatible', 'caution', 'conflict']), reason: z.string() }),
        alreadyDependency: z.boolean(),
        architecture: z.object({ pattern: z.string(), advice: z.string() }),
        overall: z.enum(['good-fit', 'needs-review', 'poor-fit']),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async ({ repo, workspace_path }) => {
      const ownerRepo = github.parseOwnerRepo(repo);
      if (!ownerRepo) throw new Error(`'${repo}' is not a GitHub repository.`);
      const ws = profileWorkspace(resolveInWorkspace(workspace_path));
      const meta = await github.getRepo(ownerRepo);

      const wsLangs = ws.languages.map((l) => l.language);
      const family = (l: string) => (l === 'TypeScript' || l === 'JavaScript' ? 'JS' : l === 'C' || l === 'C++' ? 'C' : l);
      const langMatch = !meta.language || wsLangs.length === 0 || wsLangs.some((l) => family(l) === family(meta.language!));
      const repoLicense = meta.license?.spdx_id && meta.license.spdx_id !== 'NOASSERTION' ? meta.license.spdx_id : null;
      const lic = licenseCompatibility(ws.license, repoLicense);
      const repoName = ownerRepo.split('/')[1]!.toLowerCase();
      const alreadyDependency = ws.dependencies.some((d) => d.name.toLowerCase() === repoName || d.name.toLowerCase().endsWith(`/${repoName}`));
      const overall = lic.verdict === 'conflict' ? 'poor-fit' : !langMatch || lic.verdict === 'caution' ? 'needs-review' : 'good-fit';

      return ok({
        repo: ownerRepo,
        workspace: ws.path,
        language: { workspace: wsLangs.slice(0, 5), repo: meta.language, match: langMatch },
        license: { workspace: ws.license, repo: repoLicense, ...lic },
        alreadyDependency,
        architecture: {
          pattern: ws.architecture.pattern,
          advice: INTEGRATION_ADVICE[ws.architecture.pattern] ?? 'No clear layering found; wrap the library in one helper module so it can be swapped later.',
        },
        overall,
      });
    }),
  );

  server.registerTool(
    'scan_dependency_vulnerabilities',
    {
      title: 'Scan local dependencies for known vulnerabilities',
      description:
        'Read lockfiles/manifests in a local project (package-lock.json, package.json, requirements.txt, pyproject.toml, poetry.lock, Cargo.lock, go.mod), query OSV.dev for every dependency with an exact version, and report advisories with severity (computed from CVSS v3 vectors when available) and fixed versions. ' +
        'Dependencies with only a version range are listed under `unpinned` and not scanned; add a lockfile for full coverage. `gate.passed` is false when anything meets `fail_on`.',
      inputSchema: {
        path: pathArg,
        include_dev: z.boolean().default(true),
        fail_on: z.enum(['low', 'medium', 'high', 'critical']).default('high'),
      },
      outputSchema: {
        path: z.string(),
        scanned: z.number(),
        unpinned: z.array(z.string()),
        findings: z.array(
          z.object({
            package: z.string(),
            version: z.string(),
            ecosystem: z.string(),
            id: z.string(),
            aliases: z.array(z.string()),
            severity: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'UNKNOWN']),
            cvssScore: z.number().nullable(),
            summary: z.string(),
            fixedIn: z.string().nullable(),
          }),
        ),
        countsBySeverity: z.record(z.string(), z.number()),
        gate: z.object({ failOn: z.string(), passed: z.boolean() }),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async ({ path, include_dev, fail_on }, extra) => {
      const dir = resolveInWorkspace(path);
      const deps = collectDependencies(dir).filter((d) => include_dev || !d.dev);
      const pinned = deps.filter((d): d is typeof d & { version: string } => !!d.version);
      const unpinned = deps.filter((d) => !d.version).map((d) => `${d.name} (${d.spec ?? 'no version'}, ${d.source})`);

      await reportProgress(extra, 0, 3, `Querying OSV for ${pinned.length} packages`);
      const idsPerDep = await queryBatch(pinned.map((d) => ({ name: d.name, ecosystem: d.ecosystem, version: d.version })));
      await reportProgress(extra, 1, 3, 'Fetching advisory details');
      const vulns = await getVulns(idsPerDep.flat());
      await reportProgress(extra, 2, 3, 'Scoring');

      const findings = pinned.flatMap((d, i) =>
        (idsPerDep[i] ?? []).map((id) => {
          const v = vulns.get(id);
          const sev = v ? vulnSeverity(v) : { severity: 'UNKNOWN' as const, cvssScore: null };
          return {
            package: d.name,
            version: d.version,
            ecosystem: d.ecosystem,
            id,
            aliases: v?.aliases ?? [],
            severity: sev.severity,
            cvssScore: sev.cvssScore,
            summary: truncate(v?.summary ?? v?.details ?? '', 240),
            fixedIn: v ? fixedVersion(v, d.name, d.version, d.ecosystem) : null,
          };
        }),
      );
      findings.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);

      const counts: Record<string, number> = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, UNKNOWN: 0 };
      for (const f of findings) counts[f.severity] = (counts[f.severity] ?? 0) + 1;
      const threshold = SEVERITY_RANK[fail_on.toUpperCase() as Severity];
      await reportProgress(extra, 3, 3, 'Done');

      return ok({
        path: dir,
        scanned: pinned.length,
        unpinned,
        findings,
        countsBySeverity: counts,
        gate: { failOn: fail_on, passed: !findings.some((f) => SEVERITY_RANK[f.severity] >= threshold) },
      });
    }),
  );

  server.registerTool(
    'dependency_injection_report',
    {
      title: 'Coupling / dependency-injection report (heuristic)',
      description:
        'Regex-based scan of a local codebase that counts classes using constructor injection or DI decorators versus classes that construct their collaborators inline (`new Service()` / `self.x = Service()`). Returns a score, a grade, and the files with the most inline construction. Heuristic: no AST, so expect some false positives.',
      inputSchema: { path: pathArg },
      outputSchema: {
        filesScanned: z.number(),
        classes: z.number(),
        classesWithInjection: z.number(),
        inlineConstructions: z.number(),
        score: z.number(),
        grade: z.enum(['A', 'B', 'C', 'D', 'F']),
        hotspots: z.array(z.object({ file: z.string(), inlineConstructions: z.number(), examples: z.array(z.string()) })),
        method: z.string(),
      },
      annotations: LOCAL_READ,
    },
    safe(async ({ path }) => ok({ ...profileDependencyInjection(resolveInWorkspace(path)) })),
  );
}
