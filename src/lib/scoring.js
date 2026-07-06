// BLINDSPOT scoring engine — pure functions, zero deps.
// Imported by BOTH the React client and Netlify functions so scores never drift.

export const DEFAULT_ECON = {
  feeRate: 0.1335, // eBay final value fee — verify yours per category in Seller Hub
  perOrderFee: 0.4,
  shipEstimate: 15, // outbound shipping you pay on resale; presets override this
}

const CONDITION_FOR_PARTS = '7000'

// ── Typo hunting ────────────────────────────────────────────────────
// Misspelled brand names get near-zero search visibility → fewer bidders.
// Generate deletion / adjacent-transposition / double-letter-collapse variants.
export function typoVariants(brand) {
  const b = brand.toLowerCase().trim()
  if (b.length < 5) return [] // short names produce garbage variants
  const out = new Set()
  for (let i = 0; i < b.length; i++) {
    out.add(b.slice(0, i) + b.slice(i + 1)) // deletion
    if (i < b.length - 1 && b[i] !== b[i + 1]) {
      out.add(b.slice(0, i) + b[i + 1] + b[i] + b.slice(i + 2)) // transposition
    }
    if (i < b.length - 1 && b[i] === b[i + 1]) {
      out.add(b.slice(0, i) + b.slice(i + 1)) // collapse double letter
    }
  }
  out.delete(b)
  return [...out]
}

// ── Signal detection ────────────────────────────────────────────────
// Each signal: { code, label, pts }. Stack them; mispricing lives in clusters.
export function detectSignals(item, ctx = {}) {
  const signals = []
  const title = (item.title || '').trim()
  const isAuction = (item.buyingOptions || []).includes('AUCTION')
  const bids = item.bidCount ?? 0

  if (isAuction) {
    if (bids === 0) signals.push({ code: 'ZERO_BIDS', label: 'auction · 0 bids', pts: 12 })
    else if (bids <= 2) signals.push({ code: 'LOW_BIDS', label: `auction · ${bids} bids`, pts: 7 })
  }

  if (item.itemEndDate) {
    const hrs = (new Date(item.itemEndDate) - Date.now()) / 36e5
    if (hrs > 0 && hrs <= 6) signals.push({ code: 'ENDING_6H', label: 'ends < 6h', pts: 10 })
    else if (hrs > 0 && hrs <= 24) signals.push({ code: 'ENDING_24H', label: 'ends < 24h', pts: 5 })
  }

  if (ctx.typoOrigin) {
    signals.push({ code: 'TYPO_HIT', label: `typo: "${ctx.typoOrigin}"`, pts: 18 })
    const correct = (ctx.correctBrand || '').toLowerCase()
    if (correct && !title.toLowerCase().includes(correct)) {
      // title never spells the brand right anywhere → truly invisible to searchers
      signals.push({ code: 'TYPO_INVISIBLE', label: 'brand never spelled right', pts: 6 })
    }
  }

  const fb = item.seller?.feedbackScore
  if (fb != null) {
    if (fb < 10) signals.push({ code: 'SELLER_NEW', label: `seller fb ${fb}`, pts: 12 })
    else if (fb < 50) signals.push({ code: 'SELLER_GREEN', label: `seller fb ${fb}`, pts: 7 })
  }

  if (item.conditionId === CONDITION_FOR_PARTS && ctx.fixable) {
    signals.push({ code: 'FIXABLE_PARTS', label: 'for parts · fixable category', pts: 12 })
  }

  if (title.length > 0 && title.length < 35) {
    signals.push({ code: 'THIN_TITLE', label: 'thin title', pts: 6 })
  }
  if (ctx.expectModelNumbers && !/\d/.test(title)) {
    signals.push({ code: 'NO_MODEL', label: 'no model # in title', pts: 4 })
  }

  const ship = item.shippingOptions?.[0]
  if (ship?.shippingCostType === 'NOT_SPECIFIED' || item.pickupOptions?.length) {
    signals.push({ code: 'FRICTION', label: 'pickup / shipping friction', pts: 5 })
  }

  return signals
}

// ── Margin math ─────────────────────────────────────────────────────
export function marginMath(item, compMedian, econ = DEFAULT_ECON) {
  if (!compMedian || compMedian <= 0) return null
  const buy = Number(item.currentBidPrice?.value ?? item.price?.value ?? 0)
  if (!buy) return null
  const gross = compMedian * (1 - econ.feeRate) - econ.perOrderFee
  const net = gross - econ.shipEstimate - buy
  const marginPct = net / buy
  return {
    buy,
    compMedian,
    estNet: Math.round(net * 100) / 100,
    marginPct: Math.round(marginPct * 1000) / 10,
  }
}

// ── Composite score ─────────────────────────────────────────────────
export function scoreItem(item, ctx = {}) {
  const signals = detectSignals(item, ctx)
  const signalPts = signals.reduce((s, x) => s + x.pts, 0)
  const margin = marginMath(item, ctx.compMedian, ctx.econ)

  let marginPts = 0
  if (margin) {
    // margin dominates when comps exist: 30% margin ≈ 26pts, 100%+ ≈ 55pts
    marginPts = Math.max(0, Math.min(55, margin.marginPct * 0.55))
    if (margin.estNet < 0) marginPts = -20 // underwater after fees — punish hard
  }

  const score = Math.max(0, Math.min(100, Math.round(signalPts + marginPts)))
  const confidence = margin
    ? (ctx.compN >= 5 ? 'HIGH' : 'MED')
    : 'LOW'

  return { score, signals, margin, confidence }
}

// Does this deal clear the user's bar?
export function clearsThreshold(scored, { minMarginPct = 30, minNetUsd = 25 } = {}) {
  if (!scored.margin) return scored.score >= 45 // signal-only finds need a strong stack
  return scored.margin.marginPct >= minMarginPct || scored.margin.estNet >= minNetUsd
}
