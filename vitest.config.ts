import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'firestore.rules.test.ts'],
    exclude: ['src/miniapp/imagePrep.test.ts', 'node_modules/**'],
    testTimeout: 15000,
    hookTimeout: 30000,
  },
});
