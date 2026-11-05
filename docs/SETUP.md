# Setup guide: from zero to your first email

This takes an afternoon of your time, plus a few days of waiting if you buy new mailboxes. Nothing is sent
until every step that matters is done, so you can go at your own pace.

**The short version**

1. Install and start the app (10 minutes).
2. Tell it about your business (20 minutes).
3. Describe who you sell to (10 minutes).
4. Get sending mailboxes on separate domains, and add them (1-3 days of waiting).
5. Choose where leads come from (10 minutes).
6. Turn on email verification (5 minutes).
7. Approve your first emails (ongoing for a few days).

---

## 1. Install and start

You need [Docker](https://docs.docker.com/get-docker/) (Docker Desktop on a Mac or PC, Docker Engine on
Linux) and [Node.js 22+](https://nodejs.org). On your own computer is fine to start; move to a server
later ([DEPLOY.md](DEPLOY.md)) so it keeps running when your laptop is closed.

```bash
git clone https://github.com/deanayoung3-droid/opengtm.git && cd opengtm
node scripts/setup.mjs
docker compose up -d
```

The setup asks a few questions and writes two files you keep private:

- `.env`: passwords and API keys. It generates the database password, your dashboard password and the
  secret that signs unsubscribe links. **Never change `UNSUBSCRIBE_SECRET` once you've sent email**:
  unsubscribe links already in people's inboxes depend on it.
- `config/business.yaml`: your business profile. If you give it your website and an AI key, it reads
  your site and drafts the profile for you. You review it in the next step.

Then open **http://localhost:8080** and sign in. The status card at the bottom left of the sidebar says
"Not sending yet" and what's missing. Run `node scripts/setup.mjs` again any time; it keeps what's there.

> **Just looking?** Put `GTM_DRY_RUN=1` in `.env` and run `docker compose up -d` again. The app then uses
> fake mailboxes, a fake lead source and fake verification, so you can watch the whole pipeline work
> without sending anything or spending money (AI calls are still real if a key is set).

## 2. Tell it about your business (Project docs)

Open **Project docs** in the dashboard. Everything the AI writes comes from this page, and changes apply
to the next draft. The most important fields:

| Field | What to write | Example |
|---|---|---|
| Company, website | Your company's name and site | Northwind, https://northwind.com |
| One-liner | What you sell, in plain words | Scheduling software for small field-service teams |
| Why it exists | The problem you solve | Service teams run their day on a whiteboard and a group text |
| Proof points | **True, specific, checkable** claims. The writer can't claim anything about you that isn't here | "$29 a month for the whole office, not per user" |
| Never say | Phrases the checker blocks | guaranteed, #1 |
| The offer | What replying "yes" gets them. Make it free and easy | a 2-minute video of a day on the dispatch board |
| Pricing | As you'd quote it | $29/month per office |
| Competitors | Names only. When research finds a company using one, the email mentions it | Jobber, Housecall Pro |
| Booking link | Your calendar link. Only sent in replies to people who wrote back | https://cal.com/you/intro |
| Postal address | **Required by law** (CAN-SPAM) in every email | 100 Main St, Austin, TX 78701 |

Good proof points are what makes emails work. "Saves time" is useless; "most teams are set up in one
afternoon" is good. If it isn't true, don't add it: the checker can only stop claims that aren't on the
list, not untrue ones you put there.

On **Email sequence** you'll find the writing instructions (tone, things to always or never do), the
reply word ("yes" by default: the first email asks people to just reply "yes"), and senders.

## 3. Describe who you sell to (Targeting)

Open **Targeting**. Each campaign is one kind of customer:

- **Description**: who they are, in a sentence. The writer reads it.
- **Keywords**: words those companies use on their own websites ("hvac", "furnace repair"). The lead
  search looks for them, and the fit score checks them.
- **Roles** (in `business.yaml`, `icp.roles`): the titles you want to reach, most important first.

Start with two or three campaigns. Each gets its own numbers, so you'll see which kind of customer answers.

## 4. Get sending mailboxes

**Never send cold email from your main domain.** If something goes wrong, you want a spare domain to
take the hit, not the one your customers and invoices use.

1. **Buy 2-3 domains** that look related to your company (`getnorthwind.com`, `northwindhq.com`).
   Point each one's website at your real site with a redirect.
2. **Get 2-5 inboxes per domain.** The fastest route is a vendor that sells **pre-warmed** Google or
   Microsoft inboxes and sets up DNS for you (search "pre-warmed cold email inboxes"; they cost about
   $3-5 per inbox per month). Or create them yourself in Google Workspace / Microsoft 365, and start with
   the slow ramp in `config/engine.yaml` (see the comment under `ramp:`).
3. **Check DNS** for each domain. SPF, DKIM and DMARC must pass:
   ```bash
   ./gtm dns-check getnorthwind.com
   ```
4. **Add the inboxes** on **Channels**: upload the vendor's CSV (or paste lines of
   `email,app password,first name,last name`). Each login is tested before it's saved, and passwords are
   stored encrypted. For Google inboxes you need an *app password* (Google Account → Security → 2-Step
   Verification → App passwords), not the normal password.
5. **Set each sender's name and signature** on Channels. Use real team members, or names your company
   has approved; every email still says it's from your company.

New inboxes start at 15 emails a day and ramp up by themselves (`ramp:` in `engine.yaml`). Pre-warmed
inboxes can be used the day you get them; brand-new ones need a few weeks of gentle sending.

## 5. Choose where leads come from

You need at least one:

- **AI Ark** (a people-search database with verified emails). Put `AI_ARK_API_KEY` in `.env`, read their
  terms, and set `AI_ARK_TERMS_OK=1` if outbound email is allowed. Each weekday morning the app buys only
  as many leads as your mailboxes can email in the next few days. Budget settings: `leads.ai_ark` in
  `engine.yaml`.
- **Your own CSV.** Columns: `company,domain,website,state,city,company_size,focus_areas,first_name,last_name,title,email`
  (see `data/leads.example.csv`). Put the file in `data/`, then:
  ```bash
  ./gtm import-leads data/my-leads.csv --source my-list --terms-ok
  ```
  Only pass `--terms-ok` if you're allowed to email these people (for example, you bought the list on terms
  that allow outbound email, or they're your own contacts).
- **Company websites.** Set `GTM_COMPANY_SITE_SOURCE_OK=1` to also look for people on companies'
  contact and team pages.

Every lead is scored against your campaigns. Poor fits are dropped with the reason, and you can see all of
it on **Leads**.

## 6. Turn on email verification

Bounces are the fastest way to burn a mailbox. Put a `ZEROBOUNCE_API_KEY` in `.env` (100 free checks a
month, then about $0.01-0.02 each). Addresses that aren't confirmed valid are never emailed. AI Ark's own
verified emails get a second opinion from ZeroBounce when a key is set.

## 7. Your first emails

Restart after editing `.env`: `docker compose up -d`.

- **Approvals.** By default a person approves the first 50 emails (`approval.require_first_n`). Read each
  one next to the facts it cites; approve, edit (edits are re-checked), or reject. After 50, emails that
  pass every check send by themselves, and anything the checker flags still waits for you. You can force
  approval of everything in **Settings**.
- **Schedule** shows when every job runs and when emails go out. Emails only go out in each recipient's
  business hours, a few minutes apart.
- **Kill switch.** The big button on the Dashboard (or `./gtm kill on`) stops all sending at once.

## 8. Replies and hot leads

Replies are read every few minutes. On **Team**, add the people who should hear about them, then choose
in **Settings → Email notifications** who gets hot leads, every reply, or problems.

When someone says yes, they show up under **Inbox → Hot** with a drafted answer (the offer, then your
booking link) and a one-page brief on their **Lead** page for the call. Hot leads never get an automatic
answer; a person sends it. Answers to objections send by themselves after a review window (4 hours by
default, in Settings) unless someone edits or holds them.

## Ready-to-send checklist

- [ ] Postal address and at least one sender (Project docs, Email sequence)
- [ ] Proof points you'd stand behind, and an offer worth a one-word reply
- [ ] Two or more campaigns with keywords
- [ ] Mailboxes on separate domains, DNS passing, added on Channels
- [ ] A lead source, and ZeroBounce for verification
- [ ] `PUBLIC_BASE_URL` set once it's on the internet, so unsubscribe links are one click
- [ ] Someone on the Team list to get hot-lead emails

Then read [RUNBOOK.md](RUNBOOK.md) for the daily routine.
