import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [cloudflareTest(async () => ({
    wrangler: { configPath: './wrangler.jsonc' },
    miniflare: {
      bindings: { TEST_MIGRATIONS: await readD1Migrations('./migrations') },
    },
  }))],
  test: {
    include: ['tests/api*.test.ts'],
    setupFiles: ['tests/setup.ts'],
  },
});
