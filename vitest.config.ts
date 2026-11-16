import { defineConfig } from 'vitest/config';

const isNode26 = process.version.startsWith('v26.');

export default defineConfig({
  test: {
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
        execArgv: isNode26 ? ['--managed-zone-memory'] : [],
      },
    },
    fileParallelism: false,
    testTimeout: 10000,
  },
});
