import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    setupFiles: ['./test/setup-e2e.ts'],
    include: ['test/app.e2e-spec.ts'],
    env: { FILEMIND_E2E_VECTORS: 'real' },
  },
});
