#!/usr/bin/env node

// Dumps per-reservation cleaning-fee candidates for one date so they can be joined
// against a Hostaway CSV export and the right source field identified.

const https = require('https');

const ACCOUNT_ID = process.env.HOSTAWAY_ACCOUNT_ID;
const API_KEY = process.env.HOSTAWAY_API_KEY;
const TARGET = process.env.TARGET_DATE;
const EXCLUDED_LISTINGS = [488785];

function req(path, token) {
  return new Promise((resolve, reject) => {
    const r = https.request({
      hostname: 'api.hostaway.com', path, method: 'GET',
      headers: { Authorization: `Bearer ${token}` }, timeout: 60000,
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

const day = (s) => new Date(s).toISOString().split('T')[0];
const OK = ['active', 'confirmed', 'new', 'modified'];

(async () => {
  const token = await getToken();

  let all = [];
  for (let offset = 0; ; offset += 500) {
    const res = await req(`/v1/reservations?accountId=${ACCOUNT_ID}&departureDateFrom=${TARGET}&limit=500&offset=${offset}`, token);
    const batch = res?.result || [];
    all = all.concat(batch);
    if (batch.length < 500) break;
  }

  const active = all.filter(r =>
    !EXCLUDED_LISTINGS.includes(r.listingMapId) &&
    OK.includes(String(r.status).toLowerCase()) &&
    day(r.arrivalDate) <= TARGET && day(r.departureDate) > TARGET);

  console.log(`ACTIVE=${active.length}`);
  console.log('GUEST\tLISTING\tCHANNEL\tNIGHTS\tcleaningFee\ttotalGuestFees\tcleanPerNight');

  for (const r of active) {
    const nights = Math.max(1, Math.round((new Date(r.departureDate) - new Date(r.arrivalDate)) / 86400000));
    const fin = await req(`/v1/financeCalculatedField/reservation/${r.id}?accountId=${ACCOUNT_ID}`, token);
    const f = (n) => { const x = (fin?.result || []).find(v => v.formulaName === n); return x ? Number(x.formulaResult) || 0 : 0; };
    console.log([
      r.guestName, r.listingMapId, r.channelName, nights,
      Number(r.cleaningFee) || 0,
      f('totalGuestFees'),
      ((Number(r.cleaningFee) || 0) / nights).toFixed(2),
    ].join('\t'));
  }
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
