import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    setupFiles: ['./test/setup-e2e.ts'],
    root: './',
    include: ['**/*.e2e-spec.ts'],
  },
});
