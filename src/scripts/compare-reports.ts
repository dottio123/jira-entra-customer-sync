#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { compareDryRunReports } from '../services/report-comparator';

function main() {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error('Usage: tsx src/scripts/compare-reports.ts <reportA.json> <reportB.json>');
    process.exit(1);
  }

  const pathA = args[0]!;
  const pathB = args[1]!;

  if (!fs.existsSync(pathA)) {
    console.error(`Error: Report file not found: ${pathA}`);
    process.exit(1);
  }

  if (!fs.existsSync(pathB)) {
    console.error(`Error: Report file not found: ${pathB}`);
    process.exit(1);
  }

  const reportA = JSON.parse(fs.readFileSync(pathA, 'utf8'));
  const reportB = JSON.parse(fs.readFileSync(pathB, 'utf8'));

  const result = compareDryRunReports(reportA, reportB);

  console.log('=== Dry-Run Reports Consistency Comparison ===');
  console.log(`Report A: ${path.basename(pathA)} (${result.recordsInRunA} records)`);
  console.log(`Report B: ${path.basename(pathB)} (${result.recordsInRunB} records)`);
  console.log(`Records in Both: ${result.recordsInBoth}`);
  console.log(`Records Added: ${result.recordsAdded}`);
  console.log(`Records Removed: ${result.recordsRemoved}`);
  console.log(`Records with Category Changes: ${result.recordsWithCategoryChanges}`);
  console.log(`Records with Field Set Changes: ${result.recordsWithFieldSetChanges}`);
  console.log(
    `Consistent: ${result.isConsistent ? 'YES (Identical Plan)' : 'NO (Differences Detected)'}`,
  );

  if (result.differences.length > 0) {
    console.log(`\nDifferences Found (${result.differences.length} records):`);
    for (const diff of result.differences) {
      console.log(`- Ref: ${diff.customerRef}`);
      if (diff.categoryChanged) {
        console.log(`  Category: ${diff.categoryInA ?? 'NONE'} -> ${diff.categoryInB ?? 'NONE'}`);
      }
      if (diff.fieldSetChanged) {
        console.log(`  Fields A: [${diff.fieldsInA?.join(', ') ?? ''}]`);
        console.log(`  Fields B: [${diff.fieldsInB?.join(', ') ?? ''}]`);
      }
    }
  }
}

main();
