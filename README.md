# Hostaway Daily Report Agent

Automated daily reports from Hostaway sent via email (Resend) and WhatsApp (Meta Business Cloud API).

## Setup

### 1. Create a GitHub Repository

```bash
cd ~/hostaway-report
git init
git add .
git commit -m "Initial commit"
git branch -M main
```

Then go to https://github.com/new and create a repository named `hostaway-report`. Once created, push:

```bash
git remote add origin https://github.com/YOUR_USERNAME/hostaway-report.git
git push -u origin main
```

### 2. Add Secrets to GitHub

Go to your repo on GitHub → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**

Add these secrets (copy/paste the values):

| Secret Name | Value |
|-------------|-------|
| `HOSTAWAY_ACCOUNT_ID` | `52447` |
| `HOSTAWAY_API_KEY` | Your API key |
| `RESEND_API_KEY` | `re_GKC7A149_DhVbEZfNXdYGc6XfRZaHELha` |
| `RESEND_SENDER` | `onboarding@resend.dev` |
| `RESEND_RECIPIENT` | `sudhanshu@hireavilla.in` |
| `WHATSAPP_PHONE_ID` | `593897667139589` |
| `WHATSAPP_ACCESS_TOKEN` | Your access token |
| `WHATSAPP_RECIPIENT` | `+919766020269` |

### 3. Enable Workflows

Go to **Actions** tab → click "I understand my workflows..." → Enable workflows

### 4. Test

In the **Actions** tab, select "Hostaway Daily Report" and click **Run workflow** → **Run workflow**. Check the logs.

## Schedule

The workflow runs automatically **every day at 11:00 AM IST** (5:30 AM UTC).

## Local Testing

Set environment variables and run:

```bash
export HOSTAWAY_ACCOUNT_ID=52447
export HOSTAWAY_API_KEY=your_key
export RESEND_API_KEY=your_key
export RESEND_SENDER=onboarding@resend.dev
export RESEND_RECIPIENT=sudhanshu@hireavilla.in
export WHATSAPP_PHONE_ID=593897667139589
export WHATSAPP_ACCESS_TOKEN=your_token
export WHATSAPP_RECIPIENT=+919766020269

node hostaway-report.js
```

## Report Contents

- 💰 **Revenue**: Total from active reservations
- 🏠 **Reservations**: List of active bookings
- 💬 **Messages**: Count of unread guest messages
- 📈 **Occupancy**: Number of active listings
