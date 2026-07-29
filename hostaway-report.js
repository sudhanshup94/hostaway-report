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
const WHATSAPP_RECIPIENT = process.env.WHATSAPP_RECIPIENT;
const EXCLUDED_LISTINGS = [488785];

// Connection pool with limited concurrent connections to avoid timeouts
const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 5,
  maxFreeSockets: 2,
  timeout: 30000,
  freeSocketTimeout: 30000,
});

// Get today's date in IST (Asia/Kolkata timezone)
function getTodayIST() {
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

async function httpsRequest(options, data = null, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await new Promise((resolve, reject) => {
        // Add agent to options for connection pooling
        options.agent = httpsAgent;
        options.timeout = 60000; // 60 second timeout

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
        if (data) req.write(JSON.stringify(data));
        req.end();
      });
    } catch (err) {
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

  // Get listings
  console.log('Fetching listings...');
  const listings = await httpsRequest({
    hostname: 'api.hostaway.com',
    path: `/v1/listings?accountId=${HOSTAWAY_ACCOUNT_ID}`,
    method: 'GET',
    headers: { 'Authorization': `Bearer ${token}` },
  });

  // Get calendar data and reservations for each listing (with concurrency limit to avoid timeouts)
  const listingsArray = listings.body?.result || [];
  console.log(`Found ${listingsArray.length} listings`);
  const calendarData = {};
  let allReservations = [];

  // Limit concurrency to 5 simultaneous requests to avoid overwhelming the API
  const limiter = promiseLimit(5);
  const filteredListings = listingsArray.filter(l => !EXCLUDED_LISTINGS.includes(l.id));

  const listingFetches = filteredListings.map((listing) =>
    limiter(async () => {
      try {
        // Fetch calendar and reservations in parallel (they're independent)
        const [cal, listingResRes] = await Promise.all([
          httpsRequest({
            hostname: 'api.hostaway.com',
            path: `/v1/listings/${listing.id}/calendar?accountId=${HOSTAWAY_ACCOUNT_ID}&startDate=${today}&endDate=${endDateStr}`,
            method: 'GET',
            headers: { 'Authorization': `Bearer ${token}` },
          }),
          httpsRequest({
            hostname: 'api.hostaway.com',
            path: `/v1/reservations?accountId=${HOSTAWAY_ACCOUNT_ID}&listingId=${listing.id}&status=active,confirmed,new,modified&departureDateFrom=${today}&limit=500`,
            method: 'GET',
            headers: { 'Authorization': `Bearer ${token}` },
          })
        ]);

        calendarData[listing.id] = cal.body?.result || [];

        return listingResRes.body?.result || [];
      } catch (err) {
        console.error(`Error fetching data for listing ${listing.id}: ${err.message}`);
        return [];
      }
    })
  );

  // Wait for all listing fetches to complete
  const allListingReservations = await Promise.all(listingFetches);
  allReservations = allListingReservations.flat();

  // Fetch PM Commission for each reservation (parallelized with same limiter)
  const reservationsArray = allReservations;
  const pmCommissions = {};

  const pmCommissionFetches = reservationsArray.map((reservation) =>
    limiter(async () => {
      try {
        const financeRes = await httpsRequest({
          hostname: 'api.hostaway.com',
          path: `/v1/financeCalculatedField/reservation/${reservation.id}?accountId=${HOSTAWAY_ACCOUNT_ID}`,
          method: 'GET',
          headers: { 'Authorization': `Bearer ${token}` },
        });

        const pmData = financeRes.body?.result?.find(f => f.formulaName === 'pmCommission');
        return { reservationId: reservation.id, pmCommission: pmData?.formulaResult || 0 };
      } catch (err) {
        console.error(`Error fetching PM Commission for reservation ${reservation.id}: ${err.message}`);
        return { reservationId: reservation.id, pmCommission: 0 };
      }
    })
  );

  const pmCommissionResults = await Promise.all(pmCommissionFetches);
  pmCommissionResults.forEach(result => {
    pmCommissions[result.reservationId] = result.pmCommission;
  });

  return {
    token,
    reservations: reservationsArray,
    listings: listingsArray,
    calendar: calendarData,
    pmCommissions,
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

// Calculate revenue for today (prorated by night)
function calculateTodayRevenue(reservations, today, pmCommissions) {
  console.log(`\n=== REVENUE CALCULATION DEBUG ===`);
  console.log(`Total reservations received: ${reservations.length}`);

  const excludedByListing = reservations.filter(r => EXCLUDED_LISTINGS.includes(r.listingId));
  console.log(`Excluded by listing: ${excludedByListing.length}`);

  const notConfirmedGuest = reservations.filter(r => !EXCLUDED_LISTINGS.includes(r.listingId) && !isConfirmedGuestReservation(r));
  console.log(`Not confirmed guest (status not in ['active', 'confirmed', 'new', 'modified']): ${notConfirmedGuest.length}`);
  if (notConfirmedGuest.length > 0) {
    notConfirmedGuest.forEach(r => {
      console.log(`  - ${r.guestName}: status="${r.status}", listing="${r.listingMapId}"`);
    });
  }

  const notActiveOnDate = reservations.filter(r => !EXCLUDED_LISTINGS.includes(r.listingId) && isConfirmedGuestReservation(r) && !isReservationActiveOnDate(r, today));
  console.log(`Not active on ${today}: ${notActiveOnDate.length}`);

  const filteredReservations = reservations.filter(r => !EXCLUDED_LISTINGS.includes(r.listingId) && isConfirmedGuestReservation(r) && isReservationActiveOnDate(r, today));
  console.log(`Final filtered reservations for revenue: ${filteredReservations.length}`);

  let accommodationFare = 0;
  let cleaningFee = 0;
  let pmCommission = 0;

  filteredReservations.forEach(r => {
    const nights = getNightsInReservation(r);
    const pmComm = pmCommissions[r.id] || 0;

    // Prorated accommodation fare per night
    const farePerNight = ((r.totalPrice || 0) - (r.cleaningFee || 0) - pmComm) / nights;
    accommodationFare += farePerNight;

    // Prorated PM commission per night
    pmCommission += pmComm / nights;

    // Cleaning fee only on check-in date
    const arrivalDate = new Date(r.arrivalDate).toISOString().split('T')[0];
    if (arrivalDate === today) {
      cleaningFee += (r.cleaningFee || 0);
    }
  });

  console.log(`Accommodation Fare: ${accommodationFare.toFixed(2)}`);
  console.log(`PM Commission: ${pmCommission.toFixed(2)}`);
  console.log(`Cleaning Fee: ${cleaningFee.toFixed(2)}`);
  console.log(`=== END DEBUG ===\n`);

  return {
    accommodationFare: Math.max(0, accommodationFare),
    pmCommission: Math.max(0, pmCommission),
    cleaningFee: Math.max(0, cleaningFee),
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
  report += `Accommodation Fare: ₹${revenue.accommodationFare.toFixed(2)}\n`;
  report += `PM Commission: ₹${revenue.pmCommission.toFixed(2)}\n`;
  report += `Cleaning Fee: ₹${revenue.cleaningFee.toFixed(2)}\n\n`;

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

// Format WhatsApp report
function formatWhatsAppReport(occupancy, revenue, lowOccupancyAlerts) {
  let report = `Hostaway Daily Report\n\n`;

  report += `Occupancy Today:\n`;
  report += `Total: ${occupancy.totalUnits}\n`;
  report += `Occupied: ${occupancy.occupiedUnits}\n`;
  report += `Unavailable: ${occupancy.unavailableUnits}\n`;
  report += `Sellable: ${occupancy.sellableUnits}\n`;
  report += `Occupancy: ${occupancy.occupancyPercent}%\n\n`;

  report += `Revenue Today:\n`;
  report += `Accommodation: ₹${revenue.accommodationFare.toFixed(0)}\n`;
  report += `PM Commission: ₹${revenue.pmCommission.toFixed(0)}\n`;
  report += `Cleaning: ₹${revenue.cleaningFee.toFixed(0)}\n\n`;

  const villas = lowOccupancyAlerts.filter(a => a.propertyType === 'Villa');
  const apartments = lowOccupancyAlerts.filter(a => a.propertyType === 'Apartment');

  report += `Low Occupancy Alerts:\n`;
  report += `Villas below 30%: ${villas.length}\n`;
  report += `Apartments below 50%: ${apartments.length}\n\n`;

  const topAlerts = lowOccupancyAlerts.sort((a, b) => parseFloat(a.blockedOccupancyPercent) - parseFloat(b.blockedOccupancyPercent)).slice(0, 5);

  if (topAlerts.length > 0) {
    report += `Top 5 Lowest Blocked/Occupied:\n\n`;
    topAlerts.forEach((alert, idx) => {
      report += `${idx + 1}. ${alert.internalListingName} - ${alert.blockedDays}/15 blocked - ${alert.availableDays}/15 available - ${alert.blockedOccupancyPercent}%\n`;
    });
  }

  return report;
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

async function sendViaWhatsApp(report) {
  return new Promise((resolve) => {
    const auth = Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
    const fromNum = process.env.TWILIO_PHONE_NUMBER.replace(/\D/g, '');
    const recipientNum = WHATSAPP_RECIPIENT.replace(/\D/g, '');
    const body = `From=whatsapp:%2B${fromNum}&To=whatsapp:%2B${recipientNum}&Body=${encodeURIComponent(report)}`;

    const req = https.request({
      hostname: 'api.twilio.com',
      path: `/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Messages.json`,
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        const success = res.statusCode === 201;
        console.log('WhatsApp sent:', success ? 'Success' : `Failed (${res.statusCode})`);
        resolve(success);
      });
    });

    req.on('error', (e) => {
      console.error('WhatsApp error:', e.message);
      resolve(false);
    });

    req.write(body);
    req.end();
  });
}

async function main() {
  try {
    console.log('Fetching Hostaway data...');
    const data = await getHostawayData();

    console.log('Calculating occupancy...');
    const occupancy = calculateTodayOccupancy(data.reservations, data.listings, data.today, data.calendar);

    console.log('Calculating revenue...');
    const revenue = calculateTodayRevenue(data.reservations, data.today, data.pmCommissions);

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

    // Format and send reports
    const emailReport = formatEmailReport(occupancy, revenue, lowOccupancyAlerts, data.today);
    console.log('\n📧 EMAIL REPORT:\n');
    console.log(emailReport);

    console.log('\nSending via Resend...');
    await sendViaGmail(emailReport);

    console.log('Sending via WhatsApp...');
    const whatsappReport = formatWhatsAppReport(occupancy, revenue, lowOccupancyAlerts);
    await sendViaWhatsApp(whatsappReport);

    console.log('\n✅ Report sent successfully!');
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

main();
