#!/usr/bin/env node

// Read-only. Explains a single day's occupancy figure by showing how every unit was
// classified and what the underlying guest reservations look like. Writes nothing,
// sends nothing, changes nothing.
//
// The classification below is copied from calculateTodayOccupancy() in
// hostaway-report.js so the totals printed here must tie out to the emailed report.
// If they ever disagree, the copy has drifted and that is itself the finding.
//
// No guest names, emails or phone numbers are printed.

const https = require('https');

const ACCOUNT_ID = process.env.HOSTAWAY_ACCOUNT_ID;
const API_KEY = process.env.HOSTAWAY_API_KEY;
const EXCLUDED_LISTINGS = [488785];
const OK_STATUS = ['active', 'confirmed', 'new', 'modified'];
const DATE = process.env.REPORT_DATE;

if (!DATE) { console.error('REPORT_DATE is required (YYYY-MM-DD)'); process.exit(1); }

const agent = new https.Agent({ keepAlive: true, maxSockets: 10 });

function req(path, token, tries = 3) {
  return new Promise((resolve) => {
    const r = https.request({
      hostname: 'api.hostaway.com', path, method: 'GET', agent,
      headers: { Authorization: `Bearer ${token}` }, timeout: 90000,
    }, (res) => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve({}); } });
    });
    const retry = () => { r.destroy(); tries > 1 ? resolve(req(path, token, tries - 1)) : resolve({}); };
    r.on('timeout', retry);
    r.on('error', retry);
    r.end();
  });
}

function limit(n) {
  let active = 0; const queue = [];
  const next = () => { if (active >= n || !queue.length) return; active++; queue.shift()(); };
  return (fn) => new Promise((resolve, reject) => {
    queue.push(() => fn().then(resolve, reject).finally(() => { active--; next(); }));
    next();
  });
}

const dayOf = (v) => new Date(v).toISOString().split('T')[0];
const activeOn = (r, d) => dayOf(r.arrivalDate) <= d && dayOf(r.departureDate) > d;
const isGuestStatus = (r) => OK_STATUS.includes((r.status || '').toLowerCase());
const isOwner = (r) => {
  const c = (r.channelName || '').toLowerCase();
  return c.includes('owner') || c.includes('homeowner');
};
const nightsOf = (r) => Math.max(1, Math.ceil((new Date(r.departureDate) - new Date(r.arrivalDate)) / 86400000));

(async () => {
  const token = await new Promise((resolve, reject) => {
    const body = `grant_type=client_credentials&client_id=${ACCOUNT_ID}&client_secret=${API_KEY}&scope=general`;
    const r = https.request({
      hostname: 'api.hostaway.com', path: '/v1/accessTokens', method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cache-control': 'no-cache', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve(JSON.parse(b).access_token)); });
    r.on('error', reject); r.write(body); r.end();
  });

  console.log(`\nSPIKE DIAGNOSTIC for ${DATE} (read-only)\n${'='.repeat(70)}`);

  // Listings
  let listings = [];
  for (let off = 0; ; off += 500) {
    const res = await req(`/v1/listings?accountId=${ACCOUNT_ID}&limit=500&offset=${off}`, token);
    const page = res.result || [];
    listings.push(...page);
    if (page.length < 500) break;
  }
  const total = listings.length;
  const included = listings.filter(l => !EXCLUDED_LISTINGS.includes(l.id));
  console.log(`Listings returned by API: ${total}`);
  console.log(`Excluded by EXCLUDED_LISTINGS: ${total - included.length} (${EXCLUDED_LISTINGS.join(', ')})`);
  console.log(`Included units: ${included.length}`);

  // Duplicate detection across the included set
  const byName = new Map();
  included.forEach(l => {
    const key = (l.internalListingName || l.name || '').trim().toLowerCase();
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(l.id);
  });
  const dupeNames = [...byName.entries()].filter(([, ids]) => ids.length > 1);
  console.log(`Duplicate internalListingName groups: ${dupeNames.length}`);
  dupeNames.forEach(([k, ids]) => console.log(`   "${k}" -> ids ${ids.join(', ')}`));

  // Calendar + reservations for the date
  const lim = limit(5);
  const calendar = {};
  const reservations = [];
  const calGaps = [];

  await Promise.all(included.map(l => lim(async () => {
    const [cal, resv] = await Promise.all([
      req(`/v1/listings/${l.id}/calendar?accountId=${ACCOUNT_ID}&startDate=${DATE}&endDate=${DATE}`, token),
      (async () => {
        const out = [];
        for (let off = 0; ; off += 500) {
          const r = await req(`/v1/reservations?accountId=${ACCOUNT_ID}&listingId=${l.id}&status=active,confirmed,new,modified&departureDateFrom=${DATE}&limit=500&offset=${off}`, token);
          const page = r.result || [];
          out.push(...page);
          if (page.length < 500) break;
        }
        return out;
      })(),
    ]);
    calendar[l.id] = cal.result || [];
    if (!(cal.result || []).some(c => c.date === DATE)) calGaps.push(l.id);
    reservations.push(...resv);
  })));

  console.log(`Listings with no calendar entry for ${DATE}: ${calGaps.length}${calGaps.length ? ' -> ' + calGaps.join(', ') : ''}`);

  const guestResv = reservations.filter(r => !EXCLUDED_LISTINGS.includes(r.listingId) && isGuestStatus(r));

  // Classify exactly as the report does
  let occupied = 0, unavailable = 0;
  const occupiedResv = [];
  const reasons = { reservedNoResv: [], ownerReserved: [], otherStatus: {}, blockedFlag: [] };

  included.forEach(l => {
    const day = (calendar[l.id] || []).find(c => c.date === DATE);
    if (!day) return;
    if (day.status === 'reserved' && day.countReservedUnits > 0) {
      const match = guestResv.find(r => r.listingMapId === l.id && activeOn(r, DATE));
      if (match) {
        if (isOwner(match)) { unavailable++; reasons.ownerReserved.push(l.id); }
        else { occupied++; occupiedResv.push({ listing: l, r: match }); }
      } else { unavailable++; reasons.reservedNoResv.push(l.id); }
    } else if (day.status !== 'available' && day.status !== 'open' && day.status !== 'reserved') {
      unavailable++;
      reasons.otherStatus[day.status] = (reasons.otherStatus[day.status] || 0) + 1;
    } else if (day.countBlockedUnits > 0 || day.isAvailable === false || day.isAvailable === 0) {
      unavailable++; reasons.blockedFlag.push(l.id);
    }
  });

  const sellable = included.length - unavailable;
  console.log(`\n${'='.repeat(70)}\nOCCUPANCY AS THE REPORT COMPUTES IT\n${'='.repeat(70)}`);
  console.log(`Total units:       ${included.length}`);
  console.log(`Occupied units:    ${occupied}`);
  console.log(`Unavailable units: ${unavailable}`);
  console.log(`Sellable units:    ${sellable}`);
  console.log(`Occupancy:         ${sellable > 0 ? (occupied / sellable * 100).toFixed(1) : 0}%`);

  console.log(`\nUnavailable breakdown:`);
  console.log(`  reserved but no matching guest reservation: ${reasons.reservedNoResv.length}`);
  console.log(`  owner-channel reservation:                  ${reasons.ownerReserved.length}`);
  console.log(`  blocked/other calendar status:              ${Object.entries(reasons.otherStatus).map(([k, v]) => `${k}=${v}`).join(' ') || 'none'}`);
  console.log(`  available-but-flagged-unavailable:          ${reasons.blockedFlag.length}`);

  // Distinct reservations behind the occupied units
  const distinct = new Map();
  occupiedResv.forEach(({ r }) => distinct.set(r.id, r));
  console.log(`\nDistinct guest reservations behind ${occupied} occupied units: ${distinct.size}`);

  const perListing = new Map();
  occupiedResv.forEach(({ listing }) => perListing.set(listing.id, (perListing.get(listing.id) || 0) + 1));
  const multi = [...perListing.entries()].filter(([, c]) => c > 1);
  console.log(`Listings counted as occupied more than once: ${multi.length}`);

  // Grouping: creation date
  console.log(`\n${'='.repeat(70)}\nOCCUPIED RESERVATIONS BY CREATION DATE (UTC)\n${'='.repeat(70)}`);
  const byCreated = {};
  [...distinct.values()].forEach(r => {
    const created = (r.reservationDate || r.insertedOn || 'unknown').split(' ')[0];
    byCreated[created] = (byCreated[created] || 0) + 1;
  });
  Object.keys(byCreated).sort().forEach(k => console.log(`  ${k}  ${String(byCreated[k]).padStart(3)}  ${'#'.repeat(byCreated[k])}`));

  console.log(`\n${'='.repeat(70)}\nOCCUPIED RESERVATIONS BY CHANNEL\n${'='.repeat(70)}`);
  const byChannel = {};
  [...distinct.values()].forEach(r => {
    const c = r.channelName || `channelId:${r.channelId}` || 'unknown';
    byChannel[c] = (byChannel[c] || 0) + 1;
  });
  Object.entries(byChannel).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`  ${String(v).padStart(3)}  ${k}`));

  console.log(`\n${'='.repeat(70)}\nOCCUPIED RESERVATIONS BY STAY LENGTH\n${'='.repeat(70)}`);
  const byNights = {};
  [...distinct.values()].forEach(r => { const n = nightsOf(r); byNights[n] = (byNights[n] || 0) + 1; });
  Object.keys(byNights).map(Number).sort((a, b) => a - b).forEach(n => console.log(`  ${String(n).padStart(3)} nights: ${byNights[n]}`));

  console.log(`\n${'='.repeat(70)}\nPER-RESERVATION DETAIL (no guest data)\n${'='.repeat(70)}`);
  console.log('resvId'.padEnd(12) + 'listingId'.padEnd(11) + 'created'.padEnd(21) + 'arrival'.padEnd(12) + 'departure'.padEnd(12) + 'n'.padStart(3) + '  channel');
  [...distinct.values()]
    .sort((a, b) => String(a.reservationDate).localeCompare(String(b.reservationDate)))
    .forEach(r => console.log(
      String(r.id).padEnd(12) + String(r.listingMapId).padEnd(11) +
      String(r.reservationDate || r.insertedOn || '-').padEnd(21) +
      String(dayOf(r.arrivalDate)).padEnd(12) + String(dayOf(r.departureDate)).padEnd(12) +
      String(nightsOf(r)).padStart(3) + '  ' + (r.channelName || `id:${r.channelId}`)
    ));

  console.log(`\n${'='.repeat(70)}\nCALENDAR STATUS HISTOGRAM FOR ${DATE}\n${'='.repeat(70)}`);
  const hist = {};
  included.forEach(l => {
    const day = (calendar[l.id] || []).find(c => c.date === DATE);
    const k = day ? `${day.status} (reservedUnits=${day.countReservedUnits}, blockedUnits=${day.countBlockedUnits}, isAvailable=${day.isAvailable})` : 'NO CALENDAR ENTRY';
    hist[k] = (hist[k] || 0) + 1;
  });
  Object.entries(hist).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`  ${String(v).padStart(3)}  ${k}`));

  console.log('');
})();
