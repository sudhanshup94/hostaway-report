const https = require('https');

const HOSTAWAY_ACCOUNT_ID = process.env.HOSTAWAY_ACCOUNT_ID;
const HOSTAWAY_API_KEY = process.env.HOSTAWAY_API_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_SENDER = process.env.RESEND_SENDER;
const RESEND_RECIPIENT = process.env.RESEND_RECIPIENT;
const WHATSAPP_RECIPIENT = process.env.WHATSAPP_RECIPIENT;
const EXCLUDED_LISTINGS = [488785];

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

  return {
    token,
    reservations: reservations.body?.result || [],
    listings: listingsArray,
    calendar: calendarData,
  };
}

function calculateOccupancy(reservations, listings, dateStr, calendarData = {}) {
  const date = new Date(dateStr);
  let occupied = 0;
  let unavailable = 0;
  const total = listings.length;

  listings.forEach(listing => {
    const hasReservation = reservations.some(r => {
      const arrivalDate = new Date(r.arrivalDate);
      const departureDate = new Date(r.departureDate);
      return r.listingId === listing.id && arrivalDate <= date && date < departureDate;
    });

    if (hasReservation) {
      occupied++;
    } else {
      // Check if listing is blocked on this date
      const listingCal = calendarData[listing.id] || [];
      const dayEntry = listingCal.find(c => c.day === dateStr);
      if (dayEntry && (dayEntry.status === 'blocked' || dayEntry.blocked === true)) {
        unavailable++;
      }
    }
  });

  const availableUnits = total - unavailable;
  const occupancyPercent = availableUnits > 0 ? ((occupied / availableUnits) * 100).toFixed(1) : 0;

  return { total, occupied, unavailable, occupancyPercent };
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
    accommodationFare += (r.accommodation || 0);
    cleaningFee += (r.cleaning || 0);
    pmCommission += (r.channelCommission || 0);
  });

  report += `2️⃣ REVENUE METRICS FOR TODAY\n`;
  report += `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
  report += `Accommodation Fare: ₹${accommodationFare.toFixed(2)}\n`;
  report += `PM Commission: ₹${pmCommission.toFixed(2)}\n`;
  report += `Cleaning Fee: ₹${cleaningFee.toFixed(2)}\n`;
  report += `Total: ₹${(accommodationFare + pmCommission + cleaningFee).toFixed(2)}\n\n`;

  // 3. LOW OCCUPANCY ALERTS (NEXT 15 DAYS)
  const lowOccupancyAlerts = [];
  for (let i = 0; i < 15; i++) {
    const checkDate = new Date(today);
    checkDate.setDate(checkDate.getDate() + i);
    const checkDateStr = checkDate.toISOString().split('T')[0];

    filteredListings.forEach(listing => {
      const isVilla = listing.type && listing.type.toLowerCase().includes('villa');
      const threshold = isVilla ? 30 : 50;

      const listingReservations = filteredReservations.filter(r => r.listingId === listing.id);
      const listingOcc = calculateOccupancy(listingReservations, [listing], checkDateStr, data.calendar);
      if (parseFloat(listingOcc.occupancyPercent) < threshold) {
        lowOccupancyAlerts.push({
          date: checkDate.toLocaleDateString('en-IN'),
          listing: listing.name || `Listing ${listing.id}`,
          type: isVilla ? 'Villa' : 'Apartment',
          occupancy: listingOcc.occupancyPercent,
        });
      }
    });
  }

  report += `3️⃣ LOW OCCUPANCY ALERTS (NEXT 15 DAYS)\n`;
  report += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
  if (lowOccupancyAlerts.length > 0) {
    lowOccupancyAlerts.slice(0, 10).forEach(alert => {
      report += `🚨 ${alert.listing} (${alert.type})\n`;
      report += `   Date: ${alert.date} | Occupancy: ${alert.occupancy}%\n`;
    });
    if (lowOccupancyAlerts.length > 10) {
      report += `... and ${lowOccupancyAlerts.length - 10} more\n`;
    }
  } else {
    report += `✅ All properties have good occupancy!\n`;
  }

  return report;
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

    const report = formatReport(data, data.token, HOSTAWAY_ACCOUNT_ID);
    console.log('Report:\n', report);

    console.log('\nSending via Resend...');
    await sendViaResend(report);

    console.log('Sending via WhatsApp...');
    await sendViaWhatsApp(report);

    console.log('\n✅ Report sent successfully!');
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

main();
