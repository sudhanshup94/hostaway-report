#!/usr/bin/env node

// Diagnostic: dump the raw financeCalculatedField response so we know the exact
// formulaName values Hostaway returns, and compare them against the CSV export.

const https = require('https');

const ACCOUNT_ID = process.env.HOSTAWAY_ACCOUNT_ID;
const API_KEY = process.env.HOSTAWAY_API_KEY;
const EXCLUDED_LISTINGS = [488785];

function req(path, token) {
  return new Promise((resolve, reject) => {
    const r = https.request({
      hostname: 'api.hostaway.com',
      path,
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      timeout: 60000,
    }, (res) => {
      let b = '';
      res.on('data', c => b += c);
      res.on('end', () => {
        try { resolve(JSON.parse(b)); } catch { resolve(b); }
      });
    });
    r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); });
    r.on('error', reject);
    r.end();
  });
}

function getToken() {
  const body = `grant_type=client_credentials&client_id=${ACCOUNT_ID}&client_secret=${API_KEY}&scope=general`;
  return new Promise((resolve, reject) => {
    const r = https.request({
      hostname: 'api.hostaway.com',
      path: '/v1/accessTokens',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        const j = JSON.parse(d);
        j.access_token ? resolve(j.access_token) : reject(new Error(d));
      });
    });
    r.on('error', reject);
    r.write(body);
    r.end();
  });
}

const todayIST = () => new Intl.DateTimeFormat('en-CA', {
  year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'Asia/Kolkata',
}).format(new Date());

const dayStr = (s) => new Date(s).toISOString().split('T')[0];

(async () => {
  const token = await getToken();
  const today = process.env.TARGET_DATE || todayIST();
  console.log(`\n=== FINANCE FIELD DIAGNOSTIC for ${today} ===\n`);

  // Pull reservations directly, account-wide, with pagination.
  let all = [];
  for (let offset = 0; ; offset += 500) {
    const res = await req(
      `/v1/reservations?accountId=${ACCOUNT_ID}&status=active,confirmed,new,modified` +
      `&departureDateFrom=${today}&arrivalDateEnd=${today}&limit=500&offset=${offset}`, token);
    const batch = res?.result || [];
    all = all.concat(batch);
    if (batch.length < 500) break;
  }
  console.log(`Reservations fetched (departure >= ${today}, arrival <= ${today}): ${all.length}`);

  const active = all.filter(r =>
    !EXCLUDED_LISTINGS.includes(r.listingMapId) &&
    dayStr(r.arrivalDate) <= today && dayStr(r.departureDate) > today);
  console.log(`Active on ${today} (excl. test listing): ${active.length}\n`);

  // Dump the full finance payload for the first few so we can read the real field names.
  for (const r of active.slice(0, 3)) {
    console.log('─'.repeat(70));
    console.log(`${r.guestName}  | res ${r.id} | ${dayStr(r.arrivalDate)} -> ${dayStr(r.departureDate)}`);
    console.log(`  totalPrice=${r.totalPrice}  cleaningFee=${r.cleaningFee}`);
    const fin = await req(`/v1/financeCalculatedField/reservation/${r.id}?accountId=${ACCOUNT_ID}`, token);
    const fields = fin?.result || [];
    console.log(`  ${fields.length} calculated fields:`);
    fields.forEach(f => console.log(`    ${String(f.formulaName).padEnd(34)} = ${f.formulaResult}`));
  }

  // Aggregate every distinct formulaName across the whole active set, summing the
  // per-night share, so we can match a column against the CSV totals directly.
  console.log('\n' + '='.repeat(70));
  console.log(`AGGREGATE (value / nights) across all ${active.length} active reservations`);
  console.log('='.repeat(70));

  const totals = {};
  for (const r of active) {
    const nights = Math.max(1, Math.round(
      (new Date(r.departureDate) - new Date(r.arrivalDate)) / 86400000));
    const fin = await req(`/v1/financeCalculatedField/reservation/${r.id}?accountId=${ACCOUNT_ID}`, token);
    for (const f of (fin?.result || [])) {
      const v = Number(f.formulaResult) || 0;
      totals[f.formulaName] = (totals[f.formulaName] || 0) + v / nights;
    }
  }
  Object.entries(totals).sort((a, b) => b[1] - a[1])
    .forEach(([k, v]) => console.log(`  ${k.padEnd(34)} ${v.toFixed(2)}`));

  console.log('\nCSV ground truth for 2026-09-08:');
  console.log('  Accommodation Fare                 250895.22');
  console.log('  PM Commission                       53279.89');
  console.log('  Cleaning Fee Value                   4526.63');
  console.log('');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
