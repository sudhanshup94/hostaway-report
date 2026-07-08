const https = require('https');

const HOSTAWAY_ACCOUNT_ID = process.env.HOSTAWAY_ACCOUNT_ID;
const HOSTAWAY_API_KEY = process.env.HOSTAWAY_API_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_SENDER = process.env.RESEND_SENDER;
const RESEND_RECIPIENT = process.env.RESEND_RECIPIENT;
const WHATSAPP_RECIPIENT = process.env.WHATSAPP_RECIPIENT;
const EXCLUDED_LISTINGS = [488785];

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
  const today = new Date().toISOString().split('T')[0];

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


  // Get calendar data for each listing to detect blocks (next 15 days)
  const listingsArray = listings.body?.result || [];
  const calendarData = {};
  const endDate = new Date();
  endDate.setDate(endDate.getDate() + 15);
  const endDateStr = endDate.toISOString().split('T')[0];

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


  // Fetch PM Commission for each reservation from finance calculated fields
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
  };
}

function calculateOccupancy(reservations, listings, dateStr, calendarData = {}) {
  let occupied = 0;
  let unavailable = 0;
  const total = listings.length;

  listings.forEach(listing => {
    const listingCal = calendarData[listing.id] || [];
    const dayEntry = listingCal.find(c => c.date === dateStr);

    if (dayEntry) {
      if (dayEntry.status === 'reserved' && dayEntry.countReservedUnits > 0) {
        occupied++;
      } else if (dayEntry.status === 'blocked' || dayEntry.countBlockedUnits > 0) {
        unavailable++;
      }
    }
  });

  const availableUnits = total - unavailable;
  const occupancyPercent = availableUnits > 0 ? ((occupied / availableUnits) * 100).toFixed(1) : 0;

  return { total, occupied, unavailable, occupancyPercent };
}

function formatWhatsAppReport(occupancy, revenue, lowOccupancyAlerts) {
  let report = `📊 *Daily Report*\n\n`;
  report += `📍 *Occupancy*\n`;
  report += `${occupancy.occupancyPercent}% (${occupancy.occupied}/${occupancy.total - occupancy.unavailable} units)\n\n`;

  report += `💰 *Revenue*\n`;
  report += `₹${revenue.total.toFixed(0)}\n\n`;

  if (lowOccupancyAlerts.length > 0) {
    report += `🚨 *Low Occupancy* (${lowOccupancyAlerts.length} properties)\n`;
    lowOccupancyAlerts.slice(0, 5).forEach(alert => {
      report += `${alert.listing}: ${alert.occupancy}%\n`;
    });
  }

  return report;
}

function formatReport(data, token, accountId) {
  const today = new Date();
  const todayStr = today.toISOString().split('T')[0];
  const dateDisplay = today.toLocaleDateString('en-IN');

  // Filter out excluded listings
  const filteredListings = data.listings.filter(l => !EXCLUDED_LISTINGS.includes(l.id));
  const filteredReservations = data.reservations.filter(r => !EXCLUDED_LISTINGS.includes(r.listingId));

  let report = `📊 DAILY REPORTS\n`;
  report += `Date: ${dateDisplay}\n`;
  report += `Delivery time: 6:00 PM every day\n\n`;

  // 1. OCCUPANCY FOR TODAY
  const occupancy = calculateOccupancy(filteredReservations, filteredListings, todayStr, data.calendar);
  report += `1️⃣ OCCUPANCY FOR TODAY\n`;
  report += `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
  report += `Total Units: ${occupancy.total}\n`;
  report += `Occupied Units: ${occupancy.occupied}\n`;
  report += `Unavailable Units: ${occupancy.unavailable}\n`;
  report += `Occupancy %: ${occupancy.occupancyPercent}%\n\n`;

  // 2. REVENUE METRICS
  const todayReservations = filteredReservations.filter(r => {
    const arrivalDate = new Date(r.arrivalDate);
    const departureDate = new Date(r.departureDate);
    return arrivalDate <= today && today < departureDate;
  });

  let accommodationFare = 0, cleaningFee = 0, pmCommission = 0;
  todayReservations.forEach(r => {
    const pmComm = data.pmCommissions[r.id] || 0;
    accommodationFare += (r.totalPrice || 0) - (r.cleaningFee || 0) - pmComm;
    cleaningFee += (r.cleaningFee || 0);
    pmCommission += pmComm;
  });

  report += `2️⃣ REVENUE METRICS FOR TODAY\n`;
  report += `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
  report += `Accommodation Fare: ₹${accommodationFare.toFixed(2)}\n`;
  report += `PM Commission: ₹${pmCommission.toFixed(2)}\n`;
  report += `Cleaning Fee: ₹${cleaningFee.toFixed(2)}\n`;
  report += `Total: ₹${(accommodationFare + pmCommission + cleaningFee).toFixed(2)}\n\n`;

  // 3. LOW OCCUPANCY ALERTS (NEXT 15 DAYS)
  const lowOccupancyAlerts = [];

  // Calculate occupancy for each listing: count booked days / 15 days
  filteredListings.forEach(listing => {
    const listingInfo = parseListingType(listing.internalListingName);
    const isVilla = listingInfo.type === 'Villa';
    const threshold = isVilla ? 30 : 50;
    let bookedDays = 0;

    // Check all 15 days and count days when property is reserved
    for (let i = 0; i < 15; i++) {
      const checkDate = new Date(today);
      checkDate.setDate(checkDate.getDate() + i);
      const checkDateStr = checkDate.toISOString().split('T')[0];

      const listingCal = data.calendar[listing.id] || [];
      const dayEntry = listingCal.find(c => c.date === checkDateStr);

      // Count as booked if status is reserved (not blocked)
      if (dayEntry && dayEntry.status === 'reserved' && dayEntry.countReservedUnits > 0) {
        bookedDays++;
      }
    }

    // Calculate occupancy as percentage of 15 days
    const occupancyPercent = (bookedDays / 15) * 100;

    // If occupancy is below threshold, add alert
    if (occupancyPercent < threshold) {
      lowOccupancyAlerts.push({
        listing: listing.internalListingName || listing.name || `Listing ${listing.id}`,
        type: listingInfo.type,
        bedrooms: listingInfo.bedrooms,
        occupancy: occupancyPercent.toFixed(1),
      });
    }
  });

  report += `3️⃣ LOW OCCUPANCY ALERTS (NEXT 15 DAYS)\n`;
  report += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
  report += `Total Properties Analyzed: ${filteredListings.length}\n`;
  report += `Properties Below Threshold: ${lowOccupancyAlerts.length}\n`;
  report += `(Villas <30%, Apartments <50%)\n\n`;

  if (lowOccupancyAlerts.length > 0) {
    lowOccupancyAlerts.sort((a, b) => parseFloat(a.occupancy) - parseFloat(b.occupancy)).forEach(alert => {
      report += `🚨 ${alert.listing} (${alert.bedrooms}BR ${alert.type})\n`;
      report += `   Avg Occupancy (15 days): ${alert.occupancy}%\n`;
    });
  } else {
    report += `✅ All properties have good occupancy!\n`;
  }

  return {
    full: report,
    occupancy,
    revenue: {
      accommodation: accommodationFare,
      pmCommission,
      cleaning: cleaningFee,
      total: accommodationFare + pmCommission + cleaningFee,
    },
    lowOccupancyAlerts,
  };
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
    const reportData = formatReport(data, data.token, HOSTAWAY_ACCOUNT_ID);
    console.log('\nReport:\n', reportData.full);

    console.log('\nSending via Resend...');
    await sendViaResend(reportData.full);

    console.log('Sending via WhatsApp...');
    const whatsappReport = formatWhatsAppReport(reportData.occupancy, reportData.revenue, reportData.lowOccupancyAlerts);
    await sendViaWhatsApp(whatsappReport);

    console.log('\n✅ Report sent successfully!');
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

main();
