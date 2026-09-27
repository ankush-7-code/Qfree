/**
 * Local PostgreSQL for development without Docker or a system install.
 * Runs a real PostgreSQL server (embedded-postgres binaries) in ./.pgdata.
 *
 *   npm run db:dev            -> starts on port 54329 and keeps running
 *
 * Use any external PostgreSQL instead by pointing DATABASE_URL at it.
 */
import EmbeddedPostgres from 'embedded-postgres';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const port = Number(process.env.DEV_DB_PORT ?? 54329);
const databaseDir = resolve(process.env.DEV_DB_DIR ?? '.pgdata');
const databases = (process.env.DEV_DB_NAMES ?? 'qfree,qfree_test').split(',');

const pg = new EmbeddedPostgres({
  databaseDir,
  user: 'postgres',
  password: 'postgres',
  port,
  persistent: true,
  initdbFlags: ['--encoding=UTF8', '--locale=C'],
  onLog: () => {},
});

const fresh = !existsSync(databaseDir);
if (fresh) await pg.initialise();
await pg.start();
for (const name of databases) {
  try {
    await pg.createDatabase(name);
    console.log(`created database ${name}`);
  } catch {
    /* already exists */
  }
}
console.log(`PostgreSQL ready on postgresql://postgres:postgres@localhost:${port} (data: ${databaseDir})`);
console.log('Press Ctrl+C to stop.');

const shutdown = async () => {
  await pg.stop();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
setInterval(() => {}, 1 << 30);
