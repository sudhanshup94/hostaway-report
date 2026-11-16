# Hireavilla Sales Reporting — Cloud Run

This deployment runs two focused, independently scheduled emails from the same tested
report code:

| Job | Schedule (IST) | Email |
| --- | --- | --- |
| `hireavilla-daily-operations` | 18:00 | Daily Operations Snapshot |
| `hireavilla-sales-portfolio` | 18:15 | Sales & Portfolio Report |

The jobs use Secret Manager for Hostaway and SMTP credentials. The existing GitHub
schedule remains active during validation. Cloud Scheduler jobs are created paused and
must only be unpaused after successful shadow dry runs.

Required Secret Manager secret names:

- `hostaway-account-id`
- `hostaway-api-key`
- `smtp-host`
- `smtp-port`
- `smtp-secure`
- `smtp-user`
- `smtp-pass`
- `email-from`
- `email-to`

The deployment script never stores or prints secret values.
