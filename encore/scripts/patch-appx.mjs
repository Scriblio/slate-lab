// Switches off Windows' redirection of AppData for the Microsoft Store package.
//
// Windows redirects the new AppData folders a Store (MSIX) desktop app creates to a private
// per-package place. Explorer can't see it, and uninstalling the app deletes it. For Encore that
// put Show -> Open Data Folder out of reach ("Location is not available") and took a KJ's settings,
// song keys, show history and the identity behind their printed QR codes with it on uninstall (see
// STORE.md, "Testing the package"). The installer version keeps its data in %APPDATA%\Encore Karaoke;
// this makes the Store version do the same, by adding
//
//   <desktop6:FileSystemWriteVirtualization>disabled</desktop6:FileSystemWriteVirtualization>
//
// to the manifest's <Properties>, with the restricted capability that setting requires:
//
//   <rescap:Capability Name="unvirtualizedResources"/>
//
// electron-builder can't write the first, so this unpacks the package it built, edits
// AppxManifest.xml and packs it again with makeappx from the Windows SDK, which also checks the
// manifest against the schema. Partner Center asks for a reason for a restricted capability; the
// wording is in STORE.md. Never ship a Store build that was virtualised and then switch this on:
// the data a KJ already has would sit in the private place where the new build can't see it.
//
// It runs by itself: electron-builder.yml names scripts/after-all-artifact-build.cjs as its
// afterAllArtifactBuild hook, which calls patchAppx on every .appx it just built (so the Action's Store
// build and `npm run dist:store` both come out patched, and a failure fails the build). By hand:
//
//   node scripts/patch-appx.mjs [file.appx ...]    (default: release/*.appx; patched in place)
//   node scripts/patch-appx.mjs --check [file.appx ...]    (exit 1 if one isn't patched)

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DESKTOP6 = 'http://schemas.microsoft.com/appx/manifest/desktop/windows10/6';
const RESCAP = 'http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities';
const PROPERTY = '<desktop6:FileSystemWriteVirtualization>disabled</desktop6:FileSystemWriteVirtualization>';
const CAPABILITY = '<rescap:Capability Name="unvirtualizedResources"/>';
const CAPABILITY_PATTERN = /<rescap:Capability\s+Name="unvirtualizedResources"\s*\/>/;
const PROPERTY_PATTERN = /<desktop6:FileSystemWriteVirtualization>\s*([^<]*?)\s*<\/desktop6:FileSystemWriteVirtualization>/;

/** Does this manifest already switch the redirection off, with everything that needs? */
export function isPatched(xml) {
  const property = PROPERTY_PATTERN.exec(xml);
  const start = /<Package\b[^>]*>/.exec(xml)?.[0] ?? '';
  return property?.[1] === 'disabled' && CAPABILITY_PATTERN.test(xml) && /\sxmlns:desktop6="/.test(start) && /\sxmlns:rescap="/.test(start);
}

/**
 * The manifest with the redirection switched off. A manifest that already is, comes back unchanged.
 * Anything unexpected about its shape throws, so a change in electron-builder's template breaks the
 * build instead of quietly shipping a package that still loses its data on uninstall.
 */
export function patchManifest(xml) {
  const eol = xml.includes('\r\n') ? '\r\n' : '\n';
  const existing = PROPERTY_PATTERN.exec(xml);
  if (existing && existing[1] !== 'disabled') throw new Error(`AppxManifest.xml already sets FileSystemWriteVirtualization to "${existing[1]}"; not changing it.`);

  const found = /<Package\b[^>]*>/.exec(xml);
  if (!found) throw new Error('AppxManifest.xml has no <Package> element.');
  let tag = found[0];
  const addAttribute = (name, value) => {
    tag = tag.replace(/\s*>$/, `${eol}   ${name}="${value}">`);
  };
  if (!/\sxmlns:rescap="/.test(tag)) addAttribute('xmlns:rescap', RESCAP);
  if (!/\sxmlns:desktop6="/.test(tag)) addAttribute('xmlns:desktop6', DESKTOP6);
  // Older Windows ignores what it doesn't know; the setting takes effect where it is known (Windows 10 1903 and later).
  const ignorable = /\sIgnorableNamespaces="([^"]*)"/.exec(tag);
  if (!ignorable) addAttribute('IgnorableNamespaces', 'desktop6');
  else if (!ignorable[1].split(/\s+/).includes('desktop6')) tag = tag.replace(ignorable[0], ` IgnorableNamespaces="${ignorable[1].trim()} desktop6"`);

  let out = xml.slice(0, found.index) + tag + xml.slice(found.index + found[0].length);
  if (!existing) out = insertLast(out, 'Properties', PROPERTY, eol);
  if (!CAPABILITY_PATTERN.test(out)) out = insertLast(out, 'Capabilities', CAPABILITY, eol);
  if (!isPatched(out)) throw new Error('AppxManifest.xml was edited but does not read as patched; not using it.');
  return out;
}

/** A line as the last child of an element, indented like the line before it, with the closing tag left as it was. */
function insertLast(xml, element, line, eol) {
  const close = xml.indexOf(`</${element}>`);
  if (close < 0) throw new Error(`AppxManifest.xml has no </${element}>.`);
  const lineStart = xml.lastIndexOf('\n', close - 1) + 1;
  const indentOf = (text) => /^[ \t]*/.exec(text.slice(text.lastIndexOf('\n') + 1))[0];
  if (/^[ \t]*$/.test(xml.slice(lineStart, close)) && lineStart > 0) {
    // The closing tag has a line to itself: the new line goes just above it.
    const indent = indentOf(xml.slice(0, lineStart - 1).replace(/\r$/, ''));
    return `${xml.slice(0, lineStart)}${indent}${line}${eol}${xml.slice(lineStart)}`;
  }
  // The closing tag shares a line with the element's content: the new line goes after that content.
  return `${xml.slice(0, close)}${eol}${indentOf(xml.slice(0, close))}${line}${xml.slice(close)}`;
}

// --- the package -----------------------------------------------------------------------

/** makeappx.exe from the newest Windows SDK installed (MAKEAPPX overrides). */
export function findMakeAppx(env = process.env) {
  if (env.MAKEAPPX) return env.MAKEAPPX;
  const bin = join(env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Windows Kits', '10', 'bin');
  const versions = existsSync(bin) ? readdirSync(bin).filter((d) => /^\d+\.\d+\.\d+\.\d+$/.test(d)) : [];
  versions.sort((a, b) => {
    const [x, y] = [a, b].map((v) => v.split('.').map(Number));
    return y.reduce((d, n, i) => d || n - x[i], 0);
  });
  for (const v of versions) {
    const exe = join(bin, v, 'x64', 'makeappx.exe');
    if (existsSync(exe)) return exe;
  }
  throw new Error('makeappx.exe not found. Install the Windows SDK (it is on GitHub\'s Windows runners), or set MAKEAPPX to its path.');
}

function run(exe, args) {
  try {
    return execFileSync(exe, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 });
  } catch (err) {
    const text = `${err.stdout ?? ''}${err.stderr ?? ''}`.trim().split(/\r?\n/).slice(-12).join('\n');
    throw new Error(`${exe} ${args[0]} failed:\n${text}`);
  }
}

/** AppxManifest.xml out of a package, without unpacking all of it (tar.exe, which ships with Windows, reads zip). */
export function readManifest(appx) {
  const tar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
  return run(tar, ['-xOf', appx, 'AppxManifest.xml']);
}

/** Patch a package in place. Returns false if it already was. The original is only replaced by a package that checked out. */
export function patchAppx(appx, makeappx = findMakeAppx()) {
  if (isPatched(readManifest(appx))) return false;
  const work = mkdtempSync(join(tmpdir(), 'encore-appx-'));
  try {
    const layout = join(work, 'layout');
    run(makeappx, ['unpack', '/p', appx, '/d', layout, '/o']);
    const manifest = join(layout, 'AppxManifest.xml');
    writeFileSync(manifest, patchManifest(readFileSync(manifest, 'utf8')));
    const out = join(work, 'patched.appx');
    run(makeappx, ['pack', '/d', layout, '/p', out, '/o']); // no /nv: makeappx checks the manifest against the schema
    if (!isPatched(readManifest(out))) throw new Error('The repacked package does not carry the patch.');
    copyFileSync(out, appx);
    return true;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function main(argv) {
  const check = argv.includes('--check');
  let files = argv.filter((a) => !a.startsWith('--')).map((f) => resolve(f));
  if (!files.length) {
    const release = resolve(fileURLToPath(new URL('..', import.meta.url)), 'release');
    files = existsSync(release) ? readdirSync(release).filter((f) => f.endsWith('.appx')).map((f) => join(release, f)) : [];
  }
  if (!files.length) throw new Error('No .appx to patch. Build one first (npx electron-builder --win appx), or name the file.');
  let bad = 0;
  for (const file of files) {
    if (check) {
      const ok = isPatched(readManifest(file));
      console.log(`${ok ? 'patched    ' : 'NOT PATCHED'}  ${file}`);
      if (!ok) bad++;
    } else {
      console.log(`${patchAppx(file) ? 'patched' : 'already patched'}: ${file}`);
    }
  }
  if (bad) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
