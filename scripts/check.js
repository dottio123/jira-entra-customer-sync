/* global require, process, console */
/* eslint-disable @typescript-eslint/no-require-imports */
// Full verification pipeline: format, lint, type-check (source and tests), test, build.
const { execFileSync } = require('child_process');

// Node 26 needs this V8 flag for the lint and test steps; older versions don't support it.
const isNode26 = process.version.startsWith('v26.');
const zoneArgs = isNode26 ? ['--managed-zone-memory'] : [];
const nodeV8Args = [...zoneArgs, '--max-old-space-size=4096'];
const tsc = './node_modules/typescript/bin/tsc';

const steps = [
  { name: 'format:check', args: ['./node_modules/prettier/bin/prettier.cjs', '--check', '.'] },
  { name: 'lint', args: [...nodeV8Args, './node_modules/eslint/bin/eslint.js', '.'] },
  { name: 'typecheck', args: [tsc, '--noEmit'] },
  { name: 'typecheck:tests', args: [tsc, '--noEmit', '-p', 'tsconfig.test.json'] },
  {
    name: 'test',
    args: [...nodeV8Args, './node_modules/vitest/vitest.mjs', 'run', '--configLoader=native'],
  },
  { name: 'build', args: [tsc] },
];

for (const step of steps) {
  console.log(`\n> Running ${step.name}...`);
  try {
    execFileSync(process.execPath, step.args, { stdio: 'inherit' });
  } catch (err) {
    console.error(`Step ${step.name} failed`);
    process.exit(err.status || 1);
  }
}
console.log('\nAll checks passed successfully!');
