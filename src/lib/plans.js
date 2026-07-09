// BLINDSPOT plans — single source of truth, imported by BOTH the React client
// (pricing UI, gates, meters) and the Netlify functions (enforcement), same as
// scoring.js. If the two ever disagree, someone edited the wrong file.
//
// Plans are priced in the deployment's actual scarce unit: eBay Browse API
// calls. The Browse quota (default 5,000/day) is PER DEPLOYMENT, not per user —
// so every limit below is derived from that ceiling, and the ledger in
// Postgres (api_budget) is the enforcement, not the localStorage guess v1 had.

export const DAILY_QUOTA = 5000 // override with EBAY_DAILY_QUOTA if eBay grants more

// How the deployment-wide budget splits. The reserve absorbs retries, token
// checks, and the day the front page of r/flipping finds you.
export const POOL_SPLIT = {
  interactive: 0.4, // user-initiated scans
  watch: 0.5,       // the scheduled watcher
  reserve: 0.1,     // never allocated
}

export function poolCap(pool, quota = DAILY_QUOTA) {
  return Math.floor(quota * (POOL_SPLIT[pool] || 0))
}

export const PLANS = {
  scout: {
    id: 'scout',
    label: 'Scout',
    price: 0,
    blurb: 'Prove the edge exists before you pay for it.',
    scansPerDay: 5,
    watchSlots: 0,
    cadenceMinutes: null, // no watches
    autoComps: false,     // manual comps (sold URL / Terapeak) always work
    alerts: false,
    priority: 0,
  },
  picker: {
    id: 'picker',
    label: 'Picker',
    price: 19,
    blurb: 'The boutique tiers, worked properly: watches hunt while you sleep.',
    scansPerDay: 25,
    watchSlots: 3,
    cadenceMinutes: 60,
    autoComps: true,
    alerts: true,
    priority: 1,
  },
  operator: {
    id: 'operator',
    label: 'Operator',
    price: 49,
    blurb: 'Scale tier: fewer, bigger catches — first claim on the budget when it runs hot.',
    scansPerDay: 60,
    watchSlots: 10,
    cadenceMinutes: 30,
    autoComps: true,
    alerts: true,
    priority: 2,
  },
}

export function planOf(id) {
  return PLANS[id] || PLANS.scout
}

// Queries a single watch may run per cycle (v1's plan.slice(0,12) made contract).
export const MAX_QUERIES_PER_WATCH = 12

// Rough capacity math for the admin gauge: one UNIQUE query at a given cadence
// costs this many Browse calls per day. Dedupe across users means the real
// cost of a new watch is only its queries nobody else is already running.
export function watchQueryCostPerDay(cadenceMinutes) {
  if (!cadenceMinutes) return 0
  return Math.ceil((24 * 60) / cadenceMinutes)
}
