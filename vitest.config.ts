import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'firestore.rules.test.ts'],
    testTimeout: 15000,
  },
});
