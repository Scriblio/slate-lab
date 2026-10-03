// The online join link. Phones open a secure page at JOIN_ORIGIN, and it
// talks to the KJ's laptop through Supabase Realtime. Everything sent is
// end-to-end encrypted (see relay.ts), so the relay only ever carries
// ciphertext.
//
// The Supabase URL and publishable key are public by design (they ship
// inside every web page that uses them). Leave them empty to turn the
// online link off and use the local Wi-Fi link only.

export const CLOUD = {
  joinOrigin: 'https://sing.scriblio.co',
  // Supabase project "encore" (Scriblio org). Publishable key: safe to ship.
  supabaseUrl: 'https://oohgawkfnwhjlqlihhju.supabase.co',
  supabaseKey: 'sb_publishable_izlrNWtAjB1ilWhDeArfqA_p80ODhal',
};

export function cloudConfigured(c: { supabaseUrl: string; supabaseKey: string } = CLOUD): boolean {
  return Boolean(c.supabaseUrl && c.supabaseKey);
}
