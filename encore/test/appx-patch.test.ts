// The Store package's manifest patch (scripts/patch-appx.mjs): Windows redirects a Store app's new
// AppData folders to a private place that Explorer can't see and that uninstalling deletes, so the
// Store build switches that off, the way the installer version already behaves. See STORE.md.

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { findMakeAppx, isPatched, patchAppx, patchManifest, readManifest } from '../scripts/patch-appx.mjs';

const root = join(import.meta.dirname, '..');
/** What electron-builder calls once everything is built (electron-builder.yml). */
const hook = createRequire(import.meta.url)('../scripts/after-all-artifact-build.cjs') as (result: { artifactPaths: string[] }) => Promise<string[]>;
/** The manifest electron-builder wrote for the 0.2.0 Store build, as the Action produced it. */
const original = readFileSync(join(root, 'test', 'fixtures', 'appx-manifest.electron-builder.xml'), 'utf8').replace(/\r\n/g, '\n');

const between = (xml: string, element: string) => xml.slice(xml.indexOf(`<${element}>`), xml.indexOf(`</${element}>`));
const startTag = (xml: string) => /<Package\b[^>]*>/.exec(xml)![0];

describe('the manifest patch', () => {
  it('starts from what electron-builder writes: nothing switched off', () => {
    expect(isPatched(original)).toBe(false);
    expect(original).toContain('<rescap:Capability Name="runFullTrust"/>');
    expect(original).not.toContain('Virtualization');
  });

  it('switches off the redirection of AppData, with the capability that needs and the namespace it lives in', () => {
    const patched = patchManifest(original);
    expect(isPatched(patched)).toBe(true);
    expect(patched.match(/FileSystemWriteVirtualization>/g)).toHaveLength(2); // one open tag, one close tag
    expect(between(patched, 'Properties')).toContain('<desktop6:FileSystemWriteVirtualization>disabled</desktop6:FileSystemWriteVirtualization>');
    const capabilities = between(patched, 'Capabilities');
    expect(capabilities).toContain('<rescap:Capability Name="unvirtualizedResources"/>');
    expect(capabilities.indexOf('runFullTrust')).toBeLessThan(capabilities.indexOf('unvirtualizedResources'));
    const tag = startTag(patched);
    expect(tag).toContain('xmlns:desktop6="http://schemas.microsoft.com/appx/manifest/desktop/windows10/6"');
    expect(tag).toContain('xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities"');
    // Windows before 1903 doesn't know the setting and is told it may ignore it.
    expect(tag).toContain('IgnorableNamespaces="desktop6"');
  });

  it('changes nothing else in the manifest', () => {
    const patched = patchManifest(original);
    const stripped = patched
      .replace(/\n\s*xmlns:desktop6="[^"]*"/, '')
      .replace(/\n\s*IgnorableNamespaces="desktop6"/, '')
      .replace(/\n\s*<desktop6:FileSystemWriteVirtualization>[^<]*<\/desktop6:FileSystemWriteVirtualization>/, '')
      .replace(/\n\s*<rescap:Capability Name="unvirtualizedResources"\/>/, '');
    expect(stripped).toBe(original);
  });

  it('does not touch the package identity or the capabilities the app already had', () => {
    const patched = patchManifest(original);
    for (const keep of ['Name="Scriblio.EncoreKaraoke"', 'Version="0.2.0.0"', '<Capability Name="internetClient"/>', '<Capability Name="internetClientServer"/>', '<Capability Name="privateNetworkClientServer"/>', 'EntryPoint="Windows.FullTrustApplication"']) {
      expect(patched).toContain(keep);
    }
  });

  it('is a no-op on a manifest that is already patched', () => {
    const once = patchManifest(original);
    expect(patchManifest(once)).toBe(once);
  });

  it('keeps a Windows-style file Windows-style', () => {
    const patched = patchManifest(original.replace(/\n/g, '\r\n'));
    expect(isPatched(patched)).toBe(true);
    expect(patched.replace(/\r\n/g, '')).not.toContain('\n');
    expect(patched.replace(/\r\n/g, '\n')).toBe(patchManifest(original));
  });

  it('adds to a list of ignorable namespaces that is already there', () => {
    const withList = original.replace('restrictedcapabilities">', 'restrictedcapabilities"\n   IgnorableNamespaces="uap desktop">');
    const tag = startTag(patchManifest(withList));
    expect(tag).toContain('IgnorableNamespaces="uap desktop desktop6"');
    expect(tag.match(/IgnorableNamespaces/g)).toHaveLength(1);
  });

  it('declares the restricted-capabilities namespace if the manifest forgot to', () => {
    const bare = '<Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10">\n  <Properties>\n    <DisplayName>X</DisplayName>\n  </Properties>\n  <Capabilities>\n    <Capability Name="internetClient"/>\n  </Capabilities>\n</Package>\n';
    const patched = patchManifest(bare);
    expect(isPatched(patched)).toBe(true);
    expect(startTag(patched)).toContain('xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities"');
  });

  it('refuses a manifest shaped differently from what it expects, rather than shipping an unpatched package', () => {
    expect(() => patchManifest('<Foo/>')).toThrow(/no <Package>/);
    expect(() => patchManifest(original.replace('</Properties>', ''))).toThrow(/<\/Properties>/);
    expect(() => patchManifest(original.replace('</Capabilities>', ''))).toThrow(/<\/Capabilities>/);
    const enabled = original.replace('</Properties>', '<desktop6:FileSystemWriteVirtualization>enabled</desktop6:FileSystemWriteVirtualization></Properties>');
    expect(() => patchManifest(enabled)).toThrow(/already sets FileSystemWriteVirtualization to "enabled"/);
  });

  it('does not count half a patch as a patch', () => {
    const patched = patchManifest(original);
    expect(isPatched(patched.replace('unvirtualizedResources', 'somethingElse'))).toBe(false);
    expect(isPatched(patched.replace('>disabled<', '>enabled<'))).toBe(false);
    expect(isPatched(patched.replace(/\n\s*xmlns:desktop6="[^"]*"/, ''))).toBe(false);
  });
});

describe('finding makeappx', () => {
  const dirs: string[] = [];
  afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

  function sdk(versions: string[]) {
    const dir = mkdtempSync(join(tmpdir(), 'encore-sdk-'));
    dirs.push(dir);
    for (const v of versions) {
      mkdirSync(join(dir, 'Windows Kits', '10', 'bin', v, 'x64'), { recursive: true });
      writeFileSync(join(dir, 'Windows Kits', '10', 'bin', v, 'x64', 'makeappx.exe'), '');
    }
    return { 'ProgramFiles(x86)': dir };
  }

  it('takes the newest Windows SDK, by version number and not by spelling', () => {
    const env = sdk(['10.0.19041.0', '10.0.26100.0', '10.0.9600.0']);
    expect(findMakeAppx(env)).toBe(join(env['ProgramFiles(x86)'], 'Windows Kits', '10', 'bin', '10.0.26100.0', 'x64', 'makeappx.exe'));
  });

  it('can be told where it is', () => {
    expect(findMakeAppx({ MAKEAPPX: 'C:\\tools\\makeappx.exe' })).toBe('C:\\tools\\makeappx.exe');
  });

  it('says what to install when there is no SDK', () => {
    expect(() => findMakeAppx(sdk([]))).toThrow(/Windows SDK/);
  });
});

// The real thing: build a small package from the repo's own tile and logo files, patch it with the
// real makeappx (which checks the manifest against the schema), and read the result back.
const sdkAvailable = (() => {
  if (process.platform !== 'win32') return false;
  try {
    return existsSync(findMakeAppx());
  } catch {
    return false;
  }
})();

describe.skipIf(!sdkAvailable)('patching a real package', () => {
  const work = mkdtempSync(join(tmpdir(), 'encore-appx-test-'));
  afterAll(() => rmSync(work, { recursive: true, force: true }));

  function build(name: string) {
    const layout = join(work, `${name}-layout`);
    mkdirSync(join(layout, 'assets'), { recursive: true });
    mkdirSync(join(layout, 'app'), { recursive: true });
    for (const f of readdirSync(join(root, 'build', 'appx')).filter((f) => f.endsWith('.png'))) copyFileSync(join(root, 'build', 'appx', f), join(layout, 'assets', f));
    writeFileSync(join(layout, 'app', 'Encore Karaoke.exe'), 'not really a program');
    writeFileSync(join(layout, 'AppxManifest.xml'), original);
    const appx = join(work, `${name}.appx`);
    execFileSync(findMakeAppx(), ['pack', '/d', layout, '/p', appx, '/o', '/nv'], { stdio: 'pipe' });
    return appx;
  }

  it('turns a package that redirects AppData into one that does not, and the package still opens', () => {
    const appx = build('real');
    expect(isPatched(readManifest(appx))).toBe(false);
    expect(patchAppx(appx)).toBe(true);
    const manifest = readManifest(appx);
    expect(isPatched(manifest)).toBe(true);
    expect(manifest).toContain('Name="Scriblio.EncoreKaraoke"');
    // The patched package still has its payload: the program, and the file name with a space in it.
    const listing = execFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), ['-tf', appx], { encoding: 'utf8' });
    expect(listing).toMatch(/app\/Encore%20Karaoke\.exe/);
    expect(listing).toMatch(/assets\/StoreLogo\.png/);
  }, 120_000);

  it('leaves a package that is already patched alone', () => {
    const appx = build('twice');
    expect(patchAppx(appx)).toBe(true);
    expect(patchAppx(appx)).toBe(false);
  }, 120_000);

  it('is what electron-builder runs after a build: it patches every .appx and leaves the installer alone', async () => {
    const appx = build('hook');
    const installer = join(work, 'Encore-Karaoke-Setup-0.2.0.exe');
    writeFileSync(installer, 'not really an installer');
    expect(isPatched(readManifest(appx))).toBe(false);
    expect(await hook({ artifactPaths: [installer, appx] })).toEqual([]);
    expect(isPatched(readManifest(appx))).toBe(true);
    expect(readFileSync(installer, 'utf8')).toBe('not really an installer');
  }, 120_000);

  it('fails the build rather than let an unpatched Store package through', async () => {
    await expect(hook({ artifactPaths: [join(work, 'there-is-no-such-package.appx')] })).rejects.toThrow();
  });
});

describe('where the patch is run', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
  const builder = readFileSync(join(root, 'electron-builder.yml'), 'utf8');

  it('is electron-builder\'s own afterAllArtifactBuild step, so the Action and a local build both get it', () => {
    expect(builder).toMatch(/^afterAllArtifactBuild: \.\/scripts\/after-all-artifact-build\.cjs$/m);
    expect(existsSync(join(root, 'scripts', 'after-all-artifact-build.cjs'))).toBe(true);
    // The Store package is built by electron-builder alone, with nothing after it to forget.
    expect(pkg.scripts['dist:store']).toBe('npm run build:desktop && electron-builder --win appx');
  });

  it('can still be run by hand on a package that is already built', () => {
    expect(pkg.scripts['store:patch']).toBe('node scripts/patch-appx.mjs');
  });
});
