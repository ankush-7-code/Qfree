import { execSync } from 'node:child_process';
import 'dotenv/config';

/** Bring the test database schema up to date once per run. */
export default function setup() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL must be set to run tests (see .env.example)');
  execSync('npx prisma migrate deploy', { stdio: 'inherit', env: { ...process.env, DATABASE_URL: url } });
}
