# BLINDSPOT

eBay mispricing scanner. Official Browse API for active listings, signal-stack scoring
(zero-bid auctions ending soon, typo-hunted brand misspellings, inexperienced sellers,
fixable "for parts" gear), and margin math against sold comps — net of fees and shipping.

Scanner + alerts only. **You place bids yourself on eBay.** No bid automation.

## Stack

Vite/React front end, Netlify Functions back end, optional Supabase persistence,
optional Discord alerts. Same shape as your other builds.

## Setup

### 1. eBay credentials (required, free)

1. Sign up at https://developer.ebay.com (instant for the Buy APIs).
2. Your Account → Application Keys → **Production** keyset.
3. `App ID` → `EBAY_CLIENT_ID`, `Cert ID` → `EBAY_CLIENT_SECRET`.

Default quota is 5,000 Browse calls/day. One scan with 5 queries + typo hunt on
2 brands ≈ 15–17 calls. The scheduled watcher at 12 queries/watch, every 30 min,
burns ~576 calls/day per watch — budget accordingly.

### 2. Run it

```bash
npm install
cp .env.example .env   # fill in eBay keys
npx netlify dev         # serves UI + functions at localhost:8888
```

Deploy: push to GitHub, import in Netlify, set the same env vars in
Site settings → Environment variables.

### 3. Sold comps (choose one)

eBay restricts official sold-listings data to approved partners, so pick a lane:

- **Manual (free):** hit "Get comps" on a card with no `RAPIDAPI_KEY` set — it opens
  the sold-listings URL for that query. Eyeball the median of the last 5–10 *true*
  comps, punch it into "Enter median" on the card. Terapeak (free in Seller Hub)
  works too and goes back further.
- **Automated (~$10–50/mo):** subscribe to the `ebay-average-selling-price` API on
  RapidAPI, set `RAPIDAPI_KEY`. "Get comps" then pulls median/average/n automatically
  and caches 7 days in Supabase if configured. Note: it's a third-party scraper of
  eBay's sold pages — it works, but it's not eBay-official. Your call.

### 4. Scheduled watches + Discord (optional)

1. Create a Supabase project, run `supabase-schema.sql` in the SQL editor.
2. Set `SUPABASE_URL` + `SUPABASE_SERVICE_KEY` (service role — server-side only).
3. Set `DISCORD_WEBHOOK_URL` (channel settings → Integrations → Webhooks).
4. Insert a watch row:

```sql
insert into watches (name, config) values (
  'lenses-overnight',
  '{
    "queries": ["canon fd 50mm 1.2", "takumar 50mm 1.4"],
    "typoBrands": ["takumar"],
    "typoHunt": true,
    "auctionOnly": true,
    "maxPrice": 300,
    "endingWithinHours": 12,
    "minScore": 50,
    "threshold": { "minMarginPct": 30, "minNetUsd": 25 },
    "comps": { "canon fd 50mm 1.2": { "median": 420, "n": 8 } },
    "econ": { "shipEstimate": 12 }
  }'::jsonb
);
```

`watch-scan` runs every 30 min (edit the cron in `netlify/functions/watch-scan.mjs`),
dedupes against `seen_items`, and posts only fresh hits.

## How scoring works

`src/lib/scoring.js` is the single source of truth — imported by both the client and
the functions, so scores never drift.

- **Signals** stack points: zero-bid auction (12), ends <6h (10), typo hit (18, +6 if
  the brand is never spelled correctly anywhere in the title), seller feedback <10
  (12), for-parts in a fixable category (12), thin title (6), no model number (4),
  shipping friction (5).
- **Margin** dominates once comps exist: `net = median × (1 − feeRate) − perOrderFee
  − ship − buyPrice`. Positive margin adds up to 55 pts; underwater subtracts 20.
- **Confidence:** HIGH needs ≥5 sold comps, MED has thin comps, LOW is signals-only.

Tune `FEE_RATE` / `PER_ORDER_FEE` in env to your actual seller account — fees vary by
category and store level. Ship estimates live per-preset in `src/lib/presets.js`.

## Typo hunt

Misspelled brands get near-zero search visibility, which means near-zero bidders.
For each brand you list, the scanner generates deletion, transposition, and
double-letter-collapse variants ("takumar" → "takmar", "atkumar", …) and runs each as
its own query. Hits where the correct spelling never appears in the title are the
deep finds.

## Category IDs

Presets ship with keyword queries only. To narrow a scan, use "Find category ID" in
the Loadout rail (live Taxonomy API lookup), click a result to pin it, and optionally
hardcode it into `src/lib/presets.js` once verified.

## Known constraints — read once

- **Sold comps are the moat eBay defends.** Official access (Marketplace Insights) is
  partner-only. Manual/Terapeak is free and accurate; RapidAPI is convenient and
  unofficial. This app supports both and hides neither.
- **Browse API returns active listings only** — `bidCount`, `itemEndDate`, seller
  feedback, condition are all real-time and reliable. Watcher cadence (30 min) means
  a snipe-window auction can slip between runs; tighten the cron for hot categories.
- **No auto-bidding.** eBay's bidding APIs aren't open, and account-risking
  workarounds aren't worth your seller account. The Discord alert → tap link → bid
  flow is the safe ceiling.
- **Score is a triage tool, not an oracle.** A 75 with LOW confidence means "look at
  this now," not "buy this." Underpriced brand items can be underpriced because
  they're fake — the margin math can't see authenticity. That stays on you.
