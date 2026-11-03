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

// This compares live data against a CSV taken at some earlier moment. Bookings get
// created, extended and cancelled in between, so an exact match only happens against an
// export pulled at the same time as the run. Tighten TOLERANCE to a rupee or two when
// checking against a fresh export - that is the run that proves the arithmetic.
const TOLERANCE = Number(process.env.TOLERANCE || 100);

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

// Portfolio section. Each expectation is optional - supply only the ones you have an
// export for, and the rest are skipped.
const grabLine = (label) => {
  const m = output.match(new RegExp(`^${label}: ₹([0-9.]+)`, 'm'));
  return m ? parseFloat(m[1]) : null;
};

const grabCount = (label) => {
  const m = output.match(new RegExp(`^${label}: ([0-9]+)\\s*$`, 'm'));
  return m ? parseFloat(m[1]) : null;
};

// Nights are whole numbers, so they must match exactly; money carries the rounding
// tolerance the daily check uses.
const portfolioChecks = [
  ['Total Revenue FTM', 'Total Revenue FTM', 'EXP_FTM_REVENUE', 'money'],
  ['Total Revenue Next', 'Total Revenue Next Month', 'EXP_NEXT_REVENUE', 'money'],
  ['Cleaning Income FTM', 'Cleaning Income FTM', 'EXP_CLEAN_FTM', 'money'],
  ['Cleaning Income Next', 'Cleaning Income Next Month', 'EXP_CLEAN_NEXT', 'money'],
  ['Channel Fee FTM', 'Channel Fee FTM', 'EXP_CHANNEL_FTM', 'money'],
  ['Channel Fee Next', 'Channel Fee Next Month', 'EXP_CHANNEL_NEXT', 'money'],
  ['Margin FTM', 'Margin FTM', 'EXP_MARGIN_FTM', 'money'],
  ['Margin Next', 'Margin Next Month', 'EXP_MARGIN_NEXT', 'money'],
  ['Pickup Nights FTM', 'Pickup Nights FTM', 'EXP_PICKUP_NIGHTS_FTM', 'count'],
  ['Pickup Nights Next', 'Pickup Nights Next Month', 'EXP_PICKUP_NIGHTS_NEXT', 'count'],
  ['Pickup Nights Future', 'Pickup Nights Future Months', 'EXP_PICKUP_NIGHTS_FUTURE', 'count'],
  ['Pickup Revenue FTM', 'Pickup Revenue FTM', 'EXP_PICKUP_FTM', 'money'],
  ['Pickup Revenue Next', 'Pickup Revenue Next Month', 'EXP_PICKUP_NEXT', 'money'],
  ['Pickup Revenue Future', 'Pickup Revenue Future Months', 'EXP_PICKUP_FUTURE', 'money'],
  ['Sales from Curr Month', 'Sales from Current Month', 'EXP_SALES_MTD', 'money'],
].filter(([, , envVar]) => process.env[envVar] !== undefined && process.env[envVar] !== '');

if (portfolioChecks.length > 0) {
  console.log('\n' + '='.repeat(72));
  console.log('PORTFOLIO VERIFICATION vs HOSTAWAY EXPORT');
  console.log('='.repeat(72));
  console.log('field'.padEnd(24) + 'script'.padStart(14) + 'export'.padStart(15) + 'variance'.padStart(12));

  for (const [label, lineLabel, envVar, kind] of portfolioChecks) {
    const actual = kind === 'money' ? grabLine(lineLabel) : grabCount(lineLabel);
    const expected = parseFloat(process.env[envVar]);
    if (actual === null) {
      console.log(`${label.padEnd(24)} NOT FOUND IN OUTPUT`);
      failed = true;
      continue;
    }
    const diff = actual - expected;
    const limit = kind === 'money' ? TOLERANCE : 0;
    const ok = Math.abs(diff) <= limit;
    if (!ok) failed = true;
    const pct = expected !== 0 ? ` (${(diff / expected * 100).toFixed(2)}%)` : '';
    console.log(
      `${label.padEnd(24)} ${actual.toFixed(2).padStart(14)} ${expected.toFixed(2).padStart(14)} ` +
      `${diff.toFixed(2).padStart(11)}  ${ok ? '✓' : '✗ MISMATCH'}${ok ? '' : pct}`
    );
  }

  if (/INCOMPLETE: finance data missing/.test(output)) {
    console.log('\n✗ Portfolio finance data was incomplete - totals are understated.');
    failed = true;
  }
}

console.log('='.repeat(64));
if (failed) {
  console.error('\n✗ VERIFICATION FAILED\n');
  process.exit(1);
}
console.log('\n✓ VERIFICATION PASSED - script matches the Hostaway export.\n');
