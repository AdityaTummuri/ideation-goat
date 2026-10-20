import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectDependencies } from '../src/analysis/manifests.js';
import { renderScaffold, writeFiles } from '../src/analysis/scaffold.js';
import { detectWorkspaceLicense } from '../src/analysis/workspace.js';
import { PathSecurityError, resolveInWorkspace } from '../src/lib/paths.js';
import { redact } from '../src/lib/http.js';
import { tmpDir } from './helpers.js';

describe('resolveInWorkspace', () => {
  const parent = tmpDir();
  const root = path.join(parent, 'proj');
  fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
  fs.mkdirSync(path.join(parent, 'proj-evil'));

  it('resolves relative paths against the root, not cwd', () => {
    expect(resolveInWorkspace('sub', root)).toBe(path.join(root, 'sub'));
    expect(resolveInWorkspace(undefined, root)).toBe(root);
  });

  it('allows not-yet-existing paths inside the root', () => {
    expect(resolveInWorkspace('new/dir', root)).toBe(path.join(root, 'new/dir'));
  });

  it('rejects ../ traversal and absolute paths outside', () => {
    expect(() => resolveInWorkspace('../', root)).toThrow(PathSecurityError);
    expect(() => resolveInWorkspace('/etc', root)).toThrow(PathSecurityError);
  });

  it('rejects sibling directories that share a name prefix (old startsWith bug)', () => {
    expect(() => resolveInWorkspace(path.join(parent, 'proj-evil'), root)).toThrow(PathSecurityError);
  });

  it('rejects symlinks that escape the root', () => {
    fs.symlinkSync(parent, path.join(root, 'escape'));
    expect(() => resolveInWorkspace('escape', root)).toThrow(PathSecurityError);
    expect(() => resolveInWorkspace('escape/proj-evil/x', root)).toThrow(PathSecurityError);
  });
});

describe('symlinked files inside the workspace', () => {
  it('manifest and license readers do not follow symlinks to secrets', () => {
    const outside = tmpDir();
    fs.writeFileSync(path.join(outside, 'credentials'), 'aws-secret-access-key = s3cr3tvalue\n');
    const root = tmpDir();
    for (const name of ['requirements.txt', 'package.json', 'LICENSE']) fs.symlinkSync(path.join(outside, 'credentials'), path.join(root, name));
    expect(collectDependencies(root)).toEqual([]);
    expect(detectWorkspaceLicense(root)).toBeNull();
  });

  it('scaffold refuses to write through symlinks, including dangling ones', () => {
    const outside = tmpDir();
    const root = tmpDir();
    fs.mkdirSync(path.join(root, 'scaf'));
    fs.symlinkSync(path.join(outside, 'pwned.md'), path.join(root, 'scaf', 'README.md'));
    const files = renderScaffold({ projectName: 'x', stack: 'node', blueprintMarkdown: '# x', port: 1 });
    expect(() => writeFiles(path.join(root, 'scaf'), files, true)).toThrow(/symlink/);
    expect(fs.existsSync(path.join(outside, 'pwned.md'))).toBe(false);

    fs.symlinkSync(outside, path.join(root, 'linkdir'));
    expect(() => resolveInWorkspace('linkdir/new', root)).toThrow(PathSecurityError);
    fs.symlinkSync(path.join(outside, 'missing'), path.join(root, 'dangling'));
    expect(() => resolveInWorkspace('dangling/x', root)).toThrow(PathSecurityError);
  });
});

describe('redact', () => {
  it('hides credentials in query strings', () => {
    expect(redact('https://serpapi.com/search.json?q=x&api_key=SECRET&num=5')).toBe('https://serpapi.com/search.json?q=x&api_key=***&num=5');
    expect(redact('https://api.unpaywall.org/v2/doi?email=me@x.com')).toBe('https://api.unpaywall.org/v2/doi?email=***');
  });
});
