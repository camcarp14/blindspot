import { browseSearch } from './_shared/ebay.mjs'
import { isKnownCollision, isLikelyRealTerm } from './_shared/typoguard.mjs'
import { scoreItem, typoVariants, DEFAULT_ECON } from '../../src/lib/scoring.js'

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

export default async (req) => {
  if (req.method === 'GET') {
    try {
      await browseSearch({ q: 'test', limit: 1 })
      return json({ ok: true })
    } catch (e) {
      return json({ ok: false, error: String(e.message) }, 200)
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
    typoExclude = [],
    excludeKeywords = [],
    categoryIds = [],
    conditionIds = [],
    auctionOnly = false,
    maxPrice = null,
    minPrice = null,
    endingWithinHours = null,
    limitPerQuery = 50,
    fixable = false,
    expectModelNumbers = true,
    comps = {},
    econ = {},
  } = cfg

  const economics = { ...DEFAULT_ECON, ...econ }
  const excludeLower = excludeKeywords.map((k) => k.toLowerCase()).filter(Boolean)

  const plan = []
  const queryStats = []

  for (const q of queries.filter(Boolean)) {
    plan.push({ q, key: q, typoOrigin: null, correctBrand: null })
  }
  if (typoHunt) {
    for (const brand of typoBrands.filter(Boolean)) {
      for (const variant of typoVariants(brand).slice(0, 6)) {
        if (isKnownCollision(variant, typoExclude)) {
          queryStats.push({ query: variant, key: `typo:${brand}`, typoOrigin: variant, raw: 0, commonTerm: true, skipped: true })
          continue
        }
        plan.push({ q: variant, key: `typo:${brand}`, typoOrigin: variant, correctBrand: brand })
      }
    }
  }
  if (!plan.length && !queryStats.length) return json({ error: 'no queries' }, 400)
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

      const commonTerm = step.typoOrigin ? isLikelyRealTerm(step.typoOrigin, items) : false
      queryStats.push({
        query: step.q,
        key: step.key,
        typoOrigin: step.typoOrigin,
        raw: items.length,
        commonTerm,
        skipped: false,
      })

      for (const item of items) {
        if (seen.has(item.itemId)) continue
        const title = item.title || ''
        if (excludeLower.some((k) => title.toLowerCase().includes(k))) continue

        const compEntry = comps[step.key] || comps[step.q] || null
        const scored = scoreItem(item, {
          typoOrigin: step.typoOrigin,
          correctBrand: step.correctBrand,
          commonTerm,
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
          ...scored,
        })
      }
    } catch (e) {
      errors.push(`${step.q}: ${String(e.message).slice(0, 120)}`)
    }
  }

  const results = [...seen.values()].sort((a, b) => b.score - a.score).slice(0, 120)
  return json({ results, apiCalls, errors, queryStats })
}
