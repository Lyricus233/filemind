import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['test/vectors.e2e-spec.ts'],
    hookTimeout: 30000,
  },
});
