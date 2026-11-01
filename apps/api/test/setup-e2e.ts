import { config } from 'dotenv';

config({ path: '.env.test', quiet: true });

if (!process.env.E2E_DATABASE_URL) {
  throw new Error(
    'Set E2E_DATABASE_URL in .env.test or the environment. Apply Prisma migrations to that test database before running test:e2e.',
  );
}
