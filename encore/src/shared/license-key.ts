// The public halves of the keys that sign license passes (see supabase/functions/encore-license/pass.ts).
// A public key can only check a pass, never make one, so it is safe to ship. The private half lives only
// as the Edge Function secret LICENSE_SIGNING_KEY. `npm run license:key` makes a pair and writes this file.
//
// To replace a key without breaking copies already installed: `npm run license:key -- --add`, ship a
// release, point the service at the new key (secrets LICENSE_SIGNING_KEY and LICENSE_KEY_ID), and remove
// the old key here once the old copies are gone.

export const LICENSE_PUBLIC_KEYS: readonly { kid: string; key: string }[] = [
  { kid: 'k1', key: 'z-SwdZsEv9OXL_W8fEhQ5fgmL_RIAzFOROrV5rHqv-s' },
];
