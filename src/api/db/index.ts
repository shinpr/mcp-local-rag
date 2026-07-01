// Database connection and Drizzle client setup (PostgreSQL)

import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'

import * as schema from './schema.js'

let _db: ReturnType<typeof drizzle<typeof schema>> | null = null
let _client: postgres.Sql | null = null

/**
 * Initialize (or return existing) Drizzle client.
 * Connects to PostgreSQL and runs schema migration.
 */
export function getDb(databaseUrl: string): ReturnType<typeof drizzle<typeof schema>> {
  if (_db) return _db

  const client = postgres(databaseUrl, {
    max: 10,
    onnotice: () => {},
  })

  _db = drizzle(client, { schema })
  _client = client

  return _db
}

/**
 * Run schema migration (async version for startup).
 * Creates tables if they don't exist using raw SQL via the postgres client.
 */
export async function migrateDb(databaseUrl: string): Promise<void> {
  const client = postgres(databaseUrl, { max: 1, onnotice: () => {} })

  try {
    await client.unsafe(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        is_active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS projects (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id),
        name TEXT NOT NULL,
        description TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE UNIQUE INDEX IF NOT EXISTS user_project_name_idx
        ON projects(user_id, name);

      CREATE TABLE IF NOT EXISTS uploaded_files (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id),
        project_id INTEGER NOT NULL REFERENCES projects(id),
        original_filename TEXT NOT NULL,
        stored_filename TEXT NOT NULL,
        file_path TEXT NOT NULL,
        file_type TEXT NOT NULL,
        file_size INTEGER NOT NULL,
        sha256_hash TEXT,
        indexing_status TEXT NOT NULL DEFAULT 'pending',
        chunk_count INTEGER NOT NULL DEFAULT 0,
        error_message TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        indexed_at TIMESTAMPTZ
      );

      CREATE TABLE IF NOT EXISTS index_jobs (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id),
        project_id INTEGER NOT NULL REFERENCES projects(id),
        status TEXT NOT NULL DEFAULT 'pending',
        files_processed INTEGER NOT NULL DEFAULT 0,
        chunks_created INTEGER NOT NULL DEFAULT 0,
        error_message TEXT,
        started_at TIMESTAMPTZ,
        finished_at TIMESTAMPTZ
      );

      CREATE TABLE IF NOT EXISTS user_settings (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id),
        embedding_provider TEXT NOT NULL DEFAULT 'local',
        api_base_url TEXT,
        api_key_encrypted TEXT,
        model_name TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE UNIQUE INDEX IF NOT EXISTS user_settings_user_id_idx
        ON user_settings(user_id);
    `)
  } finally {
    await client.end()
  }
}

/**
 * Close the database connection (for graceful shutdown / tests).
 */
export async function closeDb(): Promise<void> {
  if (_client) {
    await _client.end()
    _client = null
    _db = null
  }
}

/**
 * Reset the singleton (for testing only).
 */
export async function resetDb(): Promise<void> {
  await closeDb()
}
