import { query } from './pool';
import logger from '../utils/logger';

/**
 * Database migration runner.
 *
 * A lightweight sequential migration system — no external dependency needed
 * for an MVP. For production, consider Flyway or node-pg-migrate which
 * offer checksums, rollbacks, and team coordination.
 *
 * Migrations are idempotent: they use CREATE IF NOT EXISTS / DO $$ guards
 * so re-running is always safe.
 */

const migrations: Array<{ name: string; sql: string }> = [
  {
    name: '001_create_image_jobs',
    sql: `
      -- Enable pgcrypto for gen_random_uuid()
      CREATE EXTENSION IF NOT EXISTS pgcrypto;

      -- Status enum — using a real Postgres ENUM rather than a CHECK constraint
      -- because ENUM gives us a typed, self-documenting column in pg_type.
      DO $$ BEGIN
        CREATE TYPE job_status AS ENUM ('pending', 'processing', 'completed', 'failed');
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;

      CREATE TABLE IF NOT EXISTS image_jobs (
        id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        original_name     VARCHAR(255) NOT NULL,
        file_path         TEXT         NOT NULL,
        mime_type         VARCHAR(100) NOT NULL,
        file_size_bytes   INTEGER      NOT NULL,
        status            job_status   NOT NULL DEFAULT 'pending',
        failure_reason    TEXT,
        retry_count       INTEGER      NOT NULL DEFAULT 0,
        quality_score     FLOAT,
        perceptual_hash   VARCHAR(64),           -- stored for duplicate detection
        created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
        updated_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
        processed_at      TIMESTAMPTZ
      );

      -- Indexes
      CREATE INDEX IF NOT EXISTS idx_image_jobs_status     ON image_jobs(status);
      CREATE INDEX IF NOT EXISTS idx_image_jobs_created_at ON image_jobs(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_image_jobs_phash      ON image_jobs(perceptual_hash)
        WHERE perceptual_hash IS NOT NULL;
    `,
  },
  {
    name: '002_create_analysis_results',
    sql: `
      CREATE TABLE IF NOT EXISTS analysis_results (
        id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        job_id      UUID        NOT NULL REFERENCES image_jobs(id) ON DELETE CASCADE,
        check_name  VARCHAR(100) NOT NULL,
        passed      BOOLEAN      NOT NULL,
        confidence  FLOAT,
        details     JSONB,
        created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS idx_analysis_results_job_id ON analysis_results(job_id);
    `,
  },
  {
    name: '003_updated_at_trigger',
    sql: `
      -- Trigger function: auto-update updated_at on any row change.
      -- Application-level hooks are simpler but can be forgotten; a DB trigger
      -- is the safest guarantee regardless of which code path writes.
      CREATE OR REPLACE FUNCTION set_updated_at()
      RETURNS TRIGGER AS $$
      BEGIN
        NEW.updated_at = now();
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS trg_image_jobs_updated_at ON image_jobs;

      CREATE TRIGGER trg_image_jobs_updated_at
        BEFORE UPDATE ON image_jobs
        FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    `,
  },
  {
    name: '004_migrations_table',
    sql: `
      -- Track which migrations have run.
      CREATE TABLE IF NOT EXISTS _migrations (
        name       VARCHAR(255) PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `,
  },
  {
    name: '005_create_image_hashes',
    sql: `
      CREATE TABLE IF NOT EXISTS image_hashes (
        id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        job_id     UUID NOT NULL REFERENCES image_jobs(id) ON DELETE CASCADE,
        md5_hash   VARCHAR(32) NOT NULL,
        d_hash     VARCHAR(16) NOT NULL,
        created_at TIMESTAMPTZ DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_image_hashes_md5  ON image_hashes(md5_hash);
      CREATE INDEX IF NOT EXISTS idx_image_hashes_job  ON image_hashes(job_id);
    `,
  },
];

export async function runMigrations(): Promise<void> {
  logger.info('Running database migrations…');

  // Bootstrap the migrations tracking table first
  await query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name       VARCHAR(255) PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  const { rows: applied } = await query<{ name: string }>('SELECT name FROM _migrations');
  const appliedNames = new Set(applied.map((r) => r.name));

  for (const migration of migrations) {
    if (appliedNames.has(migration.name)) {
      logger.debug({ migration: migration.name }, 'Migration already applied, skipping');
      continue;
    }

    logger.info({ migration: migration.name }, 'Applying migration…');
    await query(migration.sql);
    await query('INSERT INTO _migrations(name) VALUES($1)', [migration.name]);
    logger.info({ migration: migration.name }, 'Migration applied ✓');
  }

  logger.info('All migrations complete');
}

// Allow running directly: ts-node src/db/migrate.ts
if (require.main === module) {
  import('dotenv').then(({ config }) => {
    config();
    runMigrations()
      .then(() => process.exit(0))
      .catch((err) => {
        logger.error({ err }, 'Migration failed');
        process.exit(1);
      });
  });
}
