// Deployment console — the owner's view of the one thing everyone shares:
// the 5,000-call ceiling. Pools, per-user pressure, watch capacity math, and
// the community collision list (with pruning, for the day a real typo gets
// mistaken for a word).

import { sb } from './_shared/ebay.mjs'
import { requireUser, guarded, json, HttpError } from './_shared/auth.mjs'
import { budgetSnapshot, dailyQuota } from './_shared/quota.mjs'
import { planOf, watchQueryCostPerDay, poolCap } from '../../src/lib/plans.js'

export default guarded(async (req) => {
  const { profile } = await requireUser(req)
  if (!profile.is_admin) throw new HttpError(403, 'NOT_ADMIN', 'Admin only')
  const supa = sb()
  const url = new URL(req.url)

  if (req.method === 'DELETE') {
    const term = url.searchParams.get('collision')
    if (!term) return json({ error: 'collision required' }, 400)
    const ok = await supa.del('typo_collisions', `term=eq.${encodeURIComponent(term)}`)
    return json({ deleted: ok })
  }

  if (req.method !== 'GET') return json({ error: 'GET or DELETE only' }, 405)

  const today = new Date().toISOString().slice(0, 10)
  const [budget, profiles, usage, watches, collisions] = await Promise.all([
    budgetSnapshot(supa),
    supa.select('profiles', 'select=id,email,plan,is_admin,created_at&order=created_at.desc&limit=500'),
    supa.select('user_usage', `day=eq.${today}&select=user_id,scans,api_calls,comp_pulls`),
    supa.select('watches', 'select=id,user_id,enabled,cadence_minutes,config'),
    supa.select('typo_collisions', 'select=*&order=first_seen.desc&limit=200'),
  ])

  const usageBy = new Map((usage || []).map((u) => [u.user_id, u]))
  const watchesBy = new Map()
  for (const w of watches || []) {
    watchesBy.set(w.user_id, (watchesBy.get(w.user_id) || 0) + 1)
  }

  const users = (profiles || []).map((p) => ({
    id: p.id,
    email: p.email,
    plan: p.plan,
    isAdmin: p.is_admin,
    createdAt: p.created_at,
    scansToday: usageBy.get(p.id)?.scans || 0,
    callsToday: usageBy.get(p.id)?.api_calls || 0,
    watches: watchesBy.get(p.id) || 0,
  }))

  // Watch capacity: what do today's enabled watches cost if nothing dedupes,
  // and what do they cost after dedupe? The gap is the multi-tenant dividend.
  const uniqueQueryCost = new Map()
  let naiveCost = 0
  for (const w of watches || []) {
    if (!w.enabled) continue
    const owner = users.find((u) => u.id === w.user_id)
    const cadence = Math.max(w.cadence_minutes || 60, planOf(owner?.plan).cadenceMinutes || 60)
    const perDay = watchQueryCostPerDay(cadence)
    const cfg = w.config || {}
    const queries = [...(cfg.queries || [])]
    if (cfg.typoHunt) for (const b of cfg.typoBrands || []) queries.push(`typo:${b}`)
    for (const q of queries.slice(0, 12)) {
      naiveCost += perDay
      const cur = uniqueQueryCost.get(q) || 0
      uniqueQueryCost.set(q, Math.max(cur, perDay)) // shared call runs at the fastest cadence asking
    }
  }
  const dedupedCost = [...uniqueQueryCost.values()].reduce((s, x) => s + x, 0)

  const planCounts = {}
  for (const u of users) planCounts[u.plan] = (planCounts[u.plan] || 0) + 1

  return json({
    quota: dailyQuota(),
    budget,
    users,
    planCounts,
    watchCapacity: {
      pool: poolCap('watch', dailyQuota()),
      naiveCostPerDay: naiveCost,
      dedupedCostPerDay: dedupedCost,
      uniqueQueries: uniqueQueryCost.size,
    },
    collisions: collisions || [],
  })
})
