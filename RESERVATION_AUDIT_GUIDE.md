# Reservation-Level Audit Guide

This guide explains how to run the reservation-level audit to isolate whether incorrect report numbers are caused by the reservation-fetching and filtering process.

## What This Audit Does

The `reservation-audit.js` script:
- Fetches the exact same reservation data as `hostaway-report.js`
- Applies the exact same filters as `hostaway-report.js`
- Captures all intermediate data for analysis
- Generates comprehensive diagnostic CSV files
- **Does NOT** modify any production code
- **Does NOT** change any calculations, formulas, or business logic
- **Does NOT** alter the main workflow or email delivery

## What You'll Get

The audit generates these diagnostic files in `./diagnostics/`:

| File | Purpose |
|------|---------|
| `reservation-filter-trace.csv` | Every reservation with filter results |
| `reservations-excluded.csv` | All excluded reservations with reasons |
| `accommodation-reservations-considered.csv` | Reservations contributing to accommodation fare |
| `pm-commission-reservations-considered.csv` | Reservations contributing to PM commission |
| `cleaning-fee-reservations-considered.csv` | Reservations contributing to cleaning fee |
| `all-reservations-raw-sanitised.csv` | All fetched reservations (raw, before filtering) |
| `audit-summary.txt` | Summary of filtering funnel and totals |

## How to Run the Audit

### Prerequisites

1. Set environment variables (same as main workflow):
```bash
export HOSTAWAY_ACCOUNT_ID=52447
export HOSTAWAY_API_KEY=your_api_key
export SMTP_HOST=smtp.gmail.com
export SMTP_PORT=587
export SMTP_SECURE=false
export SMTP_USER=your_gmail@gmail.com
export SMTP_PASS=your_app_password
export EMAIL_FROM=your_gmail@gmail.com
export EMAIL_TO=recipient@example.com
```

2. Navigate to the project directory:
```bash
cd /Users/sudhanshupatil/hostaway-report
```

### Run the Audit

```bash
node reservation-audit.js
```

**Expected output**:
```
╔════════════════════════════════════════════╗
║   RESERVATION-LEVEL AUDIT TOOL             ║
╚════════════════════════════════════════════╝

Report Date (IST): 2026-07-29
Audit Generated: 2026-07-31T12:34:56.789Z
Git Commit: 19ee09d...
Git Branch: main
Account ID: XXXX2447
Timezone: Asia/Kolkata

🔐 Authenticating...
✓ Authenticated

📋 Fetching listings...
✓ Fetched 99 listings

📑 Fetching reservations per listing...
✓ Fetched 35 total reservations across 98 listings

💰 Fetching PM Commission...
✓ Fetched PM Commission for 35 reservations

🔍 Applying filters...
✓ After all filters: 35 reservations remain
  - Listing filter removed: 0
  - Status filter removed: 0
  - Date filter removed: 0

📊 Building filter trace...

💵 Metric Totals (Reconstructed from Reservation Level):
  Accommodation Fare: ₹182231.48
  PM Commission: ₹46352.40
  Cleaning Fee: ₹3923.00
  Occupied Units (Guest): 30

📁 Writing diagnostic files...
✓ Diagnostics written to ./diagnostics/

✅ Audit complete!

Files created:
  - reservation-filter-trace.csv
  - reservations-excluded.csv
  - accommodation-reservations-considered.csv
  - pm-commission-reservations-considered.csv
  - cleaning-fee-reservations-considered.csv
  - all-reservations-raw-sanitised.csv
  - audit-summary.txt
```

### Interpreting the Output

The script will display:

1. **Report Date**: The date being audited (in Asia/Kolkata timezone)
2. **Fetched Reservations**: Total count of reservations returned by the API
3. **Filter Results**: How many reservations pass each filter
4. **Metric Totals**: Accommodation, PM Commission, Cleaning Fee, Occupied Units

## Reconciliation Process

### Step 1: Export Raw Hostaway Data

1. Log into Hostaway
2. Go to **Reservations** → **Reports**
3. Create a custom report with:
   - **Date Filter**: Same as audit report date (e.g., 2026-07-29)
   - **Status Filter**: `active`, `confirmed`, `new`, `modified` (matching API filters)
   - **Export Format**: CSV
4. Download the CSV file

### Step 2: Compare with Audit Output

1. Open `diagnostics/all-reservations-raw-sanitised.csv`
2. This is the raw data fetched by the API
3. Compare with your Hostaway export:
   - Do all reservation IDs match?
   - Are the statuses the same?
   - Are the arrival/departure dates correct?

### Step 3: Verify Filter Logic

1. Open `diagnostics/reservation-filter-trace.csv`
2. For each reservation marked `Included: YES`:
   - Check: `Passed Status Filter: YES`
   - Check: `Passed Date Filter: YES`
   - Check: `Passed Listing Filter: YES`
   - **If any show NO, there's a filtering defect**

### Step 4: Verify Metric Calculations

1. Open `diagnostics/accommodation-reservations-considered.csv`
2. Sum the `Daily Accommodation Amount` column
3. Compare with the `Accommodation Fare` value in the main report
4. **If they don't match, there's a calculation defect**

Repeat for:
- `pm-commission-reservations-considered.csv`
- `cleaning-fee-reservations-considered.csv`

## What the Audit Does NOT Do

❌ Does NOT modify `hostaway-report.js`  
❌ Does NOT change production calculations  
❌ Does NOT alter email delivery  
❌ Does NOT modify GitHub Actions workflow  
❌ Does NOT change any business logic  

The audit is **purely diagnostic** - it captures data for analysis only.

## Understanding Filter Stages

The audit applies filters in this order:

### Filter 1: Listing Exclusion
```javascript
!EXCLUDED_LISTINGS.includes(reservation.listingId)
```
- Removes reservations for listing ID 488785
- **Purpose**: Exclude test/sandbox listing

### Filter 2: Status Filter
```javascript
['active', 'confirmed', 'new', 'modified'].includes(reservation.status)
```
- Removes reservations with other statuses (cancelled, pending, etc.)
- **Purpose**: Include only confirmed guest bookings

### Filter 3: Date Overlap Filter
```javascript
arrival_date <= report_date AND departure_date > report_date
```
- Removes reservations that don't overlap the report date
- **Purpose**: Include only reservations active on the report date

**Example**: A reservation with arrival 2026-07-29 and departure 2026-07-30:
- ✅ Passes: arrival (2026-07-29) ≤ report date (2026-07-29)
- ✅ Passes: departure (2026-07-30) > report date (2026-07-29)
- **Result**: Included

**Example**: A reservation with arrival 2026-07-27 and departure 2026-07-29:
- ✅ Passes: arrival (2026-07-27) ≤ report date (2026-07-29)
- ❌ Fails: departure (2026-07-29) is NOT > report date (2026-07-29)
- **Result**: Excluded (checkout date is not an occupied night)

## Checking for Data Loss

Look for these in the audit output:

### 1. **API Timeout**
If the PM Commission fetch shows errors:
```
⚠️ Errors fetching PM Commission: X
```
Then some PM Commission values may be 0 (data loss).

### 2. **Pagination Issues**
If fetched < API total:
```
API total records: 40
Records fetched: 35
```
Then pagination is incomplete (data loss).

### 3. **Excluded Reservations**
If unexpectedly high:
```
Excluded reservations: 20
```
Then filtering may be too aggressive (possible data loss).

## Troubleshooting

### Script Fails With "Failed to get token"
- Check `HOSTAWAY_ACCOUNT_ID` and `HOSTAWAY_API_KEY` are set
- Verify API key is valid and not expired
- Check Hostaway account has API access enabled

### Script Shows "Fetched 0 reservations"
- Check the report date (audit uses today's IST date)
- Check Hostaway has reservations for that date
- Verify `departureDateFrom` parameter is correctly set

### Metric totals don't match the main report
- Check if PM Commission fetch had errors
- Check if any reservations were excluded
- Review `reservation-filter-trace.csv` for "Included: NO" entries

## Files Generated

### `reservation-filter-trace.csv`
**Use this to**: Verify every reservation was correctly included/excluded

**Columns**:
- `Reservation ID`: Hostaway reservation ID
- `Listing ID`: Property ID
- `Status`: Reservation status from API
- `Arrival`: Check-in date
- `Departure`: Check-out date
- `Nights`: Number of nights
- `Passed Status Filter`: YES/NO
- `Passed Date Filter`: YES/NO
- `Passed Listing Filter`: YES/NO
- `Included`: YES/NO (final decision)
- `Reason`: Why included or excluded

### `reservations-excluded.csv`
**Use this to**: Understand why any reservation wasn't counted

**Columns**:
- `Reservation ID`: Hostaway reservation ID
- `Excluded From`: Which metrics (Occupancy, Accommodation, PM Commission, etc.)
- `First Excluding Filter`: Which filter removed it
- `All Exclusion Reasons`: List of all reasons
- `Potentially Incorrect`: Flag if exclusion seems wrong

### `accommodation-reservations-considered.csv`
**Use this to**: Verify accommodation fare calculation

**Columns**:
- `Daily Accommodation Amount`: Prorated amount for today
- `Included`: Always YES for this file
- **Total row at bottom**: Sum should match report

### `pm-commission-reservations-considered.csv`
**Use this to**: Verify PM commission calculation

### `cleaning-fee-reservations-considered.csv`
**Use this to**: Verify cleaning fee calculation

### `all-reservations-raw-sanitised.csv`
**Use this to**: Compare against raw Hostaway export

**Note**: Personal information is masked:
- Guest names replaced with `GUEST_{reservation_id}`
- Email addresses replaced with `REDACTED`
- Phone numbers replaced with `REDACTED`

But reservation IDs, dates, and financial values are visible for reconciliation.

## Next Steps After Running Audit

1. **Compare with Hostaway Export**:
   - Export same date from Hostaway
   - Check if all reservations are in `all-reservations-raw-sanitised.csv`
   - Verify statuses, dates, and amounts match

2. **Verify Metric Calculations**:
   - Sum columns in metric CSVs
   - Compare with main report totals
   - If different, see "Troubleshooting" section

3. **Report Findings**:
   - If audit totals match main report totals: Filtering is correct
   - If audit totals differ: Check for API errors, timeouts, or calculation defects
   - If Hostaway export differs from audit: Check API data completeness

## Important Notes

- The audit uses the **exact same code** as production for filtering
- The audit uses the **exact same API endpoints** as production
- The audit **replicates filtering in the same order** as production
- The audit **does not modify** any production code during execution
- The audit **is safe to run** at any time without affecting the live system

---

**Created**: 2026-07-31  
**Git Commit**: 19ee09d  
**Author**: Diagnostic Tool
