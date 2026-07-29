# Hostaway Report System - Resend to Gmail SMTP Migration Report

**Migration Date:** 2026-07-29  
**Status:** ✅ Complete  
**Migration Type:** Email Delivery Layer Replacement (Resend REST API → Gmail SMTP via Nodemailer)

---

## Executive Summary

Successfully migrated the email delivery system from Resend API to Gmail SMTP using Nodemailer. All Hostaway API logic, report calculations, WhatsApp/Twilio delivery, scheduling, and business rules remain unchanged. Only the email transport layer was replaced.

---

## Files Modified

### 1. `/hostaway-report.js` (Main Script)

#### Changes Made:
- **Lines 1-11:** Updated environment variable initialization
  - Removed: `RESEND_API_KEY`, `RESEND_SENDER`, `RESEND_RECIPIENTS`
  - Added: `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM`, `EMAIL_TO`
  - Added: `const nodemailer = require('nodemailer');` import

- **Lines 538-603:** Completely replaced `sendViaResend()` function with `sendViaGmail()`
  - New function uses Nodemailer transporter for Gmail SMTP
  - Validates all required SMTP environment variables before attempting connection
  - Parses `EMAIL_TO` as comma-separated recipients (supports Google Groups)
  - Verifies SMTP connection with `transporter.verify()` before sending
  - Sends email via `transporter.sendMail()` with both HTML and plain text
  - Comprehensive error handling distinguishing between:
    - Configuration validation errors
    - SMTP connection/authentication failures
    - Email delivery failures
  - Logs message ID and recipient count on success

- **Line 697:** Updated function call from `sendViaResend(emailReport)` to `sendViaGmail(emailReport)`

#### Preserved (No Changes):
- ✅ Lines 13-19: HTTPS Agent configuration for Hostaway API connection pooling
- ✅ Hostaway API OAuth2 client credentials flow
- ✅ All report calculations (occupancy, revenue, low-occupancy alerts)
- ✅ WhatsApp/Twilio delivery logic
- ✅ Report formatting and content structure
- ✅ IST timezone handling
- ✅ All other business logic

### 2. `/package.json` (Dependencies)

#### Changes Made:
- ✅ Confirmed: `"nodemailer": "^9.0.3"` is already installed

#### No Changes Needed:
- Resend was never added as a dependency (was using HTTPS directly)
- No dependencies were removed
- Nodemailer is the only new dependency

### 3. `/.github/workflows/daily-report.yml` (GitHub Actions)

#### Changes Made:
- **Lines 20-29:** Updated environment variables section
  - Removed: `RESEND_API_KEY`, `RESEND_SENDER`, `RESEND_RECIPIENT`
  - Added: `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM`, `EMAIL_TO`
  - All new variables reference secrets from GitHub repository

#### Preserved (No Changes):
- ✅ Hostaway API credentials: `HOSTAWAY_ACCOUNT_ID`, `HOSTAWAY_API_KEY`
- ✅ Twilio configuration: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`
- ✅ WhatsApp recipient: `WHATSAPP_RECIPIENT`
- ✅ Node.js version 18
- ✅ Cron schedule: `30 12 * * *` (6:00 PM IST / 12:30 UTC)
- ✅ Workflow dispatch (manual trigger support)

### 4. `/SETUP_INSTRUCTIONS.md` (Documentation)

#### Changes Made:
- Updated all references from Resend to Gmail SMTP
- Added Gmail App Password generation instructions with links
- Updated secret requirements table with Gmail-specific values
- Added SMTP configuration details for manual testing
- Updated version history and last-updated date

---

## Environment Variables Required

### For Local Testing

Create a `.env` file or set these in your shell:

```bash
# Hostaway API
HOSTAWAY_ACCOUNT_ID=52447
HOSTAWAY_API_KEY=your_hostaway_api_key

# Gmail SMTP Configuration
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-email@gmail.com
SMTP_PASS=your-app-password  # 16-char password, spaces removed
EMAIL_FROM=your-email@gmail.com
EMAIL_TO=sudhanshu@hireavilla.in,saagar@hireavilla.in,edwin@hireavilla.in,fiza@hireavilla.in

# Twilio (for WhatsApp)
TWILIO_ACCOUNT_SID=your_twilio_sid
TWILIO_AUTH_TOKEN=your_twilio_token
TWILIO_PHONE_NUMBER=+1234567890
WHATSAPP_RECIPIENT=+91XXXXXXXXXX
```

### For GitHub Actions

Add these secrets to your repository at `https://github.com/YOUR_REPO/settings/secrets/actions`:

| Secret Name | Example Value | Notes |
|-------------|---------------|-------|
| `HOSTAWAY_ACCOUNT_ID` | `52447` | Your Hostaway account ID |
| `HOSTAWAY_API_KEY` | (your API key) | Hostaway API credentials |
| `SMTP_HOST` | `smtp.gmail.com` | Gmail SMTP server |
| `SMTP_PORT` | `587` | SMTP port for STARTTLS |
| `SMTP_SECURE` | `false` | Use STARTTLS (not implicit TLS) |
| `SMTP_USER` | `your@gmail.com` | Gmail email address |
| `SMTP_PASS` | (16-char password) | [Gmail App Password](https://support.google.com/accounts/answer/185833) |
| `EMAIL_FROM` | `your@gmail.com` | Sender email address |
| `EMAIL_TO` | `email1,email2,...` | Comma-separated recipient list |
| `TWILIO_ACCOUNT_SID` | (your SID) | Twilio account ID |
| `TWILIO_AUTH_TOKEN` | (your token) | Twilio authentication token |
| `TWILIO_PHONE_NUMBER` | `+1234567890` | Twilio phone number for SMS/WhatsApp |
| `WHATSAPP_RECIPIENT` | `+91XXXXXXXXXX` | WhatsApp recipient number |

---

## How to Generate Gmail App Password

1. **Enable 2-Step Verification** (if not already enabled):
   - Go to https://myaccount.google.com/security
   - Click "2-Step Verification"
   - Follow the prompts to set up 2FA

2. **Generate App Password**:
   - Go to https://myaccount.google.com/apppasswords
   - Select "Mail" from the first dropdown
   - Select "Windows Computer" (or your device type) from the second dropdown
   - Click "Generate"
   - Copy the 16-character password displayed
   - **Remove all spaces** from the password
   - Use this as your `SMTP_PASS` value

3. **Add to GitHub Secrets**:
   - Go to your repository settings → Secrets and variables → Actions
   - Click "New repository secret"
   - Name: `SMTP_PASS`
   - Value: (paste the 16-character password without spaces)
   - Click "Add secret"

---

## Testing the Migration

### Manual Test (Local)

```bash
# 1. Set environment variables in your shell or .env file
export SMTP_HOST=smtp.gmail.com
export SMTP_PORT=587
export SMTP_SECURE=false
export SMTP_USER=your@gmail.com
export SMTP_PASS=your-16-char-app-password
export EMAIL_FROM=your@gmail.com
export EMAIL_TO=test@example.com
export HOSTAWAY_ACCOUNT_ID=52447
export HOSTAWAY_API_KEY=your-api-key
export TWILIO_ACCOUNT_SID=your-sid
export TWILIO_AUTH_TOKEN=your-token
export TWILIO_PHONE_NUMBER=+1234567890
export WHATSAPP_RECIPIENT=+91XXXXXXXXXX

# 2. Run the script
node hostaway-report.js

# 3. Look for this in the output:
# ✓ SMTP connection verified successfully
# ✓ Email sent successfully
# Message ID: <...@gmail.com>
# Recipients: 4
```

### Automated Test (GitHub Actions)

1. Go to your repository → Actions → "Hostaway Daily Report"
2. Click "Run workflow" → "Run workflow"
3. Wait for execution to complete
4. Check the logs for:
   - "✓ SMTP connection verified successfully"
   - "✓ Email sent successfully"
   - Message ID and recipient count

---

## Error Handling & Logging

The new `sendViaGmail()` function logs:

| Condition | Log Message | Level |
|-----------|-------------|-------|
| Missing SMTP config | `❌ Missing email configuration: ...` | ERROR |
| No recipients | `Email skipped: No recipients configured` | LOG |
| SMTP verification failed | `❌ SMTP verification failed: ...` | ERROR |
| Email sent successfully | `✓ Email sent successfully` | LOG |
| Delivery failed | `❌ Email delivery failed: ...` | ERROR |

### Key Error Codes to Watch For:

- **Authentication failures**: `err.code = 'EAUTH'` - Check `SMTP_USER` and `SMTP_PASS`
- **Connection refused**: `err.code = 'ECONNREFUSED'` - Check `SMTP_HOST` and `SMTP_PORT`
- **Timeout**: `err.code = 'ETIMEDOUT'` - Network or firewall issue
- **SMTP response codes**: `err.responseCode` - Gmail-specific error (e.g., 535 = invalid credentials)

---

## Backward Compatibility

- ✅ No breaking changes to report logic
- ✅ No breaking changes to calculations or formatting
- ✅ No breaking changes to Hostaway API integration
- ✅ No breaking changes to WhatsApp/Twilio delivery
- ✅ Same daily schedule: 6:00 PM IST (12:30 UTC)
- ✅ Same cron expression: `30 12 * * *`
- ✅ Same report contents and structure
- ✅ Same low-occupancy alert logic
- ✅ Same timezone handling (IST)

---

## Security Considerations

1. **No Hardcoded Credentials**: All SMTP credentials are passed via environment variables
2. **GitHub Secrets**: All credentials stored as GitHub repository secrets (encrypted)
3. **STARTTLS**: Uses port 587 with STARTTLS (not implicit TLS on port 465)
4. **App Passwords**: Gmail App Password is used instead of main account password
5. **Error Logging**: Sensitive data (passwords) never logged; only error codes logged

---

## Verification Checklist

- ✅ `package.json`: Nodemailer 9.0.3 installed
- ✅ `hostaway-report.js`: 
  - Environment variables updated (lines 1-11)
  - `sendViaGmail()` function implemented (lines 538-603)
  - Function call updated (line 697)
  - All other logic preserved
- ✅ `.github/workflows/daily-report.yml`: SMTP secrets configured
- ✅ `SETUP_INSTRUCTIONS.md`: Updated with Gmail configuration
- ✅ Error handling: Validates config, verifies SMTP, distinguishes error types
- ✅ Multi-recipient support: Parses `EMAIL_TO` as comma-separated list
- ✅ No hardcoded credentials or sensitive data
- ✅ SMTP connection verification before sending
- ✅ Comprehensive logging for debugging

---

## Troubleshooting

### "Missing email configuration" error
- Check that all SMTP_* and EMAIL_* environment variables are set
- Verify no typos in variable names

### "SMTP verification failed: Invalid login"
- Verify Gmail address is correct
- Confirm you're using an [App Password](https://support.google.com/accounts/answer/185833), not your main Gmail password
- Ensure 2-Step Verification is enabled on your Google account
- Remove spaces from the 16-character app password

### "SMTP verification failed: connect ECONNREFUSED"
- Check `SMTP_HOST=smtp.gmail.com` (typos?)
- Check `SMTP_PORT=587` (should not be 465)
- Verify network access to gmail.com
- Check if firewall blocks port 587

### Email never arrives
- Check logs for delivery status
- Verify recipient email addresses in `EMAIL_TO`
- Check spam folder
- Verify sender email (`EMAIL_FROM`) has permission to send

### WhatsApp message not sent but email succeeded
- Email and WhatsApp failures are independent
- Check Twilio logs separately
- Verify WhatsApp recipient phone number format

---

## Rollback Plan

If you need to rollback to Resend:

1. Revert `hostaway-report.js` to previous version
2. Revert `.github/workflows/daily-report.yml` to previous version
3. Update GitHub secrets from SMTP_* back to RESEND_*
4. No changes needed to `package.json` (nodemailer can coexist with resend)

---

## Next Steps

1. **Generate Gmail App Password** using instructions above
2. **Add GitHub Secrets** for SMTP configuration
3. **Test Locally** by running: `node hostaway-report.js`
4. **Test via GitHub Actions** by manually triggering the workflow
5. **Monitor First Scheduled Run** at 6:00 PM IST to verify email delivery
6. **Archive This Report** for future reference

---

**Migration Completed By:** Automated Migration Tool  
**Verification Status:** ✅ All code changes verified  
**Ready for Production:** ✅ Yes (after GitHub secrets are configured)
