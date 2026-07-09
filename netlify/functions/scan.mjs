import { browseSearch, getToken, scanCacheKey, sb } from './_shared/ebay.mjs'
import { isKnownCollision, isLikelyRealTerm, loadLearnedCollisions, recordCollision } from './_shared/typoguard.mjs'
import { requireUser, guarded, json, HttpError } from './_shared/auth.mjs'
import { reserveCalls, recordUsage, usageToday, budgetSnapshot } from './_shared/quota.mjs'
import { scoreItem, typoVariants, DEFAULT_ECON } from '../../src/lib/scoring.js'

const CACHE_TTL_MS = 10 * 60_000 // shared Browse-result cache; pickers cluster on presets

export default guarded(async (req) => {
  if (req.method === 'GET') {
    // Health = "can we mint an eBay token", nothing more. v1 burned a real
    // Browse call per page load here — at multi-tenant that's the budget.
    try {
      await getToken()
      return json({ ok: true })
    } catch (e) {
      return json({ ok: false, error: String(e.message) }, 200)
    }
  }
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405)

  const { user, profile, plan } = await requireUser(req)
  const supa = sb()

  const used = await usageToday(supa, user.id)
  if (used.scans >= plan.scansPerDay) {
    throw new HttpError(
      402,
      'SCAN_LIMIT',
      `Scan ${used.scans}/${plan.scansPerDay} used today on ${plan.label} — resets midnight UTC`,
    )
  }

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

  // Per-request econ over the seller's saved econ over defaults — the env-var
  // era (one FEE_RATE for the whole deployment) is over.
  const economics = { ...DEFAULT_ECON, ...(profile.econ || {}), ...econ }
  const excludeLower = excludeKeywords.map((k) => k.toLowerCase()).filter(Boolean)
  // Account-level excludes (Settings) + this request's field + the community list.
  const learned = await loadLearnedCollisions(supa)
  const excludeTerms = [...typoExclude, ...(profile.typo_exclude || [])]

  const plan_ = []
  const queryStats = []

  for (const q of queries.filter(Boolean)) {
    plan_.push({ q, key: q, typoOrigin: null, correctBrand: null })
  }
  if (typoHunt) {
    for (const brand of typoBrands.filter(Boolean)) {
      for (const variant of typoVariants(brand).slice(0, 6)) {
        if (isKnownCollision(variant, excludeTerms, learned)) {
          queryStats.push({ query: variant, key: `typo:${brand}`, typoOrigin: variant, raw: 0, commonTerm: true, skipped: 'known term' })
          continue
        }
        plan_.push({ q: variant, key: `typo:${brand}`, typoOrigin: variant, correctBrand: brand })
      }
    }
  }
  if (!plan_.length && !queryStats.length) return json({ error: 'no queries' }, 400)
  if (plan_.length > 40) plan_.length = 40 // hard cap regardless of plan

  // ── Budget: cached steps are free; only fresh fetches hit the ledger ──
  const searchParams = (step) => ({
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
  for (const step of plan_) step.cacheKey = scanCacheKey(searchParams(step))

  const cacheHits = new Map()
  if (supa && plan_.length) {
    const keys = [...new Set(plan_.map((s) => s.cacheKey))].join(',')
    const cutoff = new Date(Date.now() - CACHE_TTL_MS).toISOString()
    const rows = await supa.select(
      'scan_cache',
      `cache_key=in.(${keys})&fetched_at=gt.${encodeURIComponent(cutoff)}&select=cache_key,payload`,
    )
    for (const r of rows || []) cacheHits.set(r.cache_key, r.payload)
  }

  // Plain queries outrank typo variants when budget is short: they're the
  // user's explicit intent, variants are speculation.
  const uncached = plan_.filter((s) => !cacheHits.has(s.cacheKey))
  uncached.sort((a, b) => (a.typoOrigin ? 1 : 0) - (b.typoOrigin ? 1 : 0))
  const granted = await reserveCalls(supa, 'interactive', uncached.length)
  const fetchable = new Set(uncached.slice(0, granted).map((s) => s.cacheKey))
  const degraded = granted < uncached.length

  const seen = new Map()
  let apiCalls = 0
  const errors = []

  for (const step of plan_) {
    let items = null
    let fromCache = false

    if (cacheHits.has(step.cacheKey)) {
      items = cacheHits.get(step.cacheKey)
      fromCache = true
    } else if (fetchable.has(step.cacheKey)) {
      try {
        items = await browseSearch(searchParams(step))
        apiCalls++
        if (supa) {
          await supa.upsert(
            'scan_cache',
            [{ cache_key: step.cacheKey, q: step.q, payload: items, fetched_at: new Date().toISOString() }],
            'cache_key',
          )
        }
        cacheHits.set(step.cacheKey, items) // duplicate steps in this plan reuse it
      } catch (e) {
        errors.push(`${step.q}: ${String(e.message).slice(0, 120)}`)
        continue
      }
    } else {
      queryStats.push({ query: step.q, key: step.key, typoOrigin: step.typoOrigin, raw: 0, commonTerm: false, skipped: 'budget' })
      continue
    }

    const commonTerm = step.typoOrigin ? isLikelyRealTerm(step.typoOrigin, items) : false
    if (commonTerm && !fromCache) {
      // New collision confirmed live — retire it for every tenant.
      await recordCollision(supa, step.typoOrigin, step.correctBrand, 0)
    }
    queryStats.push({
      query: step.q,
      key: step.key,
      typoOrigin: step.typoOrigin,
      raw: items.length,
      commonTerm,
      skipped: false,
      cached: fromCache,
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
  }

  await recordUsage(supa, user.id, { scans: 1, calls: apiCalls })
  const [usage, budget] = await Promise.all([usageToday(supa, user.id), budgetSnapshot(supa)])

  const results = [...seen.values()].sort((a, b) => b.score - a.score).slice(0, 120)
  return json({
    results,
    apiCalls,
    cachedQueries: queryStats.filter((q) => q.cached).length,
    degraded, // budget was short — some steps served stale-or-skipped
    errors,
    queryStats,
    usage: { ...usage, scansLimit: plan.scansPerDay },
    budget,
  })
})
