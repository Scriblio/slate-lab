// Makes the key pair that signs and checks license passes:
//
//   npm run license:key
//
// The PRIVATE key is written to a file and never shown on screen, so it can't end up
// in a chat, a log or a commit. Paste its contents into the Supabase secret
// LICENSE_SIGNING_KEY (Dashboard -> Edge Functions -> Secrets), keep a copy somewhere
// safe (a password manager), then delete the file. Lose it and every installed copy of
// Encore has to be replaced, because they only trust the public key built into them.
//
// The PUBLIC key can only check passes, never make them. It's written into
// src/shared/license-key.ts, which ships in the app.
//
//   --out <file>   where to write the private key (default: encore-license-signing-key.txt
//                  in your home folder). Never overwrites a file.
//   --add          keep the keys already in license-key.ts and add this one (as k2, k3 ...), so
//                  copies in the field keep working while the service switches over.
//   --key-file <f> write the public key somewhere else (the tests use this).

import { generateKeyPairSync } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] ?? '') : undefined;
};
const keyFile = resolve(flag('key-file') || join(root, 'src/shared/license-key.ts'));
const out = resolve(flag('out') || join(homedir(), 'encore-license-signing-key.txt'));
const add = args.includes('--add');

if (existsSync(out)) {
  console.error(`${out} already exists, so nothing was changed. Pick another place with --out, or delete that file first.`);
  process.exit(1);
}

const keep = [];
if (add && existsSync(keyFile)) {
  for (const m of readFileSync(keyFile, 'utf8').matchAll(/\{ kid: '([^']+)', key: '([^']+)' \}/g)) keep.push({ kid: m[1], key: m[2] });
}
const kid = `k${keep.length + 1}`;

// Ed25519: `d` is the 32-byte private key and `x` the 32-byte public key, both base64url already.
const { d, x } = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' });
writeFileSync(out, `${d}\n`, { mode: 0o600, flag: 'wx' });

const keys = [...keep, { kid, key: x }];
writeFileSync(
  keyFile,
  `// The public halves of the keys that sign license passes (see supabase/functions/encore-license/pass.ts).
// A public key can only check a pass, never make one, so it is safe to ship. The private half lives only
// as the Edge Function secret LICENSE_SIGNING_KEY. \`npm run license:key\` makes a pair and writes this file.
//
// To replace a key without breaking copies already installed: \`npm run license:key -- --add\`, ship a
// release, point the service at the new key (secrets LICENSE_SIGNING_KEY and LICENSE_KEY_ID), and remove
// the old key here once the old copies are gone.

export const LICENSE_PUBLIC_KEYS: readonly { kid: string; key: string }[] = [
${keys.map((k) => `  { kid: '${k.kid}', key: '${k.key}' },`).join('\n')}
];
`,
);

console.log(`
Made key ${kid}.

  Public key   written to ${keyFile} (commit that file):
               ${x}
  Private key  written to ${out}
               It is not shown here on purpose.

Next:
  1. Open that file, copy its one line, and add it as the Edge Function secret LICENSE_SIGNING_KEY
     (Supabase Dashboard -> Edge Functions -> Secrets).${kid === 'k1' ? '' : `\n     Also set LICENSE_KEY_ID to ${kid}.`}
  2. Keep a copy somewhere safe, such as a password manager, then delete the file.
`);
