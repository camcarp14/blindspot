import { browseSearch, envEcon } from './_shared/ebay.mjs'
import { scoreItem, typoVariants, DEFAULT_ECON } from '../../src/lib/scoring.js'

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

export default async (req) => {
  // GET = health check (verifies eBay creds/token work).
  // Also returns server-side econ (env fee overrides) so the client scores
  // with the exact same numbers the functions use.
  if (req.method === 'GET') {
    const econ = { ...DEFAULT_ECON, ...envEcon() }
    try {
      await browseSearch({ q: 'test', limit: 1 })
      return json({ ok: true, econ })
    } catch (e) {
      return json({ ok: false, error: String(e.message), econ }, 200)
    }
  }
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405)

  let cfg
  try {
    cfg = await req.json()
  } catch {
    return json({ error: 'bad json' }, 400)
  }

  const {
    queries = [],
    typoBrands = [],
    typoHunt = false,
    categoryIds = [],
    conditionIds = [],
    auctionOnly = false,
    maxPrice = null,
    minPrice = null,
    endingWithinHours = null,
    limitPerQuery = 50,
    fixable = false,
    expectModelNumbers = true,
    comps = {}, // { [queryKey]: { median, n } } supplied by client from comps calls / manual entry
    econ = {},
  } = cfg

  const economics = { ...DEFAULT_ECON, ...envEcon(), ...econ }

  // Build the search plan: base queries + typo variants (each tagged with origin)
  const plan = []
  for (const q of queries.filter(Boolean)) {
    plan.push({ q, key: q, typoOrigin: null, correctBrand: null })
  }
  if (typoHunt) {
    for (const brand of typoBrands.filter(Boolean)) {
      for (const variant of typoVariants(brand).slice(0, 6)) {
        plan.push({ q: variant, key: `typo:${brand}`, typoOrigin: variant, correctBrand: brand })
      }
    }
  }
  if (!plan.length) return json({ error: 'no queries' }, 400)
  if (plan.length > 40) plan.length = 40 // protect the 5k/day API budget

  const seen = new Map()
  let apiCalls = 0
  const errors = []

  for (const step of plan) {
    try {
      const items = await browseSearch({
        q: step.q,
        categoryIds,
        conditionIds,
        auctionOnly,
        maxPrice,
        minPrice,
        endingWithinHours,
        limit: step.typoOrigin ? 25 : limitPerQuery,
        sort: auctionOnly ? 'endingSoonest' : 'newlyListed',
      })
      apiCalls++
      for (const item of items) {
        if (seen.has(item.itemId)) continue
        const compEntry = comps[step.key] || comps[step.q] || null
        const scored = scoreItem(item, {
          typoOrigin: step.typoOrigin,
          correctBrand: step.correctBrand,
          fixable,
          expectModelNumbers,
          compMedian: compEntry?.median || null,
          compN: compEntry?.n || 0,
          econ: economics,
        })
        seen.set(item.itemId, {
          itemId: item.itemId,
          title: item.title,
          url: item.itemWebUrl,
          image: item.image?.imageUrl || item.thumbnailImages?.[0]?.imageUrl || null,
          price: Number(item.currentBidPrice?.value ?? item.price?.value ?? 0),
          buyingOptions: item.buyingOptions || [],
          bidCount: item.bidCount ?? null,
          endDate: item.itemEndDate || null,
          condition: item.condition || null,
          conditionId: item.conditionId || null,
          seller: item.seller
            ? { user: item.seller.username, fb: item.seller.feedbackScore, pct: item.seller.feedbackPercentage }
            : null,
          location: item.itemLocation?.postalCode || item.itemLocation?.country || null,
          queryKey: step.key,
          typoOrigin: step.typoOrigin,
          correctBrand: step.correctBrand,
          // Minimal snapshot of the fields scoring.js reads, so the client can
          // re-score locally (comps entry, econ tweaks) without new API calls.
          raw: {
            title: item.title,
            buyingOptions: item.buyingOptions,
            bidCount: item.bidCount,
            itemEndDate: item.itemEndDate,
            conditionId: item.conditionId,
            seller: item.seller ? { feedbackScore: item.seller.feedbackScore } : null,
            shippingOptions: item.shippingOptions
              ? item.shippingOptions.map((s) => ({ shippingCostType: s.shippingCostType }))
              : undefined,
            pickupOptions: item.pickupOptions,
            currentBidPrice: item.currentBidPrice,
            price: item.price,
          },
          ...scored,
        })
      }
    } catch (e) {
      errors.push(`${step.q}: ${String(e.message).slice(0, 120)}`)
    }
  }

  const results = [...seen.values()].sort((a, b) => b.score - a.score).slice(0, 120)
  return json({ results, apiCalls, errors })
}
