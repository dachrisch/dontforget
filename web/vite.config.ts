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
      // Trailing slash matters: a bare '/f' prefix-matches any path
      // starting with those two characters, including /fonts/*, which
      // Vite would then proxy to the backend (404) instead of serving
      // from public/. Feed URLs are always /f/<token>, so this is safe.
      '/f/': 'http://localhost:3000',
    },
  },
});