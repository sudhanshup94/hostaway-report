# Hostaway Daily Report - Setup Instructions

## Configuration Complete ✅

The report script has been migrated to **Gmail SMTP via Nodemailer** for reliable email delivery to multiple recipients.

## Setup: Update GitHub Secrets

To send the daily report to your team, add the following secrets to your GitHub repository:

### 1. Go to GitHub Repository Settings
```
https://github.com/YOUR_REPO/settings/secrets/actions
```

### 2. Add Gmail SMTP Secrets

For Gmail SMTP with an [App Password](https://support.google.com/accounts/answer/185833):

| Secret | Value |
|--------|-------|
| `SMTP_HOST` | `smtp.gmail.com` |
| `SMTP_PORT` | `587` |
| `SMTP_SECURE` | `false` |
| `SMTP_USER` | Your Gmail address (e.g., your@gmail.com) |
| `SMTP_PASS` | Your Gmail App Password (16 characters, spaces removed) |
| `EMAIL_FROM` | Your Gmail address (e.g., your@gmail.com) |
| `EMAIL_TO` | `sudhanshu@hireavilla.in,saagar@hireavilla.in,edwin@hireavilla.in,fiza@hireavilla.in` |

### 3. Ensure Other Secrets Are Set
Make sure these secrets exist in GitHub:
- ✅ `HOSTAWAY_ACCOUNT_ID` → 52447
- ✅ `HOSTAWAY_API_KEY` → Your API key
- ✅ `TWILIO_ACCOUNT_SID` → Your Twilio account SID
- ✅ `TWILIO_AUTH_TOKEN` → Your Twilio auth token
- ✅ `TWILIO_PHONE_NUMBER` → Your Twilio phone number
- ✅ `WHATSAPP_RECIPIENT` → WhatsApp recipient number

## How to Generate Gmail App Password

1. Enable 2-Step Verification on your Google account: https://myaccount.google.com/security
2. Go to App Passwords: https://myaccount.google.com/apppasswords
3. Select "Mail" and "Windows Computer" (or your device)
4. Copy the 16-character password and remove spaces
5. Use this as your `SMTP_PASS` secret

## Schedule

The report will run **automatically every day at 6:00 PM IST** (12:30 UTC)

## Manual Trigger

You can also manually trigger the report from GitHub Actions:
1. Go to your repo → Actions → "Hostaway Daily Report"
2. Click "Run workflow" → "Run workflow"

## How It Works

1. ✅ Fetches data from Hostaway API for all properties
2. ✅ Calculates occupancy metrics and revenue
3. ✅ Identifies low-occupancy properties for next 15 days
4. ✅ **Sends email via Gmail SMTP to all 4 recipients** with complete report
5. ✅ Uses parallelized API calls for fast execution (~2-3 minutes)
6. ✅ Verifies SMTP connection before sending email
7. ✅ Comprehensive error handling and logging

## Report Contents

- Total units & occupancy %
- Revenue breakdown (accommodation fare, PM commission, cleaning fees)
- Occupied units list with booking channels
- Low occupancy alerts for sales team
- Next 15-day occupancy forecast

---

**Last Updated:** 2026-07-29
**Report Script Version:** 3.0 (Gmail SMTP via Nodemailer)
**Email Delivery:** Nodemailer 9.0.3 with Gmail SMTP
**Recipients:** 4 team members via comma-separated EMAIL_TO
