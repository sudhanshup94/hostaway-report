const https = require('https');
const nodemailer = require('nodemailer');

const HOSTAWAY_ACCOUNT_ID = process.env.HOSTAWAY_ACCOUNT_ID;
const HOSTAWAY_API_KEY = process.env.HOSTAWAY_API_KEY;
const SMTP_HOST = process.env.SMTP_HOST || 'smtp.gmail.com';
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_SECURE = String(process.env.SMTP_SECURE || 'false').toLowerCase() === 'true';
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const EMAIL_FROM = process.env.EMAIL_FROM;
const EMAIL_TO = process.env.EMAIL_TO;
const EXCLUDED_LISTINGS = [488785];

// Connection pool with limited concurrent connections to avoid timeouts
const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 5,
  maxFreeSockets: 2,
  timeout: 30000,
  freeSocketTimeout: 30000,
});

// Get today's date in IST (Asia/Kolkata timezone). REPORT_DATE overrides it so a past
// day can be re-run and checked against a Hostaway export.
function getTodayIST() {
  if (process.env.REPORT_DATE) return process.env.REPORT_DATE;

  const istFormatter = new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: 'Asia/Kolkata'
  });
  const parts = istFormatter.formatToParts(new Date());
  const year = parts.find(p => p.type === 'year').value;
  const month = parts.find(p => p.type === 'month').value;
  const day = parts.find(p => p.type === 'day').value;
  return `${year}-${month}-${day}`;
}

// Get a date N days from today in IST
function getDateNDaysFromTodayIST(n) {
  const today = getTodayIST();
  const date = new Date(today);
  date.setDate(date.getDate() + n);
  return date.toISOString().split('T')[0];
}

// --- Calendar-month helpers (IST). All dates are 'YYYY-MM-DD' strings, compared
// lexicographically, matching the convention the rest of the report already uses.

function monthOf(dateStr) {
  return dateStr.slice(0, 7);
}

function addMonths(ym, n) {
  let [year, month] = ym.split('-').map(Number);
  month += n;
  year += Math.floor((month - 1) / 12);
  month = ((month - 1) % 12 + 12) % 12 + 1;
  return `${year}-${String(month).padStart(2, '0')}`;
}

function monthFirstDay(ym) {
  return `${ym}-01`;
}

function monthLastDay(ym) {
  const [year, month] = ym.split('-').map(Number);
  // Day 0 of the following month is the last day of this one.
  const day = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${ym}-${String(day).padStart(2, '0')}`;
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().split('T')[0];
}

// Every date from `start` to `end`, both inclusive.
function eachDate(start, end) {
  const out = [];
  for (let d = start; d <= end; d = addDays(d, 1)) out.push(d);
  return out;
}

// Hostaway stamps reservation timestamps in UTC as 'YYYY-MM-DD HH:MM:SS' (verified
// against the live API: the newest records sit behind the UTC clock, and would be
// hours in the future if read as IST). The report's 18:00 IST cutoff is 12:30 UTC.
const IST_OFFSET_MINUTES = 330;

function istWallClockToUTC(dateStr, hour, minute) {
  const utcMs = Date.UTC(
    Number(dateStr.slice(0, 4)), Number(dateStr.slice(5, 7)) - 1, Number(dateStr.slice(8, 10)),
    hour, minute, 0
  ) - IST_OFFSET_MINUTES * 60 * 1000;
  return new Date(utcMs);
}

function parseHostawayTimestamp(value) {
  if (!value) return null;
  const d = new Date(String(value).replace(' ', 'T') + 'Z');
  return Number.isNaN(d.getTime()) ? null : d;
}

// When the booking was made. reservationDate is the booking moment; insertedOn is when
// Hostaway's row was written, consistently a few seconds later, so it would misattribute
// a booking whose channel sync straddled the cutoff. latestActivityOn is modification
// time and must never be used here.
function getBookingCreatedAt(reservation) {
  return parseHostawayTimestamp(reservation.reservationDate)
    || parseHostawayTimestamp(reservation.insertedOn);
}

// Limit concurrent promises to avoid overwhelming the API
function promiseLimit(concurrency) {
  let running = 0;
  const queue = [];

  return (fn) => {
    return new Promise((resolve, reject) => {
      const task = async () => {
        try {
          resolve(await fn());
        } catch (err) {
          reject(err);
        } finally {
          running--;
          if (queue.length > 0) {
            const next = queue.shift();
            next();
          }
        }
      };

      if (running < concurrency) {
        running++;
        task();
      } else {
        queue.push(task);
      }
    });
  };
}

function parseListingType(listingName) {
  if (!listingName) return { type: 'Unknown', bedrooms: 0 };

  const firstSegment = listingName.split('-')[0];
  const isVilla = firstSegment.endsWith('BV');
  const isApartment = firstSegment.endsWith('BA');

  const bedrooms = parseFloat(firstSegment.replace(/BA$|BV$/, '')) || 0;

  return {
    type: isVilla ? 'Villa' : isApartment ? 'Apartment' : 'Unknown',
    bedrooms,
  };
}

async function httpsRequest(options, data = null, retries = 3, abortSignal = null) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await new Promise((resolve, reject) => {
        // Check if abort signal is already aborted
        if (abortSignal?.aborted) {
          reject(new Error('Request aborted'));
          return;
        }

        // Add agent to options for connection pooling
        options.agent = httpsAgent;
        options.timeout = 60000; // 60 second timeout
        options.signal = abortSignal; // Pass abort signal to request

        const req = https.request(options, (res) => {
          let body = '';
          res.on('data', (chunk) => body += chunk);
          res.on('end', () => {
            try {
              resolve({
                status: res.statusCode,
                body: body ? JSON.parse(body) : null,
              });
            } catch (e) {
              resolve({ status: res.statusCode, body });
            }
          });
        });

        req.on('timeout', () => {
          req.destroy();
          reject(new Error('Request timeout'));
        });
        req.on('error', reject);

        // Listen for abort signal
        if (abortSignal) {
          abortSignal.addEventListener('abort', () => {
            req.destroy();
            reject(new Error('Request aborted'));
          });
        }

        if (data) req.write(JSON.stringify(data));
        req.end();
      });
    } catch (err) {
      if (err.message === 'Request aborted') throw err; // Don't retry aborted requests
      if (attempt === retries) throw err;
      if (err.message === 'Request timeout') {
        console.log(`Retry ${attempt}/${retries} for request...`);
        await new Promise(r => setTimeout(r, 1000 * attempt)); // Wait before retry
      } else {
        throw err;
      }
    }
  }
}

async function getHostawayData() {
  // Get access token first
  const tokenBody = `grant_type=client_credentials&client_id=${HOSTAWAY_ACCOUNT_ID}&client_secret=${HOSTAWAY_API_KEY}&scope=general`;
  const tokenRes = await new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.hostaway.com',
      path: '/v1/accessTokens',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(tokenBody),
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on('error', (e) => resolve({ status: 0, body: { error: e.message } }));
    req.write(tokenBody);
    req.end();
  });

  if (!tokenRes.body?.access_token) {
    throw new Error(`Failed to get Hostaway access token: ${JSON.stringify(tokenRes.body)}`);
  }

  const token = tokenRes.body.access_token;
  const today = getTodayIST();
  const endDateStr = getDateNDaysFromTodayIST(15);

  // The portfolio section needs the whole current and next calendar month. That window
  // always contains today..today+15 (today+15 can never pass the 15th of next month), so
  // one widened calendar call per listing serves both reports.
  const currentMonth = monthOf(today);
  const nextMonth = addMonths(currentMonth, 1);
  const months = {
    currentMonth,
    nextMonth,
    currentStart: monthFirstDay(currentMonth),
    currentEnd: monthLastDay(currentMonth),
    nextStart: monthFirstDay(nextMonth),
    nextEnd: monthLastDay(nextMonth),
  };
  const calendarStart = months.currentStart;
  const calendarEnd = months.nextEnd;

  // Get listings with pagination (Hostaway default limit is 100, need to fetch all)
  console.log('Fetching all listings (with pagination)...');
  let allListings = [];
  let offset = 0;
  const listingLimit = 500;
  let totalFetched = 0;

  while (true) {
    const listingsRes = await httpsRequest({
      hostname: 'api.hostaway.com',
      path: `/v1/listings?accountId=${HOSTAWAY_ACCOUNT_ID}&limit=${listingLimit}&offset=${offset}`,
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` },
    });

    const listings = listingsRes.body?.result || [];
    if (listings.length === 0) {
      console.log(`✓ Pagination complete at offset ${offset}`);
      break;
    }

    allListings = allListings.concat(listings);
    totalFetched += listings.length;
    console.log(`  Page ${Math.ceil(totalFetched / listingLimit)}: ${listings.length} listings (total: ${totalFetched})`);
    offset += listingLimit;
  }

  // Get calendar data and reservations for each listing (with concurrency limit to avoid timeouts)
  const listingsArray = allListings;
  console.log(`✓ Found ${listingsArray.length} total listings (fetched with pagination)`);
  const calendarData = {};
  let allReservations = [];

  // Limit concurrency to 5 simultaneous requests to avoid overwhelming the API
  const limiter = promiseLimit(5);
  const filteredListings = listingsArray.filter(l => !EXCLUDED_LISTINGS.includes(l.id));

  const listingFetches = filteredListings.map((listing) =>
    limiter(async () => {
      try {
        // Fetch calendar and reservations in parallel (they're independent).
        // Reservations start from the current month's first day rather than today, so the
        // portfolio section sees bookings that already departed earlier this month and
        // bookings made this month for far-future stays. Today's figures filter to today
        // downstream and are unaffected by the wider set.
        const [cal, listingReservations] = await Promise.all([
          httpsRequest({
            hostname: 'api.hostaway.com',
            path: `/v1/listings/${listing.id}/calendar?accountId=${HOSTAWAY_ACCOUNT_ID}&startDate=${calendarStart}&endDate=${calendarEnd}`,
            method: 'GET',
            headers: { 'Authorization': `Bearer ${token}` },
          }),
          (async () => {
            const collected = [];
            const pageSize = 500;
            for (let pageOffset = 0; ; pageOffset += pageSize) {
              const res = await httpsRequest({
                hostname: 'api.hostaway.com',
                path: `/v1/reservations?accountId=${HOSTAWAY_ACCOUNT_ID}&listingId=${listing.id}&status=active,confirmed,new,modified&departureDateFrom=${calendarStart}&limit=${pageSize}&offset=${pageOffset}`,
                method: 'GET',
                headers: { 'Authorization': `Bearer ${token}` },
              });
              const batch = res.body?.result || [];
              collected.push(...batch);
              if (batch.length < pageSize) break;
            }
            return collected;
          })(),
        ]);

        calendarData[listing.id] = cal.body?.result || [];

        return listingReservations;
      } catch (err) {
        console.error(`Error fetching data for listing ${listing.id}: ${err.message}`);
        return [];
      }
    })
  );

  // Wait for all listing fetches to complete
  const allListingReservations = await Promise.all(listingFetches);
  allReservations = allListingReservations.flat();

  const reservationsArray = allReservations;
  console.log(`✓ Fetched ${reservationsArray.length} reservations across ${filteredListings.length} listings (departure from ${calendarStart})`);

  // Finance is fetched for the union of everything the two reports need, and nothing
  // else. Fetching for every reservation in the account is tens of thousands of calls
  // and never finishes.
  const pickupWindow = getPickupWindow(today);
  const financeCandidates = collectFinanceCandidates(reservationsArray, today, months, pickupWindow);
  console.log(`✓ Fetching finance data for ${financeCandidates.length} reservations (of ${reservationsArray.length} fetched)`);

  const financialData = {};
  const financeFailures = [];

  const financeFetches = financeCandidates.map((reservation) =>
    limiter(async () => {
      try {
        const financeRes = await httpsRequest({
          hostname: 'api.hostaway.com',
          path: `/v1/financeCalculatedField/reservation/${reservation.id}?accountId=${HOSTAWAY_ACCOUNT_ID}`,
          method: 'GET',
          headers: { 'Authorization': `Bearer ${token}` },
        }, null, 3);

        const fields = financeRes.body?.result || [];
        const valueOf = (name) => {
          const field = fields.find(f => f.formulaName === name);
          return field ? Number(field.formulaResult) || 0 : null;
        };

        // Field names are case-sensitive and verified against the live API.
        // totalGuestFees - not reservation.cleaningFee - is what Hostaway reports as the
        // cleaning fee. Direct bookings carry a cleaningFee on the reservation but bill
        // no guest fee, and the export shows zero for them.
        const accommodationFare = valueOf('AccommodationFare');
        const pmCommission = valueOf('pmCommission');
        const cleaningFee = valueOf('totalGuestFees');
        const channelFee = valueOf('ChannelFee');

        if (accommodationFare === null || pmCommission === null || cleaningFee === null || channelFee === null) {
          throw new Error(`missing finance fields (got: ${fields.map(f => f.formulaName).join(', ') || 'none'})`);
        }

        return { reservationId: reservation.id, accommodationFare, pmCommission, cleaningFee, channelFee };
      } catch (err) {
        financeFailures.push({ id: reservation.id, guest: reservation.guestName, error: err.message });
        return null;
      }
    })
  );

  const financeResults = await Promise.all(financeFetches);
  financeResults.forEach(result => {
    if (result) {
      financialData[result.reservationId] = {
        accommodationFare: result.accommodationFare,
        pmCommission: result.pmCommission,
        cleaningFee: result.cleaningFee,
        channelFee: result.channelFee,
      };
    }
  });

  if (financeFailures.length > 0) {
    console.error(`\n⚠️  FINANCE DATA INCOMPLETE: ${financeFailures.length}/${financeCandidates.length} reservations failed`);
    financeFailures.forEach(f => console.error(`   - ${f.guest} (${f.id}): ${f.error}`));
  } else {
    console.log(`✓ Finance data complete for all ${financeCandidates.length} reservations`);
  }

  return {
    token,
    reservations: reservationsArray,
    listings: listingsArray,
    calendar: calendarData,
    financialData,
    financeFailures,
    financeCandidateCount: financeCandidates.length,
    months,
    pickupWindow,
    today,
  };
}

// Check if reservation is confirmed guest booking
function isConfirmedGuestReservation(reservation) {
  const confirmableStatuses = ['active', 'confirmed', 'new', 'modified'];
  return confirmableStatuses.includes(reservation.status?.toLowerCase());
}

// Check if reservation is from homeowner (not a paying guest)
function isHomeownerReservation(reservation) {
  // Homeowner reservations typically have:
  // - channelName like "Owner", "Homeowner", "Owner Stay"
  // - Or no guest name / empty guest name
  if (!reservation) return false;

  const channelName = (reservation.channelName || '').toLowerCase();
  const isOwnerChannel = channelName.includes('owner') || channelName.includes('homeowner');

  return isOwnerChannel;
}

// Check if reservation is active on a given date (arrivalDate <= date AND departureDate > date)
function isReservationActiveOnDate(reservation, dateStr) {
  const arrivalDate = new Date(reservation.arrivalDate).toISOString().split('T')[0];
  const departureDate = new Date(reservation.departureDate).toISOString().split('T')[0];
  return arrivalDate <= dateStr && departureDate > dateStr;
}

// Get number of nights in a reservation
function getNightsInReservation(reservation) {
  const arrival = new Date(reservation.arrivalDate);
  const departure = new Date(reservation.departureDate);
  const nights = Math.ceil((departure - arrival) / (1000 * 60 * 60 * 24));
  return Math.max(1, nights);
}

// The single definition of "this reservation earns revenue on this date". Used both to
// decide which reservations need a finance lookup and to sum the day's revenue, so the
// two can never drift apart.
function getRevenueEligibleReservations(reservations, date) {
  return reservations.filter(r =>
    !EXCLUDED_LISTINGS.includes(r.listingMapId) &&
    isConfirmedGuestReservation(r) &&
    isReservationActiveOnDate(r, date)
  );
}

// --- Portfolio report -------------------------------------------------------------

// The pickup window runs between consecutive 18:00 IST report cutoffs: start inclusive,
// end exclusive. For a historical REPORT_DATE this is that date's cutoff and the one
// before it, so a re-run reproduces the same window.
function getPickupWindow(reportDate) {
  return {
    start: istWallClockToUTC(addDays(reportDate, -1), 18, 0),
    end: istWallClockToUTC(reportDate, 18, 0),
  };
}

function isEligibleGuestReservation(reservation) {
  return !EXCLUDED_LISTINGS.includes(reservation.listingMapId)
    && isConfirmedGuestReservation(reservation)
    && !isHomeownerReservation(reservation);
}

function overlapsRange(reservation, start, end) {
  const arrival = new Date(reservation.arrivalDate).toISOString().split('T')[0];
  const departure = new Date(reservation.departureDate).toISOString().split('T')[0];
  return arrival <= end && departure > start;
}

function createdWithin(reservation, start, end) {
  const createdAt = getBookingCreatedAt(reservation);
  return createdAt !== null && createdAt >= start && createdAt < end;
}

// Everything either report needs finance data for, de-duplicated. Sales from Current
// Month counts bookings made this month whatever their stay dates, so month-overlap
// alone is not enough.
function collectFinanceCandidates(reservations, today, months, pickupWindow) {
  const monthToDateStart = istWallClockToUTC(months.currentStart, 0, 0);
  const byId = new Map();

  for (const r of reservations) {
    if (!isEligibleGuestReservation(r)) continue;

    const needed =
      overlapsRange(r, months.currentStart, months.currentEnd) ||
      overlapsRange(r, months.nextStart, months.nextEnd) ||
      isReservationActiveOnDate(r, today) ||
      createdWithin(r, pickupWindow.start, pickupWindow.end) ||
      createdWithin(r, monthToDateStart, pickupWindow.end);

    if (needed) byId.set(r.id, r);
  }

  return [...byId.values()];
}

// Nights of this stay falling in each bucket. A stay occupies arrival..departure-1;
// checkout day earns nothing.
function bucketNights(reservation, months) {
  const arrival = new Date(reservation.arrivalDate).toISOString().split('T')[0];
  const departure = new Date(reservation.departureDate).toISOString().split('T')[0];
  const buckets = { currentMonth: 0, nextMonth: 0, futureMonths: 0 };

  for (let d = arrival; d < departure; d = addDays(d, 1)) {
    if (d >= months.currentStart && d <= months.currentEnd) buckets.currentMonth++;
    else if (d >= months.nextStart && d <= months.nextEnd) buckets.nextMonth++;
    else if (d > months.nextEnd) buckets.futureMonths++;
  }

  return buckets;
}

// Guest-booked and sellable nights per month, read from the calendar so owner stays and
// blocks are handled the same way the daily occupancy figure handles them.
function calculateMonthOccupancy(listings, reservations, calendarData, start, end) {
  const filteredListings = listings.filter(l => !EXCLUDED_LISTINGS.includes(l.id));
  const dates = eachDate(start, end);

  const byListing = new Map();
  for (const r of reservations) {
    if (!isEligibleGuestReservation(r)) continue;
    if (!byListing.has(r.listingMapId)) byListing.set(r.listingMapId, []);
    byListing.get(r.listingMapId).push(r);
  }

  let guestBookedNights = 0;
  let unavailableNights = 0;

  for (const listing of filteredListings) {
    const calendar = calendarData[listing.id] || [];
    const byDate = new Map(calendar.map(c => [c.date, c]));
    const listingReservations = byListing.get(listing.id) || [];

    for (const date of dates) {
      const entry = byDate.get(date);
      if (!entry) continue;

      if (entry.status === 'reserved' && entry.countReservedUnits > 0) {
        const match = listingReservations.find(r => isReservationActiveOnDate(r, date));
        if (match) guestBookedNights++;
        else unavailableNights++;
      } else if (entry.status !== 'available' && entry.status !== 'open') {
        unavailableNights++;
      } else if (entry.countBlockedUnits > 0 || entry.isAvailable === false || entry.isAvailable === 0) {
        unavailableNights++;
      }
    }
  }

  const totalListingNights = filteredListings.length * dates.length;
  const sellableNights = totalListingNights - unavailableNights;
  const occupancyPercent = sellableNights > 0 ? (guestBookedNights / sellableNights) * 100 : 0;

  return { guestBookedNights, unavailableNights, sellableNights, totalListingNights, occupancyPercent };
}

function calculatePortfolioReport(data) {
  const { reservations, listings, calendar, financialData, months, pickupWindow, today } = data;
  const monthToDateStart = istWallClockToUTC(months.currentStart, 0, 0);

  const zeroBuckets = () => ({ currentMonth: 0, nextMonth: 0, futureMonths: 0 });
  const totals = {
    pickupNights: zeroBuckets(),
    pickupRevenue: zeroBuckets(),
    revenue: zeroBuckets(),
    cleaning: zeroBuckets(),
    channelFee: zeroBuckets(),
    margin: zeroBuckets(),
  };
  let salesFromCurrentMonth = 0;

  const missingFinance = [];
  const counts = { eligible: 0, monthBuckets: 0, pickup: 0, salesMTD: 0 };

  for (const r of reservations) {
    if (!isEligibleGuestReservation(r)) continue;
    counts.eligible++;

    const inMonths = overlapsRange(r, months.currentStart, months.currentEnd)
      || overlapsRange(r, months.nextStart, months.nextEnd);
    const inPickup = createdWithin(r, pickupWindow.start, pickupWindow.end);
    const inSales = createdWithin(r, monthToDateStart, pickupWindow.end);
    if (!inMonths && !inPickup && !inSales) continue;

    const finance = financialData[r.id];
    if (!finance) {
      missingFinance.push({ id: r.id, guest: r.guestName });
      continue;
    }

    const nights = getNightsInReservation(r);
    const buckets = bucketNights(r, months);
    const perNight = (value) => value / nights;

    if (inMonths) {
      counts.monthBuckets++;
      for (const key of ['currentMonth', 'nextMonth']) {
        totals.revenue[key] += perNight(finance.accommodationFare) * buckets[key];
        totals.cleaning[key] += perNight(finance.cleaningFee) * buckets[key];
        totals.channelFee[key] += perNight(finance.channelFee) * buckets[key];
        totals.margin[key] += perNight(finance.pmCommission) * buckets[key];
      }
    }

    if (inPickup) {
      counts.pickup++;
      for (const key of ['currentMonth', 'nextMonth', 'futureMonths']) {
        totals.pickupNights[key] += buckets[key];
        totals.pickupRevenue[key] += perNight(finance.accommodationFare) * buckets[key];
      }
    }

    if (inSales) {
      counts.salesMTD++;
      // Full fare on the booking, not pro-rated - this measures sales made, not stays.
      salesFromCurrentMonth += finance.accommodationFare;
    }
  }

  const occupancyCurrent = calculateMonthOccupancy(listings, reservations, calendar, months.currentStart, months.currentEnd);
  const occupancyNext = calculateMonthOccupancy(listings, reservations, calendar, months.nextStart, months.nextEnd);

  return {
    today,
    months,
    pickupWindow,
    ...totals,
    salesFromCurrentMonth,
    occupancyCurrent,
    occupancyNext,
    missingFinanceCount: missingFinance.length,
    missingFinance,
    counts,
  };
}

// Calculate occupancy for today
function calculateTodayOccupancy(reservations, listings, today, calendarData) {
  const filteredListings = listings.filter(l => !EXCLUDED_LISTINGS.includes(l.id));
  const filteredReservations = reservations.filter(r => !EXCLUDED_LISTINGS.includes(r.listingId) && isConfirmedGuestReservation(r));

  let occupiedUnits = 0;
  let unavailableUnits = 0;
  const totalUnits = filteredListings.length;

  filteredListings.forEach(listing => {
    const listingCal = calendarData[listing.id] || [];
    const dayEntry = listingCal.find(c => c.date === today);

    if (dayEntry) {
      // Check if reserved - if so, determine if guest or homeowner
      if (dayEntry.status === 'reserved' && dayEntry.countReservedUnits > 0) {
        // Check if there's a matching guest reservation for this listing on this date
        const matchingReservation = filteredReservations.find(
          r => r.listingMapId === listing.id && isReservationActiveOnDate(r, today)
        );

        if (matchingReservation) {
          // Found a reservation - check if it's a homeowner or guest
          if (isHomeownerReservation(matchingReservation)) {
            // Homeowner reservations count as unavailable, not occupied
            unavailableUnits++;
          } else {
            // Guest reservation - it's occupied
            occupiedUnits++;
          }
        } else {
          // Calendar shows reserved but no guest reservation found
          // This is likely a homeowner block or maintenance block marked as reserved
          unavailableUnits++;
        }
      } else if (dayEntry.status !== 'available' && dayEntry.status !== 'open' && dayEntry.status !== 'reserved') {
        // Blocked, maintenance, owner stay, etc.
        unavailableUnits++;
      } else if (dayEntry.countBlockedUnits > 0 || (dayEntry.isAvailable === false || dayEntry.isAvailable === 0)) {
        unavailableUnits++;
      }
    }
  });

  const sellableUnits = totalUnits - unavailableUnits;
  const occupancyPercent = sellableUnits > 0 ? ((occupiedUnits / sellableUnits) * 100).toFixed(1) : 0;

  return {
    totalUnits,
    occupiedUnits,
    unavailableUnits,
    sellableUnits,
    occupancyPercent,
  };
}

// Revenue for a single day. Hostaway's own reservations report spreads every money
// figure evenly across the nights of a stay and reports one night's share, so a stay
// spanning the date contributes value/nights. Cleaning fee is spread the same way -
// it is not billed in full on the arrival date.
function calculateTodayRevenue(reservations, today, financialData) {
  console.log(`\n=== REVENUE CALCULATION DEBUG ===`);
  console.log(`Total reservations received: ${reservations.length}`);

  const filteredReservations = getRevenueEligibleReservations(reservations, today);
  console.log(`Reservations earning revenue on ${today}: ${filteredReservations.length}`);

  let accommodationFare = 0;
  let cleaningFee = 0;
  let pmCommission = 0;
  const missingFinance = [];

  filteredReservations.forEach(r => {
    const nights = getNightsInReservation(r);
    const finance = financialData[r.id];

    if (!finance) {
      missingFinance.push(r.guestName || r.id);
      return;
    }

    accommodationFare += finance.accommodationFare / nights;
    pmCommission += finance.pmCommission / nights;
    cleaningFee += finance.cleaningFee / nights;
  });

  console.log(`Accommodation Fare: ${accommodationFare.toFixed(2)}`);
  console.log(`PM Commission: ${pmCommission.toFixed(2)}`);
  console.log(`Cleaning Fee: ${cleaningFee.toFixed(2)}`);
  if (missingFinance.length > 0) {
    console.error(`⚠️  ${missingFinance.length} reservations excluded from revenue - no finance data: ${missingFinance.join(', ')}`);
  }
  console.log(`=== END DEBUG ===\n`);

  return {
    accommodationFare: Math.max(0, accommodationFare),
    pmCommission: Math.max(0, pmCommission),
    cleaningFee: Math.max(0, cleaningFee),
    reservationCount: filteredReservations.length,
    missingFinanceCount: missingFinance.length,
  };
}

// Calculate low occupancy alerts for next 15 days
function calculateLowOccupancyAlerts(listings, today, calendarData, reservations) {
  const filteredListings = listings.filter(l => !EXCLUDED_LISTINGS.includes(l.id));
  const alerts = [];
  const debugData = [];

  filteredListings.forEach(listing => {
    const listingInfo = parseListingType(listing.internalListingName);
    const isVilla = listingInfo.type === 'Villa';
    const threshold = isVilla ? 30 : 50;

    let blockedOccupiedDays = 0;
    let guestBookedDays = 0;
    let homeownerStayDays = 0;
    let maintenanceBlockDays = 0;
    let nextAvailableDate = null;

    const listingCal = calendarData[listing.id] || [];

    for (let i = 0; i < 15; i++) {
      const checkDate = getDateNDaysFromTodayIST(i);
      const dayEntry = listingCal.find(c => c.date === checkDate);

      if (dayEntry && dayEntry.status !== 'available' && dayEntry.status !== 'open') {
        blockedOccupiedDays++;

        if (dayEntry.status === 'reserved' || dayEntry.status === 'booked') {
          guestBookedDays++;
        } else if (dayEntry.status === 'owner-stay' || dayEntry.status === 'owner_stay') {
          homeownerStayDays++;
        } else if (dayEntry.status === 'maintenance' || dayEntry.status === 'calendar-block' || dayEntry.status === 'blocked') {
          maintenanceBlockDays++;
        } else {
          maintenanceBlockDays++; // Other blocks
        }
      } else if (!nextAvailableDate && (dayEntry?.status === 'available' || dayEntry?.status === 'open' || !dayEntry)) {
        nextAvailableDate = checkDate;
      }
    }

    const availableSellableDays = 15 - blockedOccupiedDays;
    const blockedOccupancyPercent = (blockedOccupiedDays / 15) * 100;

    // Store debug data
    const todayCalEntry = listingCal.find(c => c.date === today);

    // Determine if occupied (same logic as occupancy calculation)
    // Only count as occupied if: (1) calendar shows reserved, AND (2) we have a matching guest reservation
    let isTodayOccupied = false;
    if (todayCalEntry?.status === 'reserved' && todayCalEntry?.countReservedUnits > 0) {
      const filteredReservations = reservations.filter(r => !EXCLUDED_LISTINGS.includes(r.listingId) && isConfirmedGuestReservation(r));
      const matchingReservation = filteredReservations.find(
        r => r.listingMapId === listing.id && isReservationActiveOnDate(r, today)
      );
      // Only occupied if we found a reservation AND it's not a homeowner reservation
      if (matchingReservation && !isHomeownerReservation(matchingReservation)) {
        isTodayOccupied = true;
      }
    }

    debugData.push({
      listingId: listing.id,
      internalListingName: listing.internalListingName,
      propertyType: listingInfo.type,
      todayCalendarStatus: todayCalEntry?.status || 'unknown',
      todayReservationStatus: todayCalEntry?.status === 'reserved' ? 'booked' : 'available',
      isAvailableToday: todayCalEntry?.isAvailable !== false && todayCalEntry?.status === 'available',
      isOccupiedToday: isTodayOccupied,
      isUnavailableToday: todayCalEntry?.status !== 'available' && todayCalEntry?.status !== 'reserved',
      guestBookedDaysNext15: guestBookedDays,
      homeownerStayDaysNext15: homeownerStayDays,
      maintenanceOrCalendarBlockDaysNext15: maintenanceBlockDays,
      totalBlockedOccupiedDaysNext15: blockedOccupiedDays,
      availableSellableDaysNext15: availableSellableDays,
      blockedOccupancyPercentNext15: blockedOccupancyPercent.toFixed(1),
      nextAvailableDate: nextAvailableDate || 'None',
      notes: '',
    });

    // Add to alerts if below threshold
    if (blockedOccupancyPercent < threshold) {
      alerts.push({
        listingId: listing.id,
        internalListingName: listing.internalListingName,
        propertyType: listingInfo.type,
        blockedDays: blockedOccupiedDays,
        availableDays: availableSellableDays,
        blockedOccupancyPercent: blockedOccupancyPercent.toFixed(1),
        guestBookedDays,
        homeownerStayDays,
        maintenanceBlockDays,
        nextAvailableDate: nextAvailableDate || 'None',
      });
    }
  });

  return { alerts, debugData };
}

// Format email report
function formatEmailReport(occupancy, revenue, lowOccupancyAlerts, today) {
  const dateDisplay = new Date(today + 'T00:00:00Z').toLocaleDateString('en-IN');
  let report = `Hostaway Daily Report - ${dateDisplay}\n\n`;

  report += `1. Occupancy Today\n\n`;
  report += `Total Units: ${occupancy.totalUnits}\n`;
  report += `Occupied Units: ${occupancy.occupiedUnits}\n`;
  report += `Unavailable Units: ${occupancy.unavailableUnits}\n`;
  report += `Sellable Units: ${occupancy.sellableUnits}\n`;
  report += `Occupancy: ${occupancy.occupancyPercent}%\n\n`;

  report += `2. Revenue Today\n\n`;
  if (revenue.missingFinanceCount > 0) {
    report += `⚠️ INCOMPLETE: finance data missing for ${revenue.missingFinanceCount} of ${revenue.reservationCount} reservations. The figures below are understated.\n\n`;
  }
  report += `Accommodation Fare: ₹${revenue.accommodationFare.toFixed(2)}\n`;
  report += `PM Commission: ₹${revenue.pmCommission.toFixed(2)}\n`;
  report += `Cleaning Fee: ₹${revenue.cleaningFee.toFixed(2)}\n`;
  report += `Based on ${revenue.reservationCount - revenue.missingFinanceCount} reservations earning revenue today.\n\n`;

  report += `3. Low Occupancy Alerts - Next 15 Days\n\n`;
  report += `This section shows properties with high sellable availability over the next 15 days where sales action may be required. Guest bookings, homeowner stays, maintenance blocks, and other calendar blocks are all treated as blocked/occupied because those dates are not available for sale.\n\n`;

  const villas = lowOccupancyAlerts.filter(a => a.propertyType === 'Villa');
  const apartments = lowOccupancyAlerts.filter(a => a.propertyType === 'Apartment');

  report += `Villas below 30% blocked/occupied: ${villas.length} properties\n\n`;
  villas.sort((a, b) => parseFloat(a.blockedOccupancyPercent) - parseFloat(b.blockedOccupancyPercent)).forEach((alert, idx) => {
    report += `${idx + 1}. ${alert.internalListingName} - ${alert.blockedDays}/15 blocked - ${alert.availableDays}/15 available - ${alert.blockedOccupancyPercent}% - Next available: ${alert.nextAvailableDate}\n`;
  });

  report += `\nApartments below 50% blocked/occupied: ${apartments.length} properties\n\n`;
  apartments.sort((a, b) => parseFloat(a.blockedOccupancyPercent) - parseFloat(b.blockedOccupancyPercent)).forEach((alert, idx) => {
    report += `${idx + 1}. ${alert.internalListingName} - ${alert.blockedDays}/15 blocked - ${alert.availableDays}/15 available - ${alert.blockedOccupancyPercent}% - Next available: ${alert.nextAvailableDate}\n`;
  });

  return report;
}

function formatPortfolioSection(portfolio) {
  const money = (v) => `₹${v.toFixed(2)}`;
  const nights = (v) => String(Math.round(v));
  const pct = (v) => `${v.toFixed(1)}%`;
  const monthName = (ym) => new Date(ym + '-01T00:00:00Z')
    .toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });

  const p = portfolio;
  let out = `\nPORTFOLIO PERFORMANCE REPORT — ${p.today}\n\n`;
  out += `Date: ${p.today} IST\n`;
  out += `Current month (FTM): ${monthName(p.months.currentMonth)} (${p.months.currentStart} to ${p.months.currentEnd})\n`;
  out += `Next month: ${monthName(p.months.nextMonth)} (${p.months.nextStart} to ${p.months.nextEnd})\n\n`;

  if (p.missingFinanceCount > 0) {
    out += `⚠️ INCOMPLETE: finance data missing for ${p.missingFinanceCount} reservations. Figures below are understated.\n\n`;
  }

  out += `Pickup Nights FTM: ${nights(p.pickupNights.currentMonth)}\n`;
  out += `Pickup Nights Next Month: ${nights(p.pickupNights.nextMonth)}\n`;
  out += `Pickup Nights Future Months: ${nights(p.pickupNights.futureMonths)}\n\n`;

  out += `Pickup Revenue FTM: ${money(p.pickupRevenue.currentMonth)}\n`;
  out += `Pickup Revenue Next Month: ${money(p.pickupRevenue.nextMonth)}\n`;
  out += `Pickup Revenue Future Months: ${money(p.pickupRevenue.futureMonths)}\n\n`;

  out += `Occupancy FTM: ${pct(p.occupancyCurrent.occupancyPercent)}\n`;
  out += `Occupancy Next Month: ${pct(p.occupancyNext.occupancyPercent)}\n\n`;

  out += `Total Revenue FTM: ${money(p.revenue.currentMonth)}\n`;
  out += `Total Revenue Next Month: ${money(p.revenue.nextMonth)}\n\n`;

  out += `Cleaning Income FTM: ${money(p.cleaning.currentMonth)}\n`;
  out += `Cleaning Income Next Month: ${money(p.cleaning.nextMonth)}\n\n`;

  out += `Channel Fee FTM: ${money(p.channelFee.currentMonth)}\n`;
  out += `Channel Fee Next Month: ${money(p.channelFee.nextMonth)}\n\n`;

  out += `Margin FTM: ${money(p.margin.currentMonth)}\n`;
  out += `Margin Next Month: ${money(p.margin.nextMonth)}\n\n`;

  out += `Sales from Current Month: ${money(p.salesFromCurrentMonth)}\n\n`;

  out += `Pickup window: ${p.pickupWindow.start.toISOString().slice(0, 16).replace('T', ' ')} to `;
  out += `${p.pickupWindow.end.toISOString().slice(0, 16).replace('T', ' ')} UTC (18:00 IST to 18:00 IST).\n`;
  out += `Occupancy is a point-in-time position from the live calendar at run time; FTM covers the whole month including elapsed days.\n`;

  return out;
}

function printPortfolioDebug(p) {
  console.log('\n=== PORTFOLIO DEBUG ===');
  console.log(`Report date (IST)      : ${p.today}`);
  console.log(`Current month          : ${p.months.currentStart} .. ${p.months.currentEnd}`);
  console.log(`Next month             : ${p.months.nextStart} .. ${p.months.nextEnd}`);
  console.log(`Future months          : after ${p.months.nextEnd}`);
  console.log(`Pickup window (UTC)    : ${p.pickupWindow.start.toISOString()} -> ${p.pickupWindow.end.toISOString()}`);
  console.log(`Booking-created field  : reservationDate (fallback insertedOn), read as UTC`);
  console.log(`\nReservation counts:`);
  console.log(`  eligible guest reservations : ${p.counts.eligible}`);
  console.log(`  contributing to month totals: ${p.counts.monthBuckets}`);
  console.log(`  created in pickup window    : ${p.counts.pickup}`);
  console.log(`  created month-to-date       : ${p.counts.salesMTD}`);
  console.log(`  missing finance data        : ${p.missingFinanceCount}`);
  if (p.missingFinanceCount > 0) {
    p.missingFinance.slice(0, 20).forEach(m => console.log(`     - ${m.guest} (${m.id})`));
  }
  console.log(`\nBucketed nights (pickup): FTM=${p.pickupNights.currentMonth} next=${p.pickupNights.nextMonth} future=${p.pickupNights.futureMonths}`);
  console.log(`\nOccupancy basis (live calendar state at run time):`);
  for (const [label, o] of [['FTM', p.occupancyCurrent], ['Next', p.occupancyNext]]) {
    console.log(`  ${label.padEnd(5)} guestBooked=${o.guestBookedNights} sellable=${o.sellableNights} ` +
      `unavailable=${o.unavailableNights} totalListingNights=${o.totalListingNights} -> ${o.occupancyPercent.toFixed(1)}%`);
  }
  console.log(`\nFinance totals:`);
  console.log(`  Total Revenue   FTM=${p.revenue.currentMonth.toFixed(2)}   next=${p.revenue.nextMonth.toFixed(2)}`);
  console.log(`  Cleaning Income FTM=${p.cleaning.currentMonth.toFixed(2)}   next=${p.cleaning.nextMonth.toFixed(2)}`);
  console.log(`  Channel Fee     FTM=${p.channelFee.currentMonth.toFixed(2)}   next=${p.channelFee.nextMonth.toFixed(2)}`);
  console.log(`  Margin          FTM=${p.margin.currentMonth.toFixed(2)}   next=${p.margin.nextMonth.toFixed(2)}`);
  console.log(`  Pickup Revenue  FTM=${p.pickupRevenue.currentMonth.toFixed(2)}   next=${p.pickupRevenue.nextMonth.toFixed(2)}   future=${p.pickupRevenue.futureMonths.toFixed(2)}`);
  console.log(`  Sales from Current Month = ${p.salesFromCurrentMonth.toFixed(2)}`);
  console.log('=== END PORTFOLIO DEBUG ===\n');
}

// Print debug table to console
function printDebugTable(debugData) {
  console.log('\n📋 DEBUG DATA - Occupancy Details for All Properties\n');
  console.table(debugData);
}

async function sendViaGmail(report) {
  // Validate required environment variables
  const missingVars = [];
  if (!SMTP_USER) missingVars.push('SMTP_USER');
  if (!SMTP_PASS) missingVars.push('SMTP_PASS');
  if (!EMAIL_FROM) missingVars.push('EMAIL_FROM');
  if (!EMAIL_TO) missingVars.push('EMAIL_TO');

  if (missingVars.length > 0) {
    console.error(`❌ Missing email configuration: ${missingVars.join(', ')}`);
    return false;
  }

  // Parse recipients from EMAIL_TO (comma-separated or Google Group)
  const recipients = EMAIL_TO
    .split(',')
    .map(email => email.trim())
    .filter(Boolean);

  if (recipients.length === 0) {
    console.log('Email skipped: No recipients configured');
    return false;
  }

  // Create Nodemailer transporter with connection timeouts
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE,
    auth: {
      user: SMTP_USER,
      pass: SMTP_PASS,
    },
    connectionTimeout: 10000, // 10 seconds
    socketTimeout: 10000, // 10 seconds
  });

  try {
    // Send email to all recipients in a single message
    console.log(`Sending email to: ${recipients.join(', ')}`);
    console.log(`From: ${EMAIL_FROM}`);
    const result = await transporter.sendMail({
      from: EMAIL_FROM,
      to: recipients,
      subject: '📊 Hostaway Daily Report',
      html: `<pre style="font-family: monospace; white-space: pre-wrap;">${report.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>`,
      text: report,
    });

    console.log(`✓ Email sent successfully to ${recipients.length} recipients`);
    console.log(`  Message ID: ${result.messageId}`);
    console.log(`  Response: ${JSON.stringify(result.response)}`);
    return true;
  } catch (err) {
    console.error(`❌ Email delivery failed: ${err.message}`);
    console.error(`  Full error: ${JSON.stringify(err)}`);
    if (err.code) console.error(`   Error code: ${err.code}`);
    if (err.responseCode) console.error(`   SMTP response code: ${err.responseCode}`);
    if (err.command) console.error(`   SMTP command: ${err.command}`);
    return false;
  }
}


async function main() {
  try {
    console.log('Fetching Hostaway data...');
    const data = await getHostawayData();

    console.log('Calculating occupancy...');
    const occupancy = calculateTodayOccupancy(data.reservations, data.listings, data.today, data.calendar);

    console.log('Calculating revenue...');
    const revenue = calculateTodayRevenue(data.reservations, data.today, data.financialData);

    console.log('Calculating low occupancy alerts...');
    const { alerts: lowOccupancyAlerts, debugData } = calculateLowOccupancyAlerts(data.listings, data.today, data.calendar, data.reservations);

    console.log('\n📊 REPORT SUMMARY');
    console.log('=================');
    console.log(`✓ Total Units: ${occupancy.totalUnits}`);
    console.log(`✓ Occupied Units: ${occupancy.occupiedUnits}`);
    console.log(`✓ Unavailable Units: ${occupancy.unavailableUnits}`);
    console.log(`✓ Sellable Units: ${occupancy.sellableUnits}`);
    console.log(`✓ Occupancy: ${occupancy.occupancyPercent}%`);
    console.log(`✓ Accommodation Fare: ₹${revenue.accommodationFare.toFixed(2)}`);
    console.log(`✓ PM Commission: ₹${revenue.pmCommission.toFixed(2)}`);
    console.log(`✓ Cleaning Fee: ₹${revenue.cleaningFee.toFixed(2)}`);
    const villaAlerts = lowOccupancyAlerts.filter(a => a.propertyType === 'Villa').length;
    const apartmentAlerts = lowOccupancyAlerts.filter(a => a.propertyType === 'Apartment').length;
    console.log(`✓ Villas below 30%: ${villaAlerts}`);
    console.log(`✓ Apartments below 50%: ${apartmentAlerts}`);

    // Print occupied units list with reservation details
    console.log('\n🏠 OCCUPIED UNITS TODAY:\n');
    const occupiedUnits = debugData.filter(d => d.isOccupiedToday);
    occupiedUnits.forEach((unit, idx) => {
      // Find matching reservations for debug info
      const matchingRes = data.reservations.find(r => r.listingMapId === unit.listingId &&
        new Date(r.arrivalDate).toISOString().split('T')[0] <= data.today &&
        new Date(r.departureDate).toISOString().split('T')[0] > data.today);
      const channelInfo = matchingRes ? ` [${matchingRes.channelName}]` : '';
      console.log(`${idx + 1}. ${unit.internalListingName} (ID: ${unit.listingId}) - Status: ${unit.todayCalendarStatus}${channelInfo}`);
    });
    console.log(`\nTotal Occupied: ${occupiedUnits.length}\n`);

    // Print debug table
    printDebugTable(debugData.slice(0, 5)); // Show first 5 for brevity

    console.log('Calculating portfolio performance...');
    const portfolio = calculatePortfolioReport(data);
    if (process.env.DRY_RUN === 'true') printPortfolioDebug(portfolio);

    // Format and send the report
    const emailReport = formatEmailReport(occupancy, revenue, lowOccupancyAlerts, data.today)
      + formatPortfolioSection(portfolio);
    console.log('\n📧 EMAIL REPORT:\n');
    console.log(emailReport);

    if (process.env.DRY_RUN === 'true') {
      console.log('\n🔍 DRY_RUN - report printed above, nothing sent.');
      return;
    }

    console.log('\nSending via Resend...');
    await sendViaGmail(emailReport);

    console.log('\n✅ Report sent successfully!');
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

main();
