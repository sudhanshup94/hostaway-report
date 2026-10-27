#!/usr/bin/env node

// Inspection only - writes nothing, changes nothing. Answers the questions the
// portfolio report depends on:
//   1. which reservation field carries the creation timestamp, and in what timezone
//   2. the exact finance calculated-field names
//   3. how many reservations each bucket needs finance data for (sizing the fan-out)
//   4. whether one calendar call covers a full two-month range

const https = require('https');

const ACCOUNT_ID = process.env.HOSTAWAY_ACCOUNT_ID;
const API_KEY = process.env.HOSTAWAY_API_KEY;
const EXCLUDED_LISTINGS = [488785];
const OK_STATUS = ['active', 'confirmed', 'new', 'modified'];

function req(path, token) {
  return new Promise((resolve, reject) => {
    const r = https.request({
      hostname: 'api.hostaway.com', path, method: 'GET',
      headers: { Authorization: `Bearer ${token}` }, timeout: 90000,
    }, (res) => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(b); } });
    });
    r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); });
    r.on('error', reject); r.end();
  });
}

function getToken() {
  const body = `grant_type=client_credentials&client_id=${ACCOUNT_ID}&client_secret=${API_KEY}&scope=general`;
  return new Promise((resolve, reject) => {
    const r = https.request({
      hostname: 'api.hostaway.com', path: '/v1/accessTokens', method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { const j = JSON.parse(d); j.access_token ? resolve(j.access_token) : reject(new Error(d)); });
    });
    r.on('error', reject); r.write(body); r.end();
  });
}

// IST helpers, mirroring the report's conventions.
const istToday = () => process.env.REPORT_DATE || new Intl.DateTimeFormat('en-CA', {
  year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'Asia/Kolkata' }).format(new Date());
const ymd = (s) => String(s).slice(0, 10);
const monthStart = (d) => d.slice(0, 7) + '-01';
const addMonth = (ym, n) => {
  let [y, m] = ym.split('-').map(Number);
  m += n; y += Math.floor((m - 1) / 12); m = ((m - 1) % 12 + 12) % 12 + 1;
  return `${y}-${String(m).padStart(2, '0')}`;
};
const lastDay = (ym) => {
  const [y, m] = ym.split('-').map(Number);
  return `${ym}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
};

(async () => {
  const token = await getToken();
  const today = istToday();
  const curM = today.slice(0, 7);
  const nextM = addMonth(curM, 1);
  const curStart = monthStart(today), curEnd = lastDay(curM);
  const nextStart = `${nextM}-01`, nextEnd = lastDay(nextM);

  console.log(`\n${'='.repeat(72)}\nPORTFOLIO REPORT - API INSPECTION\n${'='.repeat(72)}`);
  console.log(`today(IST)=${today}  current=${curStart}..${curEnd}  next=${nextStart}..${nextEnd}\n`);

  // ---- 1. reservation shape -------------------------------------------------
  const sample = await req(`/v1/reservations?accountId=${ACCOUNT_ID}&limit=3`, token);
  const r0 = (sample?.result || [])[0];
  if (!r0) { console.log('No reservations returned; cannot inspect shape.'); return; }

  console.log('1. RESERVATION FIELDS (all keys)');
  console.log('-'.repeat(72));
  console.log(Object.keys(r0).sort().join(', '));

  console.log('\n   date/time-looking fields on a sample reservation:');
  for (const [k, v] of Object.entries(r0)) {
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) {
      console.log(`     ${k.padEnd(28)} = ${v}`);
    }
  }

  // ---- 2. finance field names ----------------------------------------------
  console.log('\n2. FINANCE CALCULATED FIELDS');
  console.log('-'.repeat(72));
  const fin = await req(`/v1/financeCalculatedField/reservation/${r0.id}?accountId=${ACCOUNT_ID}`, token);
  (fin?.result || []).forEach(f => console.log(`     ${String(f.formulaName).padEnd(28)} = ${f.formulaResult}`));

  // ---- 3. volume sizing -----------------------------------------------------
  console.log('\n3. RESERVATION VOLUME (departureDateFrom = current month start)');
  console.log('-'.repeat(72));
  let all = [];
  const t0 = Date.now();
  for (let offset = 0; ; offset += 500) {
    const res = await req(`/v1/reservations?accountId=${ACCOUNT_ID}&departureDateFrom=${curStart}&limit=500&offset=${offset}`, token);
    const batch = res?.result || [];
    all = all.concat(batch);
    if (batch.length < 500) break;
    if (offset > 100000) { console.log('     (safety stop)'); break; }
  }
  console.log(`     fetched ${all.length} reservations in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const eligible = all.filter(r =>
    !EXCLUDED_LISTINGS.includes(r.listingMapId) &&
    OK_STATUS.includes(String(r.status).toLowerCase()));
  console.log(`     eligible (status + not excluded listing): ${eligible.length}`);

  const overlaps = (r, s, e) => ymd(r.arrivalDate) <= e && ymd(r.departureDate) > s;
  const inCur = eligible.filter(r => overlaps(r, curStart, curEnd));
  const inNext = eligible.filter(r => overlaps(r, nextStart, nextEnd));
  const union = new Set([...inCur, ...inNext].map(r => r.id));
  console.log(`     overlapping current month : ${inCur.length}`);
  console.log(`     overlapping next month    : ${inNext.length}`);
  console.log(`     union needing finance     : ${union.size}`);

  // creation-date buckets, tried against every plausible field name
  const candidates = ['insertedOn', 'reservationDate', 'createdAt', 'created', 'bookingDate', 'latestActivityOn'];
  console.log('\n   creation-timestamp candidates (count created since month start):');
  for (const c of candidates) {
    if (!(c in r0)) { console.log(`     ${c.padEnd(22)} ABSENT`); continue; }
    const n = eligible.filter(r => r[c] && ymd(r[c]) >= curStart).length;
    const sampleVals = eligible.filter(r => r[c]).slice(0, 2).map(r => r[c]);
    console.log(`     ${c.padEnd(22)} present, ${n} since ${curStart}   e.g. ${sampleVals.join(' | ')}`);
  }

  // ---- 4. calendar range ----------------------------------------------------
  console.log('\n4. CALENDAR over a full two-month range');
  console.log('-'.repeat(72));
  const lres = await req(`/v1/listings?accountId=${ACCOUNT_ID}&limit=1`, token);
  const lid = (lres?.result || [])[0]?.id;
  const cal = await req(`/v1/listings/${lid}/calendar?accountId=${ACCOUNT_ID}&startDate=${curStart}&endDate=${nextEnd}`, token);
  const days = cal?.result || [];
  const expected = (new Date(nextEnd) - new Date(curStart)) / 86400000 + 1;
  console.log(`     listing ${lid}: requested ${curStart}..${nextEnd} (${expected} days), got ${days.length} entries`);
  console.log(`     first=${days[0]?.date}  last=${days[days.length - 1]?.date}`);
  console.log(`     distinct statuses: ${[...new Set(days.map(d => d.status))].join(', ')}`);
  console.log(`     sample entry keys: ${Object.keys(days[0] || {}).join(', ')}`);

  console.log('\n' + '='.repeat(72) + '\n');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
