const https = require('https');

const HOSTAWAY_ACCOUNT_ID = process.env.HOSTAWAY_ACCOUNT_ID;
const HOSTAWAY_API_KEY = process.env.HOSTAWAY_API_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_SENDER = process.env.RESEND_SENDER;
const RESEND_RECIPIENT = process.env.RESEND_RECIPIENT;
const WHATSAPP_RECIPIENT = process.env.WHATSAPP_RECIPIENT;

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
  const today = new Date().toISOString().split('T')[0];

  // Get reservations
  const reservations = await httpsRequest({
    hostname: 'api.hostaway.com',
    path: `/v1/reservations?accountId=${HOSTAWAY_ACCOUNT_ID}&status=active,confirmed`,
    method: 'GET',
    headers: { 'Authorization': `Bearer ${HOSTAWAY_API_KEY}` },
  });

  // Get messages
  const messages = await httpsRequest({
    hostname: 'api.hostaway.com',
    path: `/v1/messages?accountId=${HOSTAWAY_ACCOUNT_ID}&unread=true`,
    method: 'GET',
    headers: { 'Authorization': `Bearer ${HOSTAWAY_API_KEY}` },
  });

  // Get listings for occupancy
  const listings = await httpsRequest({
    hostname: 'api.hostaway.com',
    path: `/v1/listings?accountId=${HOSTAWAY_ACCOUNT_ID}`,
    method: 'GET',
    headers: { 'Authorization': `Bearer ${HOSTAWAY_API_KEY}` },
  });

  return {
    reservations: reservations.body?.result || [],
    messages: messages.body?.result || [],
    listings: listings.body?.result || [],
  };
}

function formatReport(data) {
  const today = new Date().toLocaleDateString('en-IN');

  let report = `📊 Hostaway Daily Report - ${today}\n\n`;

  // Revenue summary
  const totalRevenue = data.reservations
    .reduce((sum, r) => sum + (r.totalPrice || 0), 0)
    .toFixed(2);
  report += `💰 Revenue: ₹${totalRevenue}\n`;

  // Reservations
  report += `\n🏠 Reservations:\n`;
  if (data.reservations.length > 0) {
    data.reservations.slice(0, 5).forEach((r, i) => {
      report += `${i + 1}. Guest: ${r.guestName || 'Unknown'} | Check-in: ${r.arrivalDate} | Price: ₹${r.totalPrice}\n`;
    });
    if (data.reservations.length > 5) {
      report += `... and ${data.reservations.length - 5} more\n`;
    }
  } else {
    report += `No active reservations\n`;
  }

  // Messages
  report += `\n💬 Unread Messages: ${data.messages.length}\n`;
  if (data.messages.length > 0) {
    data.messages.slice(0, 3).forEach((m, i) => {
      report += `${i + 1}. From: ${m.guestName || 'Unknown'}\n`;
    });
  }

  // Occupancy
  report += `\n📈 Listings: ${data.listings.length} active\n`;

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
    const body = `From=whatsapp:${process.env.TWILIO_PHONE_NUMBER}&To=whatsapp:${WHATSAPP_RECIPIENT}&Body=${encodeURIComponent(report)}`;

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

    const report = formatReport(data);
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
