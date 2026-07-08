const https = require('https');

const HOSTAWAY_ACCOUNT_ID = process.env.HOSTAWAY_ACCOUNT_ID;
const HOSTAWAY_API_KEY = process.env.HOSTAWAY_API_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_SENDER = process.env.RESEND_SENDER;
const RESEND_RECIPIENT = process.env.RESEND_RECIPIENT;
const WHATSAPP_RECIPIENT = process.env.WHATSAPP_RECIPIENT;
const EXCLUDED_LISTINGS = [488785];

// Get today's date in IST (Asia/Kolkata timezone)
function getTodayIST() {
  const now = new Date();
  const istTime = new Date(now.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }));
  return istTime.toISOString().split('T')[0];
}

// Get a date N days from today in IST
function getDateNDaysFromTodayIST(n) {
  const today = getTodayIST();
  const date = new Date(today + 'T00:00:00Z');
  date.setDate(date.getDate() + n);
  return date.toISOString().split('T')[0];
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

function httpsRequest(options, data = null) {
  return new Promise((resolve, reject) => {
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
    req.on('error', reject);
    if (data) req.write(JSON.stringify(data));
    req.end();
  });
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

  // Get reservations
  const reservations = await httpsRequest({
    hostname: 'api.hostaway.com',
    path: `/v1/reservations?accountId=${HOSTAWAY_ACCOUNT_ID}&status=active,confirmed`,
    method: 'GET',
    headers: { 'Authorization': `Bearer ${token}` },
  });

  // Get listings
  const listings = await httpsRequest({
    hostname: 'api.hostaway.com',
    path: `/v1/listings?accountId=${HOSTAWAY_ACCOUNT_ID}`,
    method: 'GET',
    headers: { 'Authorization': `Bearer ${token}` },
  });

  // Get calendar data for each listing
  const listingsArray = listings.body?.result || [];
  const calendarData = {};

  for (const listing of listingsArray) {
    if (EXCLUDED_LISTINGS.includes(listing.id)) continue;

    const cal = await httpsRequest({
      hostname: 'api.hostaway.com',
      path: `/v1/listings/${listing.id}/calendar?accountId=${HOSTAWAY_ACCOUNT_ID}&startDate=${today}&endDate=${endDateStr}`,
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` },
    });

    calendarData[listing.id] = cal.body?.result || [];
  }

  // Fetch PM Commission for each reservation
  const reservationsArray = reservations.body?.result || [];
  const pmCommissions = {};

  for (const reservation of reservationsArray) {
    const financeRes = await httpsRequest({
      hostname: 'api.hostaway.com',
      path: `/v1/financeCalculatedField/reservation/${reservation.id}?accountId=${HOSTAWAY_ACCOUNT_ID}`,
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` },
    });

    const pmData = financeRes.body?.result?.find(f => f.formulaName === 'pmCommission');
    pmCommissions[reservation.id] = pmData?.formulaResult || 0;
  }

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
      // Check if there's a guest reservation
      const guestReservation = filteredReservations.find(r => r.listingMapId === listing.id && isReservationActiveOnDate(r, today));

      if (guestReservation && dayEntry.status === 'reserved' && dayEntry.countReservedUnits > 0) {
        occupiedUnits++;
      } else if (dayEntry.status !== 'available' && dayEntry.status !== 'reserved') {
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
  const filteredReservations = reservations.filter(r => !EXCLUDED_LISTINGS.includes(r.listingId) && isConfirmedGuestReservation(r) && isReservationActiveOnDate(r, today));

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

  return {
    accommodationFare: Math.max(0, accommodationFare),
    pmCommission: Math.max(0, pmCommission),
    cleaningFee: Math.max(0, cleaningFee),
  };
}

// Calculate low occupancy alerts for next 15 days
function calculateLowOccupancyAlerts(listings, today, calendarData) {
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
    debugData.push({
      listingId: listing.id,
      internalListingName: listing.internalListingName,
      propertyType: listingInfo.type,
      todayCalendarStatus: todayCalEntry?.status || 'unknown',
      todayReservationStatus: todayCalEntry?.status === 'reserved' ? 'booked' : 'available',
      isAvailableToday: todayCalEntry?.isAvailable !== false && todayCalEntry?.status === 'available',
      isOccupiedToday: todayCalEntry?.status === 'reserved',
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

async function sendViaResend(report) {
  const response = await httpsRequest(
    {
      hostname: 'api.resend.com',
      path: '/emails',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
    },
    {
      from: RESEND_SENDER,
      to: RESEND_RECIPIENT,
      subject: '📊 Hostaway Daily Report',
      html: `<pre style="font-family: monospace; white-space: pre-wrap;">${report.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>`,
    }
  );

  console.log('Email sent:', response.status === 200 ? 'Success' : `Failed (${response.status})`);
  return response.status === 200;
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
    const { alerts: lowOccupancyAlerts, debugData } = calculateLowOccupancyAlerts(data.listings, data.today, data.calendar);

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

    // Print debug table
    printDebugTable(debugData.slice(0, 5)); // Show first 5 for brevity

    // Format and send reports
    const emailReport = formatEmailReport(occupancy, revenue, lowOccupancyAlerts, data.today);
    console.log('\n📧 EMAIL REPORT:\n');
    console.log(emailReport);

    console.log('\nSending via Resend...');
    await sendViaResend(emailReport);

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
