#!/usr/bin/env node

// Proves that a failed page in listings, calendar or reservation pagination aborts the
// run instead of quietly shrinking the result set.
//
// The bug these cover: httpsRequest resolved rather than rejected on failure, so
// `res.body?.result || []` turned a rate-limited page into an empty one. Pagination then
// stopped early, the listing contributed zero rows, and the report was sent looking
// perfectly normal with a fraction of the real numbers. Observed live on 2026-11-11:
// 10 November recalculated as 39 occupied units instead of 83, with no error logged.
//
// These tests drive the real getHostawayData() against a stubbed https transport.

const { EventEmitter } = require('events');
const https = require('https');
const assert = require('assert');

process.env.HOSTAWAY_ACCOUNT_ID = 'test-account';
process.env.HOSTAWAY_API_KEY = 'test-key';
process.env.REPORT_DATE = '2026-11-10';

const { getHostawayData, DataIncompleteError } = require(process.env.MODULE_UNDER_TEST || './hostaway-report.js');

const realRequest = https.request;

// --- fixtures -------------------------------------------------------------------

const makeListing = (id) => ({ id, name: `L${id}`, internalListingName: `2BV-Test-${id}` });

function calendarEntries() {
  const out = [];
  for (const [month, days] of [['11', 30], ['12', 31]]) {
    for (let d = 1; d <= days; d++) {
      out.push({
        date: `2026-${month}-${String(d).padStart(2, '0')}`,
        status: 'available', countReservedUnits: 0, countBlockedUnits: 0, isAvailable: 1, price: 5000,
      });
    }
  }
  return out;
}

const makeReservation = (id, listingId) => ({
  id, listingId, listingMapId: listingId, status: 'confirmed', channelName: 'direct',
  arrivalDate: '2026-11-10', departureDate: '2026-11-12',
  reservationDate: '2026-11-01 10:00:00', insertedOn: '2026-11-01 10:00:05',
  totalPrice: 10000,
});

const FINANCE_FIELDS = [
  { formulaName: 'AccommodationFare', formulaResult: 8000 },
  { formulaName: 'pmCommission', formulaResult: 1600 },
  { formulaName: 'totalGuestFees', formulaResult: 500 },
  { formulaName: 'ChannelFee', formulaResult: 200 },
];

// --- transport stub --------------------------------------------------------------

let maxConcurrentCalendar = 0;
let inFlightCalendar = 0;

function installStub(plan) {
  maxConcurrentCalendar = 0;
  inFlightCalendar = 0;

  https.request = function (options, cb) {
    const req = new EventEmitter();
    req.write = () => {};
    req.destroy = () => {};
    req.end = () => {
      const isCalendar = (options.path || '').includes('/calendar');
      if (isCalendar) {
        inFlightCalendar++;
        maxConcurrentCalendar = Math.max(maxConcurrentCalendar, inFlightCalendar);
      }
      const finish = () => { if (isCalendar) inFlightCalendar--; };

      setImmediate(() => {
        const outcome = plan(options);
        if (outcome.transportError) {
          finish();
          req.emit('error', new Error(outcome.transportError));
          return;
        }
        const res = new EventEmitter();
        res.statusCode = outcome.status;
        cb(res);
        setImmediate(() => {
          if (outcome.body !== undefined) res.emit('data', JSON.stringify(outcome.body));
          finish();
          res.emit('end');
        });
      });
    };
    return req;
  };
}

// A plan that answers everything correctly. Tests override one path.
function healthyPlan({ listingCount = 3, reservationsPerListing = 2 } = {}) {
  return (options) => {
    const path = options.path || '';

    if (options.method === 'POST' && path.includes('accessTokens')) {
      return { status: 200, body: { access_token: 'stub-token' } };
    }
    if (path.startsWith('/v1/listings?')) {
      const offset = Number(new URL('https://x' + path).searchParams.get('offset'));
      return { status: 200, body: { result: offset === 0 ? Array.from({ length: listingCount }, (_, i) => makeListing(100 + i)) : [] } };
    }
    if (path.includes('/calendar')) {
      return { status: 200, body: { result: calendarEntries() } };
    }
    if (path.startsWith('/v1/reservations')) {
      const u = new URL('https://x' + path);
      const listingId = Number(u.searchParams.get('listingId'));
      const offset = Number(u.searchParams.get('offset'));
      if (offset > 0) return { status: 200, body: { result: [] } };
      return {
        status: 200,
        body: { result: Array.from({ length: reservationsPerListing }, (_, i) => makeReservation(listingId * 1000 + i, listingId)) },
      };
    }
    if (path.includes('financeCalculatedField')) {
      return { status: 200, body: { result: FINANCE_FIELDS } };
    }
    return { status: 404, body: { message: 'unexpected path ' + path } };
  };
}

// --- runner ----------------------------------------------------------------------

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push([true, name]);
    console.log(`  ✓ ${name}`);
  } catch (err) {
    results.push([false, name]);
    console.log(`  ✗ ${name}\n      ${err.message}`);
  }
}

async function expectIncomplete(plan, matcher) {
  installStub(plan);
  let thrown = null;
  try {
    await getHostawayData();
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown, 'expected the run to abort, but it completed - this is the silent-truncation bug');
  assert.ok(
    thrown instanceof DataIncompleteError,
    `expected DataIncompleteError, got ${thrown.name}: ${thrown.message}`
  );
  assert.ok(matcher.test(thrown.message), `message did not identify the source: ${thrown.message}`);
  return thrown;
}

(async () => {
  console.log('\nFETCH-FAILURE TESTS\n' + '='.repeat(70));

  await test('control: a healthy run returns every listing and reservation', async () => {
    installStub(healthyPlan({ listingCount: 3, reservationsPerListing: 2 }));
    const data = await getHostawayData();
    assert.strictEqual(data.listings.length, 3, 'listing count');
    assert.strictEqual(data.reservations.length, 6, 'reservation count');
    assert.strictEqual(Object.keys(data.calendar).length, 3, 'calendars loaded');
  });

  await test('listings: a failed page aborts instead of truncating the portfolio', async () => {
    const base = healthyPlan({ listingCount: 500 });
    await expectIncomplete((options) => {
      const path = options.path || '';
      if (path.startsWith('/v1/listings?') && path.includes('offset=500')) {
        return { status: 500, body: { message: 'upstream error' } };
      }
      return base(options);
    }, /listings page at offset 500/);
  });

  await test('calendar: a failed calendar aborts instead of dropping a unit', async () => {
    const base = healthyPlan();
    await expectIncomplete((options) => {
      const path = options.path || '';
      if (path.includes('/v1/listings/101/calendar')) return { status: 429, body: { message: 'rate limited' } };
      return base(options);
    }, /calendar for listing 101/);
  });

  await test('reservations: a failed page aborts instead of ending pagination early', async () => {
    const base = healthyPlan({ listingCount: 2, reservationsPerListing: 500 });
    await expectIncomplete((options) => {
      const path = options.path || '';
      if (path.startsWith('/v1/reservations') && path.includes('listingId=100') && path.includes('offset=500')) {
        return { transportError: 'socket hang up' };
      }
      return base(options);
    }, /reservations for listing 100 at offset 500/);
  });

  await test('a 200 response with no result array is a failure, not an empty page', async () => {
    const base = healthyPlan();
    await expectIncomplete((options) => {
      const path = options.path || '';
      if (path.includes('/v1/listings/102/calendar')) return { status: 200, body: { status: 'fail', message: 'quota exceeded' } };
      return base(options);
    }, /calendar for listing 102/);
  });

  await test('retries are preserved: two transient failures then success completes the run', async () => {
    const base = healthyPlan({ listingCount: 3, reservationsPerListing: 2 });
    let calendarAttempts = 0;
    installStub((options) => {
      const path = options.path || '';
      if (path.includes('/v1/listings/101/calendar')) {
        calendarAttempts++;
        if (calendarAttempts <= 2) return { status: 503, body: { message: 'unavailable' } };
      }
      return base(options);
    });
    const data = await getHostawayData();
    assert.strictEqual(calendarAttempts, 3, 'expected 2 retries then success');
    assert.strictEqual(data.listings.length, 3, 'run completed with all listings');
  });

  await test('concurrency limit of 5 is preserved', async () => {
    installStub(healthyPlan({ listingCount: 40, reservationsPerListing: 1 }));
    await getHostawayData();
    assert.ok(maxConcurrentCalendar > 1, `expected parallel work, saw ${maxConcurrentCalendar}`);
    assert.ok(maxConcurrentCalendar <= 5, `concurrency exceeded 5: ${maxConcurrentCalendar}`);
  });

  https.request = realRequest;

  const failed = results.filter(([ok]) => !ok);
  console.log('='.repeat(70));
  console.log(`${results.length - failed.length}/${results.length} passed`);
  if (failed.length) { console.error('\n✗ TESTS FAILED\n'); process.exit(1); }
  console.log('\n✓ ALL TESTS PASSED\n');
})();
