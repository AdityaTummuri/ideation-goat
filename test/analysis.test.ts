import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { clusterIssueTitles } from '../src/analysis/bugs.js';
import { estimateCost } from '../src/analysis/cost.js';
import { profileDependencyInjection } from '../src/analysis/di.js';
import { estimateFootprint } from '../src/analysis/footprint.js';
import { scoreHealth } from '../src/analysis/health.js';
import { detectLicenseFromText, licenseCompatibility } from '../src/analysis/license.js';
import { gradeLockin } from '../src/analysis/lockin.js';
import { collectDependencies, parseGoMod, parsePackageJson, parsePackageLock, parsePyproject, parseRequirements, parseTomlPackages } from '../src/analysis/manifests.js';
import { renderScaffold, writeFiles } from '../src/analysis/scaffold.js';
import { profileWorkspace } from '../src/analysis/workspace.js';
import { buildArxivQuery, parseArxivAtom } from '../src/clients/arxiv.js';
import { parseOwnerRepo } from '../src/clients/github.js';
import { compareVersions, cvss3BaseScore, fixedVersion, vulnSeverity } from '../src/clients/osv.js';
import { classifyTrend } from '../src/tools/research.js';
import { ARXIV_XML, tmpDir, writeTree } from './helpers.js';

describe('CVSS v3 base score', () => {
  it.each([
    ['CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H', 9.8],
    ['CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N', 6.1],
    ['CVSS:3.0/AV:L/AC:L/PR:L/UI:N/S:U/C:H/I:H/A:H', 7.8],
    ['CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:U/C:H/I:N/A:N', 5.9],
    ['CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H', 10],
    ['CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:N', 0],
  ])('%s -> %s', (vector, expected) => {
    expect(cvss3BaseScore(vector)).toBe(expected);
  });

  it('returns null for v4 or malformed vectors', () => {
    expect(cvss3BaseScore('CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N')).toBeNull();
    expect(cvss3BaseScore('CVSS:3.1/AV:X')).toBeNull();
  });

  it('prefers CVSS, maps GHSA MODERATE to MEDIUM, and never invents a severity', () => {
    expect(vulnSeverity({ id: 'a', severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' }] })).toEqual({ severity: 'CRITICAL', cvssScore: 9.8 });
    expect(vulnSeverity({ id: 'b', database_specific: { severity: 'MODERATE' } }).severity).toBe('MEDIUM');
    expect(vulnSeverity({ id: 'c' }).severity).toBe('UNKNOWN');
  });

  it('finds the fixed version for the matching package', () => {
    const v = { id: 'x', affected: [{ package: { name: 'other' }, ranges: [{ events: [{ fixed: '9' }] }] }, { package: { name: 'Lodash' }, ranges: [{ events: [{ introduced: '0' }, { fixed: '4.17.21' }] }] }] };
    expect(fixedVersion(v, 'lodash', '4.17.20')).toBe('4.17.21');
  });

  it('picks the fix on the installed release line and normalises names', () => {
    const v = { id: 'y', affected: [{ package: { name: 'zope.interface', ecosystem: 'PyPI' }, ranges: [{ events: [{ introduced: '0' }, { fixed: '1.2.5' }, { introduced: '2.0.0' }, { fixed: '2.0.3' }] }] }] };
    expect(fixedVersion(v, 'zope-interface', '2.0.1', 'PyPI')).toBe('2.0.3');
    expect(fixedVersion(v, 'zope-interface', '1.0.0', 'PyPI')).toBe('1.2.5');
    expect(fixedVersion(v, 'zope-interface', '2.0.1', 'npm')).toBeNull();
  });

  it('compares versions numerically', () => {
    expect(['1.10.0', '1.2.0', '1.2.0-rc1', '1.9'].sort(compareVersions)).toEqual(['1.2.0-rc1', '1.2.0', '1.9', '1.10.0']);
  });
});

describe('manifest parsing', () => {
  it('package.json: exact versions only when pinned', () => {
    const deps = parsePackageJson(JSON.stringify({ dependencies: { a: '1.2.3', b: '^2.0.0' }, devDependencies: { c: '=3.0.0' } }));
    expect(deps.map((d) => [d.name, d.version, d.dev])).toEqual([['a', '1.2.3', false], ['b', null, false], ['c', '3.0.0', true]]);
  });

  it('package-lock v3: top-level packages with versions', () => {
    const lock = { lockfileVersion: 3, packages: { '': {}, 'node_modules/lodash': { version: '4.17.20' }, 'node_modules/@types/node': { version: '22.0.0', dev: true }, 'node_modules/a/node_modules/b': { version: '1.0.0' } } };
    expect(parsePackageLock(JSON.stringify(lock)).map((d) => `${d.name}@${d.version}`)).toEqual(['lodash@4.17.20', '@types/node@22.0.0']);
  });

  it('requirements.txt: extras, markers, comments, pins', () => {
    const deps = parseRequirements('Django==4.2.1  # web\nrequests[socks]>=2.0 ; python_version>"3.8"\n-r other.txt\n\nPyYAML===6.0\n');
    expect(deps.map((d) => [d.name, d.version])).toEqual([['django', '4.2.1'], ['requests', null], ['pyyaml', '6.0']]);
  });

  it('pyproject, Cargo.lock, go.mod', () => {
    expect(parsePyproject('[project]\nname="x"\ndependencies = [\n  "httpx==0.27.0",\n  "pydantic>=2",\n]\n').map((d) => d.version)).toEqual(['0.27.0', null]);
    expect(parseTomlPackages('[[package]]\nname = "serde"\nversion = "1.0.200"\n\n[[package]]\nname = "tokio"\nversion = "1.37.0"\n', 'crates.io', 'Cargo.lock').length).toBe(2);
    expect(parseGoMod('module x\n\nrequire (\n\tgithub.com/gin-gonic/gin v1.9.1\n\tgolang.org/x/net v0.20.0 // indirect\n)\nrequire github.com/a/b v0.1.0\n').map((d) => d.name)).toEqual([
      'github.com/gin-gonic/gin',
      'golang.org/x/net',
      'github.com/a/b',
    ]);
  });

  it('lockfile versions win over manifest ranges', () => {
    const dir = tmpDir();
    writeTree(dir, {
      'package.json': JSON.stringify({ dependencies: { lodash: '^4.17.0' } }),
      'package-lock.json': JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/lodash': { version: '4.17.20' } } }),
    });
    expect(collectDependencies(dir)).toMatchObject([{ name: 'lodash', version: '4.17.20', source: 'package-lock.json' }]);
  });
});

describe('license detection', () => {
  it('does not misread GPL text as MIT (regression: "permitted" contains "mit")', () => {
    const gpl = 'GNU GENERAL PUBLIC LICENSE\nVersion 3, 29 June 2007\n... Everyone is permitted to copy and distribute verbatim copies ...';
    expect(detectLicenseFromText(gpl)).toBe('GPL-3.0');
    expect(detectLicenseFromText('MIT License\n\nPermission is hereby granted, free of charge, to any person')).toBe('MIT');
    expect(detectLicenseFromText('Apache License\nVersion 2.0, January 2004')).toBe('Apache-2.0');
  });

  it('flags copyleft into permissive/proprietary', () => {
    expect(licenseCompatibility('MIT', 'GPL-3.0').verdict).toBe('conflict');
    expect(licenseCompatibility(null, 'AGPL-3.0').verdict).toBe('conflict');
    expect(licenseCompatibility('GPL-3.0', 'MIT').verdict).toBe('compatible');
    expect(licenseCompatibility('MIT', 'LGPL-3.0').verdict).toBe('caution');
    expect(licenseCompatibility('MIT', null).verdict).toBe('caution');
  });
});

describe('health score', () => {
  const base = { archived: false, daysSinceLastPush: 2, commitsLast30d: 40, contributors: 50, topContributorShare: 0.2, mergedPrsLast30d: 20, openIssues: 100, stars: 50_000 };
  it('scores an active, well-staffed repo highly with a full breakdown', () => {
    const h = scoreHealth(base);
    expect(h.score).toBe(100);
    expect(h.rating).toBe('healthy');
    expect(h.breakdown.reduce((s, b) => s + b.max, 0)).toBe(100);
  });
  it('excludes factors it could not fetch instead of scoring them as zero', () => {
    const h = scoreHealth({ ...base, contributors: null, commitsLast30d: null });
    expect(h.score).toBe(100);
    expect(h.breakdown.find((b) => b.factor === 'bus_factor')!.points).toBeNull();
    expect(h.flags.join(' ')).toMatch(/INCOMPLETE/);
    expect(h.flags.join(' ')).not.toMatch(/BUS_FACTOR/);
  });
  it('archived repos score 0', () => {
    expect(scoreHealth({ ...base, archived: true }).score).toBe(0);
  });
  it('penalises a stale single-maintainer repo', () => {
    const h = scoreHealth({ ...base, daysSinceLastPush: 500, commitsLast30d: 0, contributors: 1, topContributorShare: 1, mergedPrsLast30d: 0 });
    expect(h.rating).toBe('high-risk');
    expect(h.flags.join(' ')).toMatch(/STALE.*BUS_FACTOR/);
  });
});

describe('issue clustering', () => {
  it('groups titles by shared keywords and marks severe themes', () => {
    const titles = ['Memory leak in websocket reconnect', 'websocket reconnect loops forever', 'Websocket reconnect drops messages', 'Crash on startup with config', 'crash on startup windows', 'typo in docs'];
    const clusters = clusterIssueTitles(titles.map((t, i) => ({ title: t, url: `u${i}` })));
    expect(clusters[0]).toMatchObject({ label: 'reconnect / websocket', count: 3, severe: true });
    expect(clusters[1]).toMatchObject({ count: 2, severe: true });
    expect(clusters.reduce((s, c) => s + c.count, 0)).toBe(5);
  });
});

describe('lock-in grading', () => {
  it('grades by vendor count', () => {
    expect(gradeLockin(['react', 'express']).grade).toBe('A');
    expect(gradeLockin(['@aws-sdk/client-s3']).grade).toBe('B');
    expect(gradeLockin(['@aws-sdk/client-s3', 'firebase', '@vercel/og']).grade).toBe('D');
  });
});

describe('arXiv client', () => {
  it('parses Atom entries and decodes entities', () => {
    const [a, b] = parseArxivAtom(ARXIV_XML);
    expect(a).toMatchObject({ id: '2101.00001v1', title: 'Synaptic pruning & energy-efficient signalling', primaryCategory: 'q-bio.NC', authors: ['Ada Lovelace', 'Alan Turing'], published: '2021-01-01', pdfUrl: 'https://arxiv.org/pdf/2101.00001v1' });
    expect(a!.summary).toContain('<as>');
    expect(b!.categories).toContain('cs.DS');
  });
  it('builds AND-ed queries with optional category filters', () => {
    expect(buildArxivQuery('How to build a lock-free cache')).toBe('all:lock-free AND all:cache');
    expect(buildArxivQuery('decay', ['q-bio.NC', 'nlin.AO'])).toBe('(all:decay) AND (cat:q-bio.NC OR cat:nlin.AO)');
  });
});

describe('misc helpers', () => {
  it('parses GitHub repo identifiers', () => {
    expect(parseOwnerRepo('facebook/react')).toBe('facebook/react');
    expect(parseOwnerRepo('https://github.com/facebook/react/tree/main')).toBe('facebook/react');
    expect(parseOwnerRepo('git@github.com:facebook/react.git')).toBe('facebook/react');
    expect(parseOwnerRepo('react')).toBeNull();
  });
  it('classifies HN trends', () => {
    expect(classifyTrend(30, 10)).toBe('rising');
    expect(classifyTrend(10, 10)).toBe('steady');
    expect(classifyTrend(2, 10)).toBe('declining');
    expect(classifyTrend(1, 0.2)).toBe('insufficient-data');
  });
  it('cost model itemises and totals', () => {
    expect(estimateCost({ provider: 'vercel', monthlyRequests: 50_000, avgResponseKb: 50 }).totalUsd).toBe(0);
    const aws = estimateCost({ provider: 'aws', monthlyRequests: 10_000_000, avgResponseKb: 50 });
    expect(aws.totalUsd).toBeCloseTo(aws.lineItems.reduce((s, i) => s + i.usd, 0), 2);
    expect(aws.assumptions.bandwidthGb).toBe(500);
  });
  it('footprint estimate is labelled low confidence', () => {
    const e = estimateFootprint({ rootFiles: ['Cargo.toml'], cargoToml: '[dependencies]\nembassy-executor = "0.5"', repoSizeKb: 100 });
    expect(e).toMatchObject({ ecosystem: 'Rust', confidence: 'low' });
    expect(e.sramKb.high).toBeLessThanOrEqual(64);
  });
});

describe('local analysis', () => {
  it('profiles a workspace', () => {
    const dir = tmpDir();
    writeTree(dir, {
      'package.json': JSON.stringify({ license: 'MIT', dependencies: { express: '4.19.2' } }),
      'src/controllers/a.ts': '',
      'src/services/b.ts': '',
      'src/repositories/c.ts': '',
      'node_modules/x/index.js': '',
      'LICENSE': 'MIT License',
    });
    const p = profileWorkspace(dir);
    expect(p).toMatchObject({ primaryLanguage: 'TypeScript', frameworks: ['Express'], license: 'MIT', buildTools: ['npm'] });
    expect(p.architecture.pattern).toBe('Layered (N-tier)');
    expect(p.filesScanned).toBe(5);
  });

  it('DI heuristic ignores built-ins and flags inline service construction', () => {
    const dir = tmpDir();
    writeTree(dir, {
      'good.ts': 'export class A {\n  constructor(private readonly repo: Repo) {}\n  m() { const s = new Set(); const d = new Date(); }\n}\n',
      'bad.ts': 'export class B {\n  private repo = new UserRepository();\n  private mailer = new Mailer();\n}\n',
      'x.test.ts': 'class T { a = new Thing(); }',
    });
    const r = profileDependencyInjection(dir);
    expect(r).toMatchObject({ filesScanned: 2, classes: 2, classesWithInjection: 1, inlineConstructions: 2 });
    expect(r.hotspots[0]!.file).toBe('bad.ts');
  });

  it('scaffold renders a runnable layout and refuses to overwrite', () => {
    const dir = tmpDir();
    const files = renderScaffold({ projectName: 'My App', stack: 'rust', blueprintMarkdown: '# Plan', port: 9000 });
    expect(Object.keys(files)).toEqual(expect.arrayContaining(['Dockerfile', 'Cargo.toml', 'src/main.rs', 'docs/BLUEPRINT.md']));
    expect(files.Dockerfile).toContain('target/release/my-app');
    writeFiles(dir, files, false);
    expect(fs.readFileSync(path.join(dir, 'docs/BLUEPRINT.md'), 'utf8')).toBe('# Plan\n');
    expect(() => writeFiles(dir, files, false)).toThrow(/Refusing to overwrite/);
  });
});
