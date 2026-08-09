import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts'],
    reporters: ['default', 'junit'],
    outputFile: {
      junit: 'test-results/junit.xml',
    },
  },
  server: {
    proxy: {
      '/api': 'http://localhost:3000',
      '/f': 'http://localhost:3000',
    },
  },
});