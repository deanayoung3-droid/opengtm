# Configuration

Four places hold settings. Most people only ever touch the first two.

| Where | What | How to change |
|---|---|---|
| **Dashboard** (Project docs, Email sequence, Targeting, Channels, Settings) | Your business profile, campaigns, mailboxes, approval and auto-reply | Edit and save; applies to the next draft |
| `.env` | Passwords, API keys, time zone, public URL | Edit, then `docker compose up -d` |
| `config/business.yaml` | The starting point for your business profile (the dashboard overrides it) | Edit, then `docker compose restart app` |
| `config/engine.yaml`, `config/llm.yaml` | Volume, pacing, guardrails, AI models | Edit, then `docker compose restart app` |

The app checks every config file when it starts and refuses to run with a clear message if something is
invalid. `./gtm config:check` validates without restarting and lists what's still missing before sending.

## business.yaml: your business

Written by `node scripts/setup.mjs`. Without it the app uses `config/business.example.yaml`, a made-up
company that can't send. Everything here can also be edited on **Project docs**, which wins over the file.

```yaml
company:
  name: Northwind
  site: https://northwind.com
  one_liner: "Scheduling software for small field-service teams"
  thesis: "Service teams still run their day on a whiteboard and a group text"
  strengths: [dispatch board, customer reminders, mobile app]
  proof_points:                  # the ONLY specific claims emails may make about you
    - {id: pp1, text: "$29 a month for the whole office, not per user"}
  banned_claims: ["/guarantee(d)?/i", "#1"]   # plain phrases or /regex/flags
  booking_link: https://cal.com/you/intro       # only in replies to people who wrote back
  physical_address: "100 Main St, Austin, TX 78701"   # required to send
  offer: "a 2-minute video of a day on the dispatch board"
  pricing: "$29/month per office"
  logo: logo.png                 # optional signature logo (PNG in config/); logo_dark for dark mode
competitors: [Jobber, Housecall Pro]
facts: |                         # extra facts reply drafts may use to answer questions
  - Works on any phone or computer.
outreach:
  instructions: "Keep it short and specific to their business."
  cta_reply: "yes"               # the first email asks for a reply of just this word
  reply_cc: [sales@northwind.com]   # copied on every reply you send
  demo_offer: "a quick call with our team"
  yes_reply: ""                  # optional: your exact answer to a plain "yes" ({{first_name}}, {{booking_link}})
  subject_lines_b: []            # optional: subjects to A/B test against written ones, used as written
senders:
  - {name: Sam Rivera, title: Founder, reply_to: ""}
icp:
  segments:                      # one campaign each
    - id: hvac
      description: "Small HVAC and plumbing companies (2-30 technicians)"
      keywords: [hvac, heating, air conditioning, plumbing]
  roles: [owner, founder, general manager, office manager]   # who to email first, in order
  geo: [US]                      # US only
  exclude_domains: [bigcustomer.com]
signals: [hiring, new_office_or_launch, mentions_competitor]
```

**How the writer uses it.** Each first email follows one shape: a specific, sourced detail about the
recipient's company ("I came across Rivera Heating and saw you cover three counties"), who you are (the
one-liner), one reason to believe it (a proof point), and one question asking for the reply word. A rule
checker then rejects anything that cites a fact or proof point that doesn't exist, numbers that aren't
in what it cites, banned claims, spam phrases, fake familiarity or urgency, links in the first two emails,
and wrong lengths. An AI reviewer flags unsupported claims. Flagged drafts are rewritten once with the
reasons, and only drafts still flagged wait for a person.

**Signals** are things research looks for on the company's site: `hiring` (a careers page or job post),
`new_office_or_launch` (a new location, or founded in the last year), `mentions_competitor` (names one of
your `competitors`, the strongest opener there is). They raise the fit score and become citable facts.

## engine.yaml: volume, pacing and guardrails

The defaults are safe for a first month. The settings people change most:

| Setting | Default | What it does |
|---|---|---|
| `caps.daily_send_cap` | 200 | Most emails per day across all mailboxes |
| `caps.daily_spend_cap_usd` | 10 | Paid AI and verification calls stop for the day at this |
| `ramp.tiers` | 15 → 25 → 35 a day | Emails per mailbox per day, by week since it was added |
| `timing.business_start/end` | 09:00-16:30 | Sending window in each recipient's own time zone |
| `timing.send_days` | Mon-Fri | Add `sun` to land Sunday sends at the top of Monday's inbox |
| `sequence.steps` | day 0, day 7 | The first email and one follow-up to people who never replied |
| `approval.require_first_n` | 50 | A person approves this many emails before autopilot |
| `approval.sample_rate` | 0 | Also hold this share of later emails for a person |
| `qualify.threshold` | 60 | Fit score (0-100) below which a company is dropped |
| `qualify.max_company_size` | 50 | Bigger companies are dropped |
| `health.max_bounce_rate` | 2% | A mailbox pauses at this hard-bounce rate (and at least 3 bounces) |
| `health.max_complaint_rate` | 0.1% | A domain pauses at this spam-complaint rate |
| `replies.auto_reply` | on, 240 min | Answers to objections send after this review window unless someone acts |
| `leads.ai_ark.*` | | Your AI Ark plan: credits, budget per run, company size, industries |

Every other setting is commented in the file itself.

## llm.yaml: which AI does what

Each job (`write_email`, `reply_classify`, `critic`, ...) lists one or more models; the first is used
and the rest are fallbacks. The default uses one inexpensive OpenAI model for everything.

- **Anthropic instead:** `cp config/examples/llm.anthropic.yaml config/llm.yaml`, set
  `ANTHROPIC_API_KEY`, and fill in `pricing:` so the daily spend cap counts AI spend.
- **A local model** (Ollama, vLLM, llama.cpp): `config/examples/llm.local.yaml`. Local models are fine for
  sorting and checking; for the best emails, route `write_email` and `reply_draft` to an API model.
- **Better emails, same budget:** move only `write_email` to a stronger model. It's where reply rates live.

`effort: low` makes reasoning models think less on simple jobs (checking, sorting, extraction), which
cuts cost a lot with the same answers.

## Prompts

The AI's instructions live in `prompts/*.md`, one file per job, with the variables it gets in `{{...}}`.
Edit them to change how emails are written. When you change one, bump its `version:` at the top: every
message records the prompt version that wrote it, and unsent follow-ups are rewritten under the new one.

## Environment variables

All of them are listed and explained in [.env.example](../.env.example). The ones that matter most:

| Variable | Why |
|---|---|
| `DASHBOARD_USER`, `DASHBOARD_PASSWORD` | The dashboard login |
| `UNSUBSCRIBE_SECRET` | Signs unsubscribe links and encrypts mailbox passwords. Never change it after sending |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` | The AI |
| `PUBLIC_BASE_URL` | Your dashboard's public https address: one-click unsubscribe links and alert links |
| `TEAM_TIMEZONE` | Your schedules, daily caps and every time shown |
| `ZEROBOUNCE_API_KEY` | Email verification |
| `AI_ARK_API_KEY`, `AI_ARK_TERMS_OK` | Lead search |
| `APP_NAME` | Rename the app in the dashboard and alert emails |
| `GTM_DRY_RUN=1` | Fake mailboxes and data: try everything without sending |
