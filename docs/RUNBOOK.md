# Runbook

How to run OpenGTM day to day, and what to do when it tells you something. Admin commands below use
`./gtm` (Docker install); without Docker, use `pnpm gtm` instead.

## Daily (5-10 minutes)

1. **Dashboard**: sends, replies, hot leads and spend. A red banner means the kill switch is on.
2. **Inbox → Hot**: answer interested people the same day. The drafted reply is ready; read it, edit if
   needed, send. Their **Lead** page has a one-page brief for the call.
3. **Approvals**: anything the checker held back. Check each claim against its source link; approve,
   edit (edits are re-checked) or reject (stops that conversation).
4. **Channels**: anything paused? Read the reason before resuming.

## Weekly

- Read the Monday digest email (also on the Settings page) and do what it recommends.
- **Targeting**: look at replies per campaign; pause what doesn't work, and approve or reject proposed
  challenger versions.
- Check that a placement test ran for every mailbox, if you set up seed inboxes.
- Make sure backups are running (`ls backups/`), and test a restore now and then
  (`docker compose exec backup restore-check.sh`).

## Automatic guardrails

| What happens | What it does by itself | What you do |
|---|---|---|
| A mailbox's hard bounces reach 2% (at least 3, over its last 14 days) | Pauses the mailbox, alerts you | Look at what bounced (Suppress list). A bad lead source? Stop it. Resuming starts its count over |
| A domain's spam complaints reach 0.1% (hostile replies count) | Pauses the domain | Read the complaint; tighten targeting or copy before resuming |
| Placement tests land below 85% in the inbox | Retires the mailbox or domain | Replace it; check DNS with `./gtm dns-check domain.com` |
| A mailbox's login fails, or the provider throttles it | Pauses the mailbox | Fix the password (re-upload on Channels) or wait, then Resume |
| The daily spend cap is reached | Paid AI and verification stop until midnight | Raise `caps.daily_spend_cap_usd` only on purpose |
| The daily send cap or a mailbox's ramp is reached | Emails wait for tomorrow | Nothing. Don't raise caps to catch up |
| A campaign gets 150 sends and no interest | Pauses the campaign | Rework its copy or who it targets |
| A job keeps failing | Alerts you (at most once a day per job) | `docker compose logs app` |

## When something goes wrong

**Stop everything now.** The kill switch on the Dashboard, or `./gtm kill on --reason "..."`. Sending,
follow-ups and reply sends stop at once; reading replies and drafting continue. `./gtm kill off` resumes.

**"Send outcome unknown".** The app stopped between starting a send and recording it. It never resends
on its own, so a person is never emailed twice. Look in that mailbox's Sent folder to see whether it
went out; the alert names the message.

**A bounce spike.** Kill switch on. Find what the bounced addresses have in common (Leads, Suppress list).
Suppress a bad domain (`./gtm suppress domain.com`) or stop that lead source, then turn sending back on.

**Someone asks you to stop, outside email.** `./gtm suppress person@company.com --reason "asked by phone"`,
or the domain to cover the whole company. It's permanent.

**Someone asks you to delete their data.** `./gtm delete-contact person@company.com`. Their data is erased
and a suppression entry is kept, so they're never picked up again.

**The server was down.** Nothing to do. Queues live in the database, jobs are safe to repeat, and the
containers restart themselves. Emails due while it was down go out in the next sending window, within caps.

## Adding mailboxes

1. Buy a domain and inboxes (pre-warmed if you can). The vendor usually sets up DNS; confirm with
   `./gtm dns-check newdomain.com` until SPF, DKIM, DMARC and MX all pass.
2. Upload the vendor's CSV on **Channels**. Each login is tested before it's saved.
3. New inboxes start at the first ramp tier (15 a day) and grow by themselves, never past 40 a day each.

## Changing how it writes

- Proof points, offer, banned phrases, tone: **Project docs** and **Email sequence**.
- The instructions themselves: `prompts/write_email.md` (bump `version:`).
- Which model writes: `config/llm.yaml` (`write_email`).
- Volume, pacing, thresholds: `config/engine.yaml`, then `docker compose restart app`.
