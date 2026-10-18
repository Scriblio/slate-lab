// The Store package should ask Microsoft for as little as it can: the network capabilities Encore uses, and
// the runFullTrust that electron-builder adds for any desktop app. A restricted capability beyond that can
// fail certification (Microsoft says unvirtualizedResources isn't meant for an app like this), so these keep
// one from creeping back in. How the Store build avoids needing it is in src/desktop/datadir.ts.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');
const builder = readFileSync(join(root, 'electron-builder.yml'), 'utf8').replace(/\r\n/g, '\n');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> };

/** The `capabilities:` list under `appx:` in electron-builder.yml. */
function appxCapabilities(): string[] {
  const appx = /^appx:\n((?:[ \t].*\n|\n)*)/m.exec(builder)?.[1] ?? '';
  const list = /^ {2}capabilities:\n((?: {4}- .*\n)+)/m.exec(appx)?.[1] ?? '';
  return [...list.matchAll(/^ {4}- (\S+)/gm)].map((m) => m[1]!);
}

describe('the Store package', () => {
  it('asks only for the network capabilities Encore uses', () => {
    expect(appxCapabilities().sort()).toEqual(['internetClient', 'internetClientServer', 'privateNetworkClientServer']);
  });

  it('is not patched to switch off Windows’ redirection of AppData, which needs a restricted capability', () => {
    expect(builder).not.toMatch(/^afterAllArtifactBuild:/m);
    expect(builder).not.toMatch(/unvirtualizedResources|FileSystemWriteVirtualization/);
    expect(Object.keys(pkg.scripts)).not.toContain('store:patch');
  });

  it('still builds the package with electron-builder’s appx target', () => {
    expect(pkg.scripts['dist:store']).toBe('npm run build:desktop && electron-builder --win appx');
  });
});
