import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';
import { unstable_getMiniflareWorkerOptions } from 'wrangler';

process.env.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV = 'false';
process.env.CLOUDFLARE_INCLUDE_PROCESS_ENV = 'false';
const safeOptions = { envFiles: ['./tests/setup.ts'], overrides: { enableContainers: false } };
const { workerOptions, main } = unstable_getMiniflareWorkerOptions('./wrangler.toml', 'dev', safeOptions);
const workerBindings = (workerOptions as { bindings?: Record<string, unknown> }).bindings ?? {};
const baseWorkerOptions = workerOptions as Record<string, unknown>;

export default defineConfig({
  envDir: false,
  plugins: [cloudflareTest({
    main,
    remoteBindings: false,
    miniflare: {
      ...baseWorkerOptions,
      bindings: { ...workerBindings, TEST_MIGRATIONS: await readD1Migrations('./migrations') },
    },
  })],
  test: {
    include: ['tests/**/*.test.ts'],
    setupFiles: ['./tests/setup.ts'],
    fileParallelism: false,
    restoreMocks: true,
  },
});
