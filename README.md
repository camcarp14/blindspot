# BLINDSPOT

## Changelog — multi-tenant: accounts, billing, and the ledger

Blindspot is a product now, not a bench tool. Accounts, Stripe billing, and a
real interface for everything that used to be an env var or a SQL insert.
The design center didn't move: **eBay's 5,000-call/day Browse quota is per
deployment, not per user** — so instead of pretending otherwise, the ceiling
became the architecture.

**The ledger.** v1 counted API calls in localStorage: one browser's guess,
blind to the watcher and to everyone else. The count now lives in Postgres
(`api_budget` + an atomic `reserve_api_budget` RPC) split into pools —
40% interactive scans, 50% watch scheduler, 10% reserve — so the cron can't
starve a live user and vice versa. Every scan response carries the honest
remainder, and the topbar gauge shows it.

**Tenants make each other cheaper, not tighter.** Pickers cluster on the same
presets, so identical query+filter combinations share one Browse call through
a 10-minute `scan_cache` (interactive and scheduled scans both read AND feed
it). The watch scheduler dedupes across all users each cycle: ten people
watching "canon fd 50mm 1.2" cost one call, scored ten ways with each owner's
comps, econ, and thresholds. When the pool still runs short, the ladder is
degrade-don't-die: fresh → cache-served-and-labeled → skipped-with-reset-time,
Operators first, and starved watches keep their place in line. The typo guard
went communal too: the first tenant whose scan confirms the next "Nikor"
(via `isLikelyRealTerm`) writes it to `typo_collisions`, and nobody ever
queries it again.

**Plans are priced in the scarce unit.** Scout (free): 5 scans/day, manual
comps, prove the edge exists. Picker ($19): 25 scans, 3 watches at 60-minute
cadence, Discord alerts, automated comps. Operator ($49): 60 scans, 10 watches
at 30-minute cadence, first claim on the budget when it runs hot. Definitions
live in `src/lib/plans.js`, imported by both the client and the functions —
same no-drift rule as `scoring.js`. Billing is Stripe Checkout + customer
portal over raw REST, webhook-verified with hand-rolled HMAC (`node:crypto`).
The webhook is the only writer of plan state. Still zero npm dependencies
beyond React and Vite.

**The SQL inserts got interfaces.** Watches: full CRUD, an editor for every
config knob, per-watch cadence, enable/pause, recent catches — plus
"→ Save as watch" on the scan toolbar, which carries your queries, filters,
AND comps straight from a loadout you just proved. The deals `status` column
became a real pipeline view (watching → bid → won → listed → sold, with
notes), and `sold` now takes what it actually went for and what shipping
actually cost, so the realized-P&L line tells you which comps to trust.
`FEE_RATE`/`PER_ORDER_FEE`/`DISCORD_WEBHOOK_URL` env vars became per-seller
Settings. Admins get a deployment console: pool gauges, per-user usage, the
dedupe dividend, and pruning for learned collisions.

**Still no bid automation.** The manual handoff isn't a missing feature, it's
the design: your eBay account, your judgment, your bid. The Gixen copy-paste
handoff and snipe-list CSV are unchanged.

Run `npm run verify` before any deploy: it esbuild-bundles every function the
way Netlify does, runs 47 smoke assertions with planted defects (underwater
deals, fake typos, forged webhook signatures), then builds the frontend.

---

## Changelog — stay a picker, scale the catch

Added the two things from the strategy pass: a sniping handoff, and three
higher-$ "scale" niches alongside the original boutique ones.

**Sniping handoff.** eBay closed `PlaceOffer` to new applicants and gated its
REST replacement (the Offer API) to approved partners only — same wall as
sold comps. Rather than build toward that wall, Blindspot now hands off
*execution* to an existing sniping service instead of reinventing it. Each
card that has comps shows a **ceiling bid** — the max price that still clears
your margin bar, back-solved from the comp median (`maxJustifiedBid` in
`scoring.js`) — and a "Snipe up to $X" button that copies the item # + ceiling
bid to your clipboard and opens Gixen (free, bids in the last few seconds via
your own eBay authorization — no API access needed on our end). Honest
caveat: Gixen doesn't publish a documented URL scheme for pre-filling their
add-snipe form, so this is copy-then-paste, not a deep link.
The feed toolbar also has "Export snipe list" — a CSV of every visible priced
deal with its ceiling bid, ready for any sniper's bulk-import.

**Scale-tier presets.** The original six categories (now labeled
"Boutique — high asymmetry, low volume") are real but capped: a handful of
catches a week, bounded by how many items one person can personally
receive/list/ship around a day job. Added three "Scale — fewer pickers,
higher $ per catch" niches: Enterprise IT/Networking, Pro Audio with a Reverb
cross-list angle, and Precision Machinist Tools. Loadout groups presets by
tier so the strategy stays visible in the tool itself.

---

## Changelog — power-up pass

**Loop 1 — correctness.** The "Nikor" bug: a typo variant that's actually a
real darkroom brand. Fixed with the seeded `KNOWN_REAL_WORD_COLLISIONS` list
plus the runtime `isLikelyRealTerm` check (3+ unrelated sellers using the
same "typo" verbatim = a real word, typo bonus suppressed).

**Loop 2 — power-user upgrades.** Sort controls, threshold filter, batch
comps, save/dismiss, scan breakdown panel, API budget gauge, persistent
loadout, "S" to scan.

**Loop 3 — mobile.** Collapsible loadout drawer, sticky scan bar, 44px+ touch
targets.

---

eBay mispricing scanner. Official Browse API for active listings, signal-stack
scoring (zero-bid auctions ending soon, typo-hunted brand misspellings,
inexperienced sellers, fixable "for parts" gear), and margin math against sold
comps — net of fees and shipping.

Scanner + alerts only. **You place bids yourself on eBay.** No bid automation.

## Stack

Vite/React front end, Netlify Functions back end, Supabase (auth + Postgres),
Stripe billing, per-user Discord alerts. Zero npm dependencies beyond
React/Vite — auth is hand-rolled GoTrue REST, Stripe is raw REST + HMAC,
Supabase is the same tiny fetch helper it always was.

## Setup

### 1. eBay credentials (required, free)

1. Sign up at https://developer.ebay.com (instant for the Buy APIs).
2. Your Account → Application Keys → **Production** keyset.
3. `App ID` → `EBAY_CLIENT_ID`, `Cert ID` → `EBAY_CLIENT_SECRET`.

Default quota is 5,000 Browse calls/day **for the whole deployment**. The
ledger enforces it server-side; if eBay grants you more, raise
`EBAY_DAILY_QUOTA` and the pools scale with it.

### 2. Supabase (required — it's the tenant store now)

1. Create a project at https://supabase.com.
2. Run `supabase-schema.sql` in the SQL editor. Idempotent — safe to re-run,
   and it upgrades a v1 database in place.
3. Project Settings → API: `URL` → `VITE_SUPABASE_URL`, `anon` key →
   `VITE_SUPABASE_ANON_KEY`, `service_role` key → `SUPABASE_SERVICE_KEY`.
4. Set `ADMIN_EMAIL` to your email. Your first sign-in claims any v1 watches
   and deals (rows with no owner) and unlocks the deployment console.
5. Auth → URL Configuration: set the Site URL to your deployed domain so
   magic-link/confirmation emails land back on the app.

Note on email: Supabase's built-in SMTP is heavily rate-limited (a few
emails/hour). Password sign-in works without email confirmation out of the
box; if you want confirmations or magic links at any volume, plug custom SMTP
into Supabase Auth settings.

### 3. Run it

```bash
npm install
cp .env.example .env    # fill in eBay + Supabase
npx netlify dev         # serves UI + functions at localhost:8888
npm run verify          # bundle sweep + smoke tests + build — run before every deploy
```

Deploy: push to GitHub, import in Netlify, set the same env vars in
Site settings → Environment variables. **Upgrading an existing deployment:
deploy the new code first, then run the schema file** (the v1 watcher writes
`seen_items` in a way the new unique index rejects).

### 4. Stripe billing (optional until you want revenue)

Without Stripe keys everyone is a Scout and Settings says billing isn't
configured — the tool still works. To sell plans:

1. Create two recurring Prices (Picker $19/mo, Operator $49/mo) →
   `STRIPE_PRICE_PICKER`, `STRIPE_PRICE_OPERATOR`.
2. Secret key → `STRIPE_SECRET_KEY`.
3. Add a webhook endpoint `https://your-site/api/stripe-webhook` with events
   `checkout.session.completed`, `customer.subscription.updated`,
   `customer.subscription.deleted`; signing secret → `STRIPE_WEBHOOK_SECRET`.

Plan definitions and pricing copy live in `src/lib/plans.js` — one file, both
sides of the wire.

### 5. Sold comps (choose one)

eBay restricts official sold-listings data to approved partners, so pick a lane:

- **Manual (free, every plan):** "Get comps" opens the sold-listings URL for
  that query. Eyeball the median of the last 5–10 *true* comps, punch it into
  "Enter median" on the card. Terapeak (free in Seller Hub) works too.
- **Automated (~$10–50/mo, Picker+):** subscribe to the
  `ebay-average-selling-price` API on RapidAPI, set `RAPIDAPI_KEY`. Pulls are
  cached 7 days in a **shared** cache — one pull serves every tenant hunting
  that query. Note: it's a third-party scraper of eBay's sold pages. Your call.

### 6. Watches + Discord alerts

All in the UI now: the Watches tab (or "→ Save as watch" from a scan), and
your webhook URL in Settings → Discord alerts, with a test button. The
scheduler runs every 30 minutes (`netlify/functions/watch-scan.mjs`), dedupes
queries across every user, and alerts each owner on fresh hits that clear
their bar.

## How scoring works

`src/lib/scoring.js` is the single source of truth — imported by both the
client and the functions, so scores never drift.

- **Signals** stack points: zero-bid auction (12), ends <6h (10), typo hit
  (18, +6 if the brand is never spelled correctly anywhere in the title),
  seller feedback <10 (12), for-parts in a fixable category (12), thin title
  (6), no model number (4), shipping friction (5).
- **Margin** dominates once comps exist: `net = median × (1 − feeRate) −
  perOrderFee − ship − buyPrice`. Positive margin adds up to 55 pts;
  underwater subtracts 20.
- **Confidence:** HIGH needs ≥5 sold comps, MED has thin comps, LOW is
  signals-only.

Your fee rate and per-order fee live in Settings (they vary by category and
store level — verify in Seller Hub). Ship estimates live per-preset in
`src/lib/presets.js`.

## Typo hunt

Misspelled brands get near-zero search visibility, which means near-zero
bidders. For each brand you list, the scanner generates deletion,
transposition, and double-letter-collapse variants and runs each as its own
query. Hits where the correct spelling never appears in the title are the
deep finds. Real words that only look like typos are screened three ways:
the seeded list in `scoring.js`, your excludes in Settings, and the
community `typo_collisions` table that every tenant's confirmed collisions
feed automatically.

## Known constraints — read once

- **The 5,000-call ceiling is shared.** It's a deployment-wide quota, so the
  ledger, the pools, the scan cache, and the watch dedupe aren't
  optimizations — they're what makes multi-tenant possible at all. The admin
  console shows exactly how close to the wall you are, and the "dedupe
  dividend" tells you how much headroom user overlap is buying. If deduped
  watch demand exceeds the pool, request a higher quota from eBay before
  selling more Operator slots.
- **Sold comps are the moat eBay defends.** Official access is partner-only.
  Manual/Terapeak is free and accurate; RapidAPI is convenient and unofficial.
  This app supports both and hides neither.
- **Browse API returns active listings only** — `bidCount`, `itemEndDate`,
  seller feedback, condition are real-time and reliable. Watcher cadence
  means a snipe-window auction can slip between runs; Operator's 30-minute
  floor is the tightest the budget allows.
- **No auto-bidding.** eBay's bidding APIs aren't open, and account-risking
  workarounds aren't worth anyone's seller account. Alert → tap link → bid
  is the safe ceiling, and it stays that way on every plan.
- **Score is a triage tool, not an oracle.** A 75 with LOW confidence means
  "look at this now," not "buy this." Underpriced brand items can be
  underpriced because they're fake — the margin math can't see authenticity.
  That stays on you.
