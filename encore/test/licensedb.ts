// The licensing migration, run for real in an in-process Postgres (PGlite), set up
// the way a Supabase project is: the same roles, an auth.users table, auth.uid(),
// and the default grants Supabase gives new tables and functions in `public`.

import { PGlite } from '@electric-sql/pglite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS = join(import.meta.dirname, '..', 'supabase', 'migrations');

const SUPABASE = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  create schema auth;
  create table auth.users (id uuid primary key default gen_random_uuid(), email text unique);
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema public, auth to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
`;

export function licensingMigration(): string {
  const file = readdirSync(MIGRATIONS).find((f) => f.endsWith('_licensing.sql'));
  if (!file) throw new Error('the licensing migration is missing');
  return readFileSync(join(MIGRATIONS, file), 'utf8');
}

export interface TestDb {
  db: PGlite;
  rows<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  /** One value: the first column of the first row. */
  value<T = unknown>(sql: string, params?: unknown[]): Promise<T>;
  addUser(email: string): Promise<string>;
  /** Run something as a database role (as the public keys and the service do), then go back to being the owner. */
  as<T>(role: 'anon' | 'authenticated' | 'service_role', fn: () => Promise<T>, user?: string): Promise<T>;
}

export async function openLicenseDb(): Promise<TestDb> {
  const db = new PGlite();
  await db.exec(SUPABASE);
  await db.exec(licensingMigration());
  const rows = async <T>(sql: string, params?: unknown[]) => (await db.query<T>(sql, params)).rows;
  return {
    db,
    rows,
    value: async <T>(sql: string, params?: unknown[]) => Object.values((await rows<Record<string, unknown>>(sql, params))[0] ?? {})[0] as T,
    async addUser(email) {
      return (await rows<{ id: string }>('insert into auth.users (email) values ($1) returning id', [email]))[0]!.id;
    },
    async as(role, fn, user) {
      await db.exec(`set role ${role}`);
      if (user) await db.exec(`set request.jwt.claim.sub = '${user}'`);
      try {
        return await fn();
      } finally {
        await db.exec('reset role');
        await db.exec("set request.jwt.claim.sub = ''");
      }
    },
  };
}
