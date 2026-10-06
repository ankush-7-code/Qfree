/**
 * Production entry point (`npm run start:prod`), optimised for fast cold starts on small hosts:
 *  1. Run `prisma migrate deploy` only if a migration folder isn't recorded as applied yet
 *     (the CLI alone takes many seconds to start, which every wake-up would otherwise pay).
 *  2. Start the API.
 *  3. If SEED_DEMO=true and the demo data is out of date, update it in the background, after the
 *     API is already answering.
 */
import 'dotenv/config';
import { spawn, spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import pg from 'pg';

const root = new URL('../', import.meta.url);
const migrationNames = readdirSync(new URL('prisma/migrations/', root), { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);
const demoVersion = JSON.parse(readFileSync(new URL('prisma/demo-version.json', root), 'utf8')).version;

async function databaseState() {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  try {
    await client.connect();
    const applied = await client
      .query('SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL')
      .then((r) => new Set(r.rows.map((x) => x.migration_name)))
      .catch(() => new Set()); // table missing: brand-new database
    const demo = await client
      .query(`SELECT value FROM system_settings WHERE key = 'demo.version'`)
      .then((r) => r.rows[0]?.value?.version ?? null)
      .catch(() => null);
    return { pendingMigrations: migrationNames.filter((n) => !applied.has(n)), demo };
  } catch (err) {
    console.error('start: could not inspect the database, running migrations to be safe:', err.message);
    return { pendingMigrations: migrationNames, demo: null };
  } finally {
    await client.end().catch(() => {});
  }
}

const state = await databaseState();
if (state.pendingMigrations.length) {
  console.log(`start: applying ${state.pendingMigrations.length} migration(s)`);
  const result = spawnSync('npx', ['prisma', 'migrate', 'deploy'], { stdio: 'inherit', shell: true });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

await import('../dist/index.js');

if (process.env.SEED_DEMO === 'true' && state.demo !== demoVersion) {
  console.log(`start: updating demo data in the background (have ${state.demo ?? 'none'}, want ${demoVersion})`);
  spawn('npx', ['tsx', 'prisma/seed.ts', '--auto'], { stdio: 'inherit', shell: true }).on('exit', (code) => {
    if (code) console.error(`start: demo data update exited with code ${code}`);
  });
}
