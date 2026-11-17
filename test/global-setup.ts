import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DataSource } from 'typeorm';
import { kcAuthMigrations } from '@kc-software/nestjs-auth';

/**
 * A fresh database for every run: auth migrations, then the library's SQL —
 * exactly what an application does. Needs a PostgreSQL reachable with:
 *   KC_SUPORTE_TEST_DB_HOST, _PORT, _USER, _PASSWORD  (defaults: localhost:5432, postgres)
 */
export const BASE = 'kc_suporte_test';

export function ligacao(database: string) {
  return {
    type: 'postgres' as const,
    host: process.env.KC_SUPORTE_TEST_DB_HOST ?? 'localhost',
    port: Number(process.env.KC_SUPORTE_TEST_DB_PORT ?? 5432),
    username: process.env.KC_SUPORTE_TEST_DB_USER ?? 'postgres',
    password: process.env.KC_SUPORTE_TEST_DB_PASSWORD ?? 'postgres',
    database,
  };
}

export default async function globalSetup(): Promise<void> {
  const admin = new DataSource(ligacao('postgres'));
  await admin.initialize();
  await admin.query(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
    [BASE],
  );
  await admin.query(`DROP DATABASE IF EXISTS ${BASE}`);
  await admin.query(`CREATE DATABASE ${BASE}`);
  await admin.destroy();

  const ds = new DataSource({ ...ligacao(BASE), migrations: kcAuthMigrations });
  await ds.initialize();
  await ds.runMigrations();
  await ds.query(readFileSync(join(__dirname, '..', 'sql', '001_kc_suporte.sql'), 'utf8'));
  await ds.destroy();
}
