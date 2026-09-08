#!/usr/bin/env node

/**
 * Diagnostic: Check if all listings are being fetched
 *
 * Tests:
 * 1. How many listings with NO limit (current behavior)?
 * 2. How many listings with explicit limit=1000?
 * 3. Are listings actually missing?
 */

const https = require('https');

const HOSTAWAY_ACCOUNT_ID = process.env.HOSTAWAY_ACCOUNT_ID;
const HOSTAWAY_API_KEY = process.env.HOSTAWAY_API_KEY;

const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 5,
  timeout: 30000,
});

async function httpsRequest(options, data = null) {
  return new Promise((resolve, reject) => {
    options.agent = httpsAgent;
    options.timeout = 60000;

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
}

async function getAuthToken() {
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
    throw new Error(`Failed to get token: ${JSON.stringify(tokenRes.body)}`);
  }
  return tokenRes.body.access_token;
}

async function checkTotalListings() {
  console.log('\n╔════════════════════════════════════════════════╗');
  console.log('║  TOTAL LISTINGS VERIFICATION                  ║');
  console.log('╚════════════════════════════════════════════════╝\n');

  const token = await getAuthToken();
  console.log('✓ Authenticated\n');

  // Test 1: Current production approach (NO limit)
  console.log('TEST 1: NO limit parameter (CURRENT PRODUCTION)');
  console.log('─'.repeat(50));
  console.log('API Call: /v1/listings?accountId=52447');
  const res1 = await httpsRequest({
    hostname: 'api.hostaway.com',
    path: `/v1/listings?accountId=${HOSTAWAY_ACCOUNT_ID}`,
    method: 'GET',
    headers: { 'Authorization': `Bearer ${token}` },
  });

  const listings1 = res1.body?.result || [];
  console.log(`  Listings returned: ${listings1.length}`);
  console.log(`  After excluding 488785: ${listings1.length - 1} (what's reported)`);

  // Test 2: Explicit high limit
  console.log('\n\nTEST 2: Explicit limit=1000 (REAL COUNT)');
  console.log('─'.repeat(50));
  console.log('API Call: /v1/listings?accountId=52447&limit=1000');
  const res2 = await httpsRequest({
    hostname: 'api.hostaway.com',
    path: `/v1/listings?accountId=${HOSTAWAY_ACCOUNT_ID}&limit=1000`,
    method: 'GET',
    headers: { 'Authorization': `Bearer ${token}` },
  });

  const listings2 = res2.body?.result || [];
  console.log(`  Listings returned: ${listings2.length}`);
  console.log(`  After excluding 488785: ${listings2.length - 1}`);

  // Analysis
  console.log('\n\n' + '═'.repeat(50));
  console.log('ANALYSIS');
  console.log('═'.repeat(50));

  if (listings1.length === listings2.length) {
    console.log(`\n✓ GOOD: Same count with both approaches`);
    console.log(`  Current production fetches: ${listings1.length} listings`);
    console.log(`  Reports as: ${listings1.length - 1} listings (after excluding test listing)`);
    console.log(`  All listings appear to be fetched`);
  } else {
    console.log(`\n❌ CRITICAL ISSUE FOUND:`);
    console.log(`  NO limit (current): ${listings1.length} listings`);
    console.log(`  With limit=1000: ${listings2.length} listings`);
    console.log(`  MISSING: ${listings2.length - listings1.length} listings!`);
    console.log(`\n  This means:`);
    console.log(`  - Current report shows: ${listings1.length - 1} listings (missing ${listings2.length - listings1.length})`);
    console.log(`  - Hostaway default limit: ${listings1.length}`);
    console.log(`  - Account actually has: ${listings2.length} listings`);
    console.log(`\n  Impact on report:`);
    console.log(`  - Missing ${listings2.length - listings1.length} listings' reservations`);
    console.log(`  - Occupancy undercount by ~${Math.round((listings2.length - listings1.length) / listings2.length * 100)}%`);
    console.log(`  - Revenue undercount by ~${Math.round((listings2.length - listings1.length) / listings2.length * 100)}%`);
    console.log(`\n  Fix required: Add pagination support to /v1/listings endpoint`);
  }

  // Check pagination support
  console.log('\n\nTEST 3: Check if pagination is needed');
  console.log('─'.repeat(50));

  if (listings2.length >= 1000) {
    console.log(`⚠️  RESULT: Account has ≥1000 listings (test limit hit)`);
    console.log(`   NEED TO: Test with higher limit or use pagination`);
  } else {
    console.log(`✓ Account has ${listings2.length} listings (below 1000 test limit)`);
  }

  console.log('\n');
}

checkTotalListings().catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
