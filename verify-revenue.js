#!/usr/bin/env node

// Compares the revenue totals printed by hostaway-report.js against the figures from a
// Hostaway reservations CSV export. Exits non-zero when they disagree.

const fs = require('fs');

const output = fs.readFileSync(process.argv[2], 'utf-8');

const grab = (label) => {
  const m = output.match(new RegExp(`✓ ${label}: ₹([0-9.]+)`));
  return m ? parseFloat(m[1]) : null;
};

const checks = [
  ['Accommodation Fare', grab('Accommodation Fare'), parseFloat(process.env.EXP_ACC)],
  ['PM Commission', grab('PM Commission'), parseFloat(process.env.EXP_PM)],
  ['Cleaning Fee', grab('Cleaning Fee'), parseFloat(process.env.EXP_CLEAN)],
];

// Hostaway rounds each reservation's per-night share to 2dp before summing; we divide at
// full precision. Across ~35 reservations that drifts by a few rupees at most.
const TOLERANCE = 1.0;

console.log('\n' + '='.repeat(64));
console.log('REVENUE VERIFICATION vs HOSTAWAY EXPORT');
console.log('='.repeat(64));
console.log('field'.padEnd(22) + 'script'.padStart(14) + 'export'.padStart(15) + 'diff'.padStart(11));

let failed = false;
for (const [label, actual, expected] of checks) {
  if (actual === null) {
    console.log(`${label.padEnd(22)} NOT FOUND IN OUTPUT`);
    failed = true;
    continue;
  }
  const diff = actual - expected;
  const ok = Math.abs(diff) <= TOLERANCE;
  if (!ok) failed = true;
  console.log(
    `${label.padEnd(22)} ${actual.toFixed(2).padStart(14)} ${expected.toFixed(2).padStart(14)} ` +
    `${diff.toFixed(2).padStart(10)}  ${ok ? '✓' : '✗ MISMATCH'}`
  );
}

if (/FINANCE DATA INCOMPLETE/.test(output)) {
  console.log('\n✗ Finance data was incomplete - totals are understated.');
  failed = true;
}

console.log('='.repeat(64));
if (failed) {
  console.error('\n✗ VERIFICATION FAILED\n');
  process.exit(1);
}
console.log('\n✓ VERIFICATION PASSED - script matches the Hostaway export.\n');
