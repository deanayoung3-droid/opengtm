# Security

Please report security problems privately, through GitHub's "Report a vulnerability" on this repository,
not in a public issue. We'll reply as soon as we can.

## How OpenGTM protects data

- Secrets live in `.env` (never in git). Mailbox passwords imported in the dashboard are stored encrypted
  (AES-256-GCM, with a key derived from `MAILBOX_SECRET_KEY` or `UNSUBSCRIBE_SECRET`).
- The dashboard requires a login on every page except the unsubscribe pages and health checks. Run it
  behind HTTPS (see docs/DEPLOY.md).
- Logs redact secrets. Emails carry no tracking pixels or remote images.
- Every dashboard action is written to an audit log.
- `./gtm delete-contact` erases a person's data and keeps only a suppression entry.
