// Scheduled scanner, multi-tenant edition. Runs every 30 minutes and hunts for
// every paid user at once — but the deployment shares one 5,000-call budget,
// so the scheduler's whole job is spending the watch pool well:
//
//   1. DEDUPE: ten users watching "canon fd 50mm 1.2" = ONE Browse call.
//      Unique (query + filters) steps are fetched once and scored per-watch,
//      per-user, with each owner's comps, econ, and thresholds.
//   2. CACHE: results land in scan_cache, so an interactive scan minutes later
//      is free — and vice versa.
//   3. DEGRADE, don't die: when the pool runs short, Operator watches fetch
//      first; skipped watches keep their place in line for the next cycle.

import { browseSearch, scanCacheKey, sb } from './_shared/ebay.mjs'
import { isKnownCollision, isLikelyRealTerm, loadLearnedCollisions, recordCollision } from './_shared/typoguard.mjs'
import { reserveCalls } from './_shared/quota.mjs'
import { scoreItem, typoVariants, clearsThreshold, DEFAULT_ECON } from '../../src/lib/scoring.js'
import { planOf, MAX_QUERIES_PER_WATCH } from '../../src/lib/plans.js'

const CACHE_TTL_MS = 10 * 60_000
const CADENCE_SLACK_MS = 2 * 60_000 // cron jitter tolerance

export default async () => {
  const supa = sb()
  if (!supa) {
    console.log('watch-scan: Supabase not configured, skipping')
    return new Response('skipped')
  }

  const [watches, learned] = await Promise.all([
    supa.select('watches', 'enabled=eq.true&select=*&order=created_at.asc'),
    loadLearnedCollisions(supa),
  ])
  if (!watches?.length) return new Response('no watches')

  const userIds = [...new Set(watches.map((w) => w.user_id).filter(Boolean))]
  const profiles = userIds.length
    ? await supa.select(
        'profiles',
        `id=in.(${userIds.join(',')})&select=id,plan,discord_webhook_url,typo_exclude,econ`,
      )
    : []
  const profileBy = new Map((profiles || []).map((p) => [p.id, p]))

  // ── Which watches run this cycle? Plan gates + cadence + slot limits ──
  const now = Date.now()
  const slotsUsed = new Map()
  const due = []
  for (const w of watches) {
    const profile = profileBy.get(w.user_id)
    const plan = planOf(profile?.plan)
    if (!plan.watchSlots) continue // downgraded below the feature — watch sleeps
    const used = slotsUsed.get(w.user_id) || 0
    if (used >= plan.watchSlots) continue // oldest watches keep the slots
    slotsUsed.set(w.user_id, used + 1)

    const cadence = Math.max(w.cadence_minutes || 60, plan.cadenceMinutes)
    const lastRun = w.last_run_at ? new Date(w.last_run_at).getTime() : 0
    if (now - lastRun < cadence * 60_000 - CADENCE_SLACK_MS) continue
    due.push({ watch: w, profile, plan })
  }
  if (!due.length) return new Response('nothing due')

  // ── Build the deduped step map: cacheKey → { params, contexts[] } ──
  const steps = new Map()
  for (const entry of due) {
    const cfg = entry.watch.config || {}
    const typoExclude = [...(cfg.typoExclude || []), ...(entry.profile?.typo_exclude || [])]
    const plan_ = (cfg.queries || []).map((q) => ({ q, typoOrigin: null, correctBrand: null }))
    if (cfg.typoHunt) {
      for (const brand of cfg.typoBrands || []) {
        for (const v of typoVariants(brand).slice(0, 4)) {
          if (isKnownCollision(v, typoExclude, learned)) continue
          plan_.push({ q: v, typoOrigin: v, correctBrand: brand })
        }
      }
    }
    for (const step of plan_.slice(0, MAX_QUERIES_PER_WATCH)) {
      const params = {
        q: step.q,
        categoryIds: cfg.categoryIds || [],
        conditionIds: cfg.conditionIds || [],
        auctionOnly: !!cfg.auctionOnly,
        maxPrice: cfg.maxPrice || null,
        endingWithinHours: cfg.endingWithinHours || null,
        limit: 25,
        sort: cfg.auctionOnly ? 'endingSoonest' : 'newlyListed',
      }
      const key = scanCacheKey(params)
      if (!steps.has(key)) {
        steps.set(key, { params, step, contexts: [], priority: 0 })
      }
      const s = steps.get(key)
      s.contexts.push(entry)
      s.priority = Math.max(s.priority, entry.plan.priority)
    }
  }

  // ── Free cache hits first, then reserve budget for the rest ──
  const keys = [...steps.keys()]
  const cutoff = new Date(now - CACHE_TTL_MS).toISOString()
  const cachedRows = keys.length
    ? await supa.select(
        'scan_cache',
        `cache_key=in.(${keys.join(',')})&fetched_at=gt.${encodeURIComponent(cutoff)}&select=cache_key,payload`,
      )
    : []
  const itemsByKey = new Map((cachedRows || []).map((r) => [r.cache_key, r.payload]))

  const uncached = keys.filter((k) => !itemsByKey.has(k))
  // Highest plan priority first: when the pool is short, Operators eat first.
  uncached.sort((a, b) => steps.get(b).priority - steps.get(a).priority)
  const granted = await reserveCalls(supa, 'watch', uncached.length)

  let apiCalls = 0
  const starvedKeys = new Set(uncached.slice(granted))
  for (const key of uncached.slice(0, granted)) {
    const { params, q } = { params: steps.get(key).params, q: steps.get(key).step.q }
    try {
      const items = await browseSearch(params)
      apiCalls++
      itemsByKey.set(key, items)
      await supa.upsert(
        'scan_cache',
        [{ cache_key: key, q, payload: items, fetched_at: new Date().toISOString() }],
        'cache_key',
      )
    } catch (e) {
      console.log(`watch-scan query "${q}" failed: ${e.message}`)
      starvedKeys.add(key) // don't punish the watch for eBay hiccups
    }
  }

  // ── Score per watch context, dedupe per watch, alert per user ──
  const hitsByWatch = new Map() // watch.id → { entry, hits: [{item, scored}] }
  const starvedWatches = new Set()

  for (const [key, { step, contexts }] of steps) {
    const items = itemsByKey.get(key)
    if (!items) {
      for (const c of contexts) starvedWatches.add(c.watch.id)
      continue
    }
    const commonTerm = step.typoOrigin ? isLikelyRealTerm(step.typoOrigin, items) : false
    if (commonTerm && step.typoOrigin) {
      await recordCollision(supa, step.typoOrigin, step.correctBrand, 0)
    }
    for (const entry of contexts) {
      const cfg = entry.watch.config || {}
      const econ = { ...DEFAULT_ECON, ...(entry.profile?.econ || {}), ...(cfg.econ || {}) }
      for (const item of items) {
        const scored = scoreItem(item, {
          typoOrigin: step.typoOrigin,
          correctBrand: step.correctBrand,
          commonTerm,
          fixable: !!cfg.fixable,
          expectModelNumbers: cfg.expectModelNumbers !== false,
          compMedian: cfg.comps?.[step.q]?.median || null,
          compN: cfg.comps?.[step.q]?.n || 0,
          econ,
        })
        if (scored.score >= (cfg.minScore || 45) && clearsThreshold(scored, cfg.threshold || {})) {
          if (!hitsByWatch.has(entry.watch.id)) hitsByWatch.set(entry.watch.id, { entry, hits: [] })
          hitsByWatch.get(entry.watch.id).hits.push({ item, scored })
        }
      }
    }
  }

  let alerted = 0
  for (const [watchId, { entry, hits }] of hitsByWatch) {
    if (!hits.length) continue
    const ids = hits.map((h) => `"${h.item.itemId}"`).join(',')
    const seenRows = await supa.select(
      'seen_items',
      `watch_id=eq.${watchId}&item_id=in.(${ids})&select=item_id`,
    )
    const seenSet = new Set((seenRows || []).map((r) => r.item_id))
    const fresh = hits.filter((h) => !seenSet.has(h.item.itemId))
    if (!fresh.length) continue

    await supa.upsert(
      'seen_items',
      fresh.map((h) => ({
        item_id: h.item.itemId,
        watch_id: watchId,
        score: h.scored.score,
        title: h.item.title,
        seen_at: new Date().toISOString(),
      })),
      'watch_id,item_id',
    )
    await supa.update('watches', `id=eq.${watchId}`, { last_hit_at: new Date().toISOString() })

    // Alerts go to the OWNER's webhook (Settings), not a deployment-wide one.
    // Env var stays as a fallback so the original solo setup keeps working.
    const webhook = entry.profile?.discord_webhook_url || process.env.DISCORD_WEBHOOK_URL
    if (webhook && entry.plan.alerts) {
      const top = fresh.sort((a, b) => b.scored.score - a.scored.score).slice(0, 5)
      await fetch(webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: `**BLINDSPOT** · ${entry.watch.name || 'watch'} · ${fresh.length} new`,
          embeds: top.map(({ item, scored }) => ({
            title: `[${scored.score}] ${item.title}`.slice(0, 256),
            url: item.itemWebUrl,
            description: [
              `$${item.currentBidPrice?.value ?? item.price?.value} · ${item.bidCount ?? 0} bids`,
              item.itemEndDate ? `ends <t:${Math.floor(new Date(item.itemEndDate) / 1000)}:R>` : null,
              scored.margin ? `est net $${scored.margin.estNet} (${scored.margin.marginPct}%)` : null,
              scored.signals.map((s) => s.label).join(' · '),
            ]
              .filter(Boolean)
              .join('\n')
              .slice(0, 2048),
            color: scored.score >= 70 ? 0xffb454 : 0x8fbf7f,
          })),
        }),
      })
      alerted += top.length
    }
  }

  // Watches fully served advance their clock; starved ones keep last_run_at so
  // they're first in line next cycle instead of silently losing a beat.
  const ranIds = due
    .filter((d) => !starvedWatches.has(d.watch.id))
    .map((d) => d.watch.id)
  if (ranIds.length) {
    await supa.update(
      'watches',
      `id=in.(${ranIds.join(',')})`,
      { last_run_at: new Date().toISOString() },
    )
  }

  // Opportunistic housekeeping — the cron is already awake.
  const dayAgo = new Date(now - 24 * 36e5).toISOString()
  const ninetyDays = new Date(now - 90 * 24 * 36e5).toISOString()
  await supa.del('scan_cache', `fetched_at=lt.${encodeURIComponent(dayAgo)}`)
  await supa.del('seen_items', `seen_at=lt.${encodeURIComponent(ninetyDays)}`)

  return new Response(
    `done: ${due.length} due, ${steps.size} unique queries, ${apiCalls} calls, ${starvedWatches.size} starved, alerted ${alerted}`,
  )
}

export const config = {
  schedule: '*/30 * * * *',
}
