#!/usr/bin/env node

/**
 * Diagnostic script to fetch and print raw Hostaway API data
 * for selected listings to understand actual data structure
 */

const https = require('https');
const { URL } = require('url');

const HOSTAWAY_ACCOUNT_ID = process.env.HOSTAWAY_ACCOUNT_ID;
const HOSTAWAY_API_KEY = process.env.HOSTAWAY_API_KEY;
const EXCLUDED_LISTINGS = [488785];

// IST timezone utilities
function getTodayIST() {
  const istTime = new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' });
  const dateStr = new Date(istTime).toISOString().split('T')[0];
  return dateStr;
}

function getDateNDaysFromTodayIST(n) {
  const today = getTodayIST();
  const date = new Date(today);
  date.setDate(date.getDate() + n);
  return date.toISOString().split('T')[0];
}

// HTTP request utility
function makeRequest(method, path, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, 'https://api.hostaway.com');
    const options = {
      method,
      headers: {
        'Accept': 'application/json',
        ...headers,
      },
    };

    if (body) {
      options.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }

    const req = https.request(url, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({
            status: res.statusCode,
            body: data ? JSON.parse(data) : null,
            headers: res.headers,
          });
        } catch (e) {
          reject(new Error(`JSON parse error: ${e.message}`));
        }
      });
    });

    req.on('error', reject);
    if (body) {
      req.write(body);
    }
    req.end();
  });
}

async function getAuthToken() {
  console.log('\n=== GETTING AUTH TOKEN ===\n');
  const body = `grant_type=client_credentials&client_id=${HOSTAWAY_ACCOUNT_ID}&client_secret=${HOSTAWAY_API_KEY}&scope=general`;
  const res = await makeRequest('POST', '/v1/accessTokens', {}, body);
  if (res.status !== 200) {
    throw new Error(`Failed to get token: ${res.status}`);
  }
  const token = res.body.access_token;
  console.log(`✓ Got access token\n`);
  return token;
}

async function getAllListings(token) {
  console.log('=== FETCHING ALL LISTINGS ===\n');
  const path = `/v1/listings?accountId=${HOSTAWAY_ACCOUNT_ID}&limit=500`;
  const res = await makeRequest('GET', path, { 'Authorization': `Bearer ${token}` }, null);
  if (res.status !== 200) {
    throw new Error(`Failed to get listings: ${res.status}`);
  }
  const listings = res.body.result || [];
  console.log(`✓ Got ${listings.length} total listings\n`);
  return listings;
}

async function getListingData(token, listingId) {
  const path = `/v1/listings/${listingId}?accountId=${HOSTAWAY_ACCOUNT_ID}`;
  const res = await makeRequest('GET', path, { 'Authorization': `Bearer ${token}` }, null);
  if (res.status !== 200) {
    throw new Error(`Failed to get listing ${listingId}: ${res.status}`);
  }
  return res.body.result;
}

async function getCalendarData(token, listingId, startDate, endDate) {
  const path = `/v1/listings/${listingId}/calendar?startDate=${startDate}&endDate=${endDate}&includeResources=1`;
  const res = await makeRequest('GET', path, { 'Authorization': `Bearer ${token}` }, null);
  if (res.status !== 200) {
    throw new Error(`Failed to get calendar for ${listingId}: ${res.status}`);
  }
  return res.body.result || [];
}

async function getReservations(token, startDate, endDate) {
  // Try to get reservations for the account with date range
  const path = `/v1/reservations?accountId=${HOSTAWAY_ACCOUNT_ID}&status=active,confirmed,new,modified&limit=500`;
  const res = await makeRequest('GET', path, { 'Authorization': `Bearer ${token}` }, null);
  if (res.status !== 200) {
    throw new Error(`Failed to get reservations: ${res.status}`);
  }
  const reservations = res.body.result || [];

  // Filter to ones that overlap our date range
  const filtered = reservations.filter(r => {
    const arrival = new Date(r.arrivalDate).toISOString().split('T')[0];
    const departure = new Date(r.departureDate).toISOString().split('T')[0];
    return arrival <= endDate && departure > startDate;
  });

  return filtered;
}

async function getFinanceData(token, reservationId) {
  try {
    const path = `/v1/financeCalculatedField/reservation/${reservationId}?accountId=${HOSTAWAY_ACCOUNT_ID}`;
    const res = await makeRequest('GET', path, { 'Authorization': `Bearer ${token}` }, null);
    if (res.status === 200) {
      return res.body.result || [];
    }
  } catch (e) {
    // Finance data might not be available
  }
  return [];
}

function formatJSON(obj, indent = 2) {
  return JSON.stringify(obj, null, indent);
}

async function main() {
  try {
    // Allow overriding date via command line argument
    const overrideDate = process.argv[2];
    let today;

    if (overrideDate) {
      today = overrideDate;
      console.log(`Using override date: ${today}`);
    } else {
      today = getTodayIST();
    }

    const endDate15 = (() => {
      const date = new Date(today);
      date.setDate(date.getDate() + 14);
      return date.toISOString().split('T')[0];
    })();

    console.log('╔════════════════════════════════════════════════════════════╗');
    console.log('║         HOSTAWAY RAW DATA DIAGNOSTIC SCRIPT                ║');
    console.log('╚════════════════════════════════════════════════════════════╝\n');
    console.log(`Using IST Date: ${today}`);
    console.log(`Account ID: ${HOSTAWAY_ACCOUNT_ID}`);
    console.log(`Date Range for Diagnostic: ${today} to ${endDate15} (15 days)\n`);

    // Get auth token
    const token = await getAuthToken();

    // Get all listings to find occupied ones
    const allListings = await getAllListings(token);
    console.log(`Total active listings: ${allListings.length}\n`);

    // Selected listing IDs (user specified + additions)
    const selectedListingIds = [
      140910,  // 3BV-SaipemHills10-WhiteHouse
      140916,  // 5BV-SaipemHills9-Cliffhouse
      140920,  // 4BV-LotoBianco
    ];

    // Find listings that are occupied today and add them
    const allReservations = await getReservations(token, today, endDate15);
    const occupiedListingIds = new Set();
    for (const res of allReservations) {
      const arrival = new Date(res.arrivalDate).toISOString().split('T')[0];
      const departure = new Date(res.departureDate).toISOString().split('T')[0];
      if (arrival <= today && departure > today) {
        occupiedListingIds.add(res.listingMapId);
      }
    }

    // Add 2 occupied listings to selected
    let addedOccupied = 0;
    for (const listingId of occupiedListingIds) {
      if (addedOccupied >= 2 || selectedListingIds.includes(listingId)) continue;
      if (!EXCLUDED_LISTINGS.includes(listingId)) {
        selectedListingIds.push(listingId);
        addedOccupied++;
      }
    }

    // Add 2 listings with bookings in next 15 days
    const bookingListingIds = new Set();
    for (const res of allReservations) {
      bookingListingIds.add(res.listingMapId);
    }
    let addedBookings = 0;
    for (const listingId of bookingListingIds) {
      if (addedBookings >= 2 || selectedListingIds.includes(listingId)) continue;
      if (!EXCLUDED_LISTINGS.includes(listingId)) {
        selectedListingIds.push(listingId);
        addedBookings++;
      }
    }

    console.log(`Selected ${selectedListingIds.length} listings for diagnostic:\n`);
    console.log('═'.repeat(60));

    // Process each selected listing
    for (const listingId of selectedListingIds) {
      try {
        console.log(`\n\n╔════════════════════════════════════════════════════════════╗`);
        console.log(`║ LISTING: ${listingId}`);
        console.log(`╚════════════════════════════════════════════════════════════╝\n`);

        // A. Listing Data
        console.log('─'.repeat(60));
        console.log('A. LISTING DATA');
        console.log('─'.repeat(60));
        const listing = await getListingData(token, listingId);
        console.log(`
ID: ${listing.id}
Name: ${listing.name}
Internal Name: ${listing.internalListingName}
Status: ${listing.status}
Active: ${listing.active}
Disabled: ${listing.disabled}
Full listing JSON:\n`);
        console.log(formatJSON(listing));

        // B. Calendar Data for Today
        console.log('\n' + '─'.repeat(60));
        console.log('B. CALENDAR DATA FOR TODAY (' + today + ')');
        console.log('─'.repeat(60));
        const todayCalendar = await getCalendarData(token, listingId, today, today);
        if (todayCalendar.length > 0) {
          const dayEntry = todayCalendar[0];
          console.log(`
Date: ${dayEntry.date}
isAvailable: ${dayEntry.isAvailable}
Status: ${dayEntry.status}
Price: ${dayEntry.price}
Minimum Stay: ${dayEntry.minimumStay}
Reservation ID: ${dayEntry.reservationId || 'null'}
Count Reserved Units: ${dayEntry.countReservedUnits || 0}
Count Blocked Units: ${dayEntry.countBlockedUnits || 0}

Full day object JSON:\n`);
          console.log(formatJSON(dayEntry));
        } else {
          console.log('(No calendar data returned for today)');
        }

        // C. Calendar Data for Next 15 Days
        console.log('\n' + '─'.repeat(60));
        console.log('C. CALENDAR DATA FOR NEXT 15 DAYS (' + today + ' to ' + endDate15 + ')');
        console.log('─'.repeat(60));
        const next15Calendar = await getCalendarData(token, listingId, today, endDate15);

        console.log('\nTable view:\n');
        console.log('Date       | Available | Status      | ResvId | ResvStatus | Block Type');
        console.log('─'.repeat(80));

        const statusSamples = {};
        for (const day of next15Calendar) {
          const resId = day.reservationId ? `${day.reservationId}`.substring(0, 6) : '-';
          const resStatus = day.reservationStatus || '-';
          const blockType = day.blockType || '-';
          console.log(
            `${day.date} | ${String(day.isAvailable).padEnd(9)} | ${(day.status || '-').padEnd(11)} | ${resId.padEnd(6)} | ${resStatus.padEnd(10)} | ${blockType}`
          );

          // Collect samples of different statuses
          if (!statusSamples[day.status]) {
            statusSamples[day.status] = day;
          }
        }

        // Print sample raw objects for different status types
        console.log('\n\nSample raw calendar objects by status:\n');
        for (const [status, day] of Object.entries(statusSamples)) {
          console.log(`Status "${status}" sample:\n`);
          console.log(formatJSON(day));
          console.log('\n');
        }

        // D. Reservation Data for This Listing
        console.log('─'.repeat(60));
        console.log('D. RESERVATIONS FOR THIS LISTING');
        console.log('─'.repeat(60));
        const listingReservations = allReservations.filter(r => r.listingMapId === listingId);

        if (listingReservations.length > 0) {
          console.log(`\nFound ${listingReservations.length} reservation(s) overlapping date range:\n`);

          for (const res of listingReservations) {
            const arrival = new Date(res.arrivalDate).toISOString().split('T')[0];
            const departure = new Date(res.departureDate).toISOString().split('T')[0];
            const nights = Math.ceil((new Date(departure) - new Date(arrival)) / (1000 * 60 * 60 * 24));

            console.log(`Reservation ID: ${res.id}`);
            console.log(`Status: ${res.status}`);
            console.log(`Channel: ${res.channelName}`);
            console.log(`Guest: ${res.guestName}`);
            console.log(`Arrival: ${arrival} → Departure: ${departure} (${nights} nights)`);
            console.log(`Total Price: ${res.totalPrice}`);
            console.log(`Cleaning Fee: ${res.cleaningFee}`);
            console.log(`Hostaway Commission: ${res.hostawayCommissionAmount}`);
            console.log(`Channel Commission: ${res.channelCommissionAmount}`);

            // Try to get finance data
            const financeData = await getFinanceData(token, res.id);
            if (financeData.length > 0) {
              console.log(`\nFinance Data:`);
              for (const f of financeData) {
                console.log(`  ${f.formulaName}: ${f.formulaResult}`);
              }
            }

            console.log(`\nFull reservation JSON:\n`);
            console.log(formatJSON(res));

            // Check if would be counted as occupied today
            const isActiveToday = arrival <= today && departure > today;
            const confirmableStatuses = ['active', 'confirmed', 'new', 'modified'];
            const isConfirmed = confirmableStatuses.includes(res.status?.toLowerCase());

            console.log(`\nWould count as occupied today? ${isActiveToday && isConfirmed ? 'YES' : 'NO'}`);
            console.log(`  - Active today: ${isActiveToday}`);
            console.log(`  - Status confirmed: ${isConfirmed}\n`);
          }
        } else {
          console.log('\n(No reservations found for this listing in date range)\n');
        }

        // E. Cross-check Output
        console.log('─'.repeat(60));
        console.log('E. CROSS-CHECK SUMMARY');
        console.log('─'.repeat(60));

        const todayCalEntry = next15Calendar.find(c => c.date === today);
        const relevantReservations = listingReservations.filter(r => {
          const arrival = new Date(r.arrivalDate).toISOString().split('T')[0];
          const departure = new Date(r.departureDate).toISOString().split('T')[0];
          return arrival <= today && departure > today;
        });

        console.log(`\nToday (${today}):`);
        console.log(`  Calendar available: ${todayCalEntry?.isAvailable ?? 'unknown'}`);
        console.log(`  Calendar status: ${todayCalEntry?.status ?? 'unknown'}`);
        console.log(`  Calendar reservationId: ${todayCalEntry?.reservationId ?? 'none'}`);
        console.log(`  Calendar countReservedUnits: ${todayCalEntry?.countReservedUnits ?? 0}`);
        console.log(`  Calendar countBlockedUnits: ${todayCalEntry?.countBlockedUnits ?? 0}`);
        console.log(`  Overlapping reservation exists: ${relevantReservations.length > 0 ? 'YES' : 'NO'}`);
        if (relevantReservations.length > 0) {
          console.log(`    Status: ${relevantReservations[0].status}`);
        }

        // What should it count as?
        let countAsOccupied = false;
        let countAsUnavailable = false;

        if (relevantReservations.length > 0 && todayCalEntry?.status === 'reserved') {
          countAsOccupied = true;
        } else if (todayCalEntry?.status && todayCalEntry.status !== 'available' && todayCalEntry.status !== 'reserved') {
          countAsUnavailable = true;
        }

        console.log(`  Should count as occupied today: ${countAsOccupied ? 'YES' : 'NO'}`);
        console.log(`  Should count as unavailable today: ${countAsUnavailable ? 'YES' : 'NO'}`);

        // Next 15 days summary
        let blockedDays = 0;
        let availableDays = 0;
        let guestBookedDays = 0;
        let maintenanceDays = 0;
        let ownerStayDays = 0;

        for (const day of next15Calendar) {
          if (day.status === 'available' || day.status === 'open') {
            availableDays++;
          } else {
            blockedDays++;
            if (day.status === 'reserved' || day.status === 'booked') {
              guestBookedDays++;
            } else if (day.status === 'maintenance' || day.status === 'calendar-block' || day.status === 'blocked') {
              maintenanceDays++;
            } else if (day.status === 'owner-stay' || day.status === 'owner_stay') {
              ownerStayDays++;
            }
          }
        }

        console.log(`\nNext 15 days (${today} to ${endDate15}):`);
        console.log(`  Total days: ${next15Calendar.length}`);
        console.log(`  Available days: ${availableDays}`);
        console.log(`  Guest booked days: ${guestBookedDays}`);
        console.log(`  Owner stay days: ${ownerStayDays}`);
        console.log(`  Maintenance days: ${maintenanceDays}`);
        console.log(`  Total blocked/occupied: ${blockedDays}/15 (${((blockedDays/15)*100).toFixed(1)}%)`);

      } catch (error) {
        console.log(`\n✗ ERROR processing listing ${listingId}: ${error.message}\n`);
      }
    }

    console.log('\n\n═'.repeat(60));
    console.log('DIAGNOSTIC COMPLETE');
    console.log('═'.repeat(60) + '\n');

  } catch (error) {
    console.error('FATAL ERROR:', error);
    process.exit(1);
  }
}

main();
