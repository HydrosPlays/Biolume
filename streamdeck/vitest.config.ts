import { defineConfig } from 'vitest/config';

/** The plugin's own tests (run with `npm test` here, or `npm run streamdeck:test` from the repo root). */
export default defineConfig({
  test: {
    name: 'streamdeck',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
