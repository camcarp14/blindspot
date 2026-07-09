// Watches CRUD — the interface for what used to be a SQL insert in the README.
// Slots and cadence floors come from the plan; the scheduler (watch-scan.mjs)
// enforces them again at run time, so a stale row can't out-run its plan.

import { sb } from './_shared/ebay.mjs'
import { requireUser, guarded, json, HttpError } from './_shared/auth.mjs'
import { MAX_QUERIES_PER_WATCH } from '../../src/lib/plans.js'

const clean = (arr) => (Array.isArray(arr) ? arr.map((s) => String(s).trim()).filter(Boolean) : [])

// Whitelist the config shape instead of storing arbitrary JSON from the client.
function sanitizeConfig(raw = {}) {
  const num = (v) => (v === '' || v == null || Number.isNaN(Number(v)) ? null : Number(v))
  const cfg = {
    queries: clean(raw.queries).slice(0, MAX_QUERIES_PER_WATCH),
    typoBrands: clean(raw.typoBrands).slice(0, 6),
    typoHunt: !!raw.typoHunt,
    typoExclude: clean(raw.typoExclude),
    categoryIds: clean(raw.categoryIds),
    conditionIds: clean(raw.conditionIds),
    auctionOnly: !!raw.auctionOnly,
    fixable: !!raw.fixable,
    expectModelNumbers: raw.expectModelNumbers !== false,
    maxPrice: num(raw.maxPrice),
    endingWithinHours: num(raw.endingWithinHours),
    minScore: num(raw.minScore) ?? 45,
    threshold: {
      minMarginPct: num(raw.threshold?.minMarginPct) ?? 30,
      minNetUsd: num(raw.threshold?.minNetUsd) ?? 25,
    },
    comps: {},
    econ: {},
  }
  // comps: { [query]: { median, n } } — numbers only
  for (const [k, v] of Object.entries(raw.comps || {})) {
    const median = num(v?.median)
    if (median && median > 0) cfg.comps[k] = { median, n: num(v?.n) ?? 1 }
  }
  const ship = num(raw.econ?.shipEstimate)
  if (ship != null) cfg.econ.shipEstimate = ship
  if (!cfg.queries.length && !(cfg.typoHunt && cfg.typoBrands.length)) {
    throw new HttpError(400, 'EMPTY_WATCH', 'A watch needs at least one query or typo-hunt brand')
  }
  return cfg
}

export default guarded(async (req) => {
  const { user, plan } = await requireUser(req)
  const supa = sb()
  const url = new URL(req.url)

  if (req.method === 'GET') {
    const watches = await supa.select(
      'watches',
      `user_id=eq.${user.id}&select=*&order=created_at.desc`,
    )
    // Recent catches per watch, one query for all of them.
    let hits = []
    if (watches?.length) {
      const ids = watches.map((w) => w.id).join(',')
      hits = await supa.select(
        'seen_items',
        `watch_id=in.(${ids})&select=watch_id,item_id,score,title,seen_at&order=seen_at.desc&limit=60`,
      )
    }
    return json({
      watches: watches || [],
      hits: hits || [],
      slots: { used: (watches || []).length, max: plan.watchSlots },
      cadenceFloor: plan.cadenceMinutes,
    })
  }

  if (req.method === 'POST') {
    if (plan.watchSlots === 0) {
      throw new HttpError(402, 'NO_WATCHES', `Watches need a paid plan — ${plan.label} has none`)
    }
    const existing = await supa.select('watches', `user_id=eq.${user.id}&select=id`)
    if ((existing || []).length >= plan.watchSlots) {
      throw new HttpError(402, 'WATCH_SLOTS', `All ${plan.watchSlots} watch slots used on ${plan.label}`)
    }
    let body
    try {
      body = await req.json()
    } catch {
      return json({ error: 'bad json' }, 400)
    }
    const cadence = Math.max(plan.cadenceMinutes, Number(body.cadenceMinutes) || plan.cadenceMinutes)
    const rows = await supa.insert('watches', [
      {
        user_id: user.id,
        name: String(body.name || 'untitled watch').slice(0, 80),
        enabled: body.enabled !== false,
        cadence_minutes: cadence,
        config: sanitizeConfig(body.config),
      },
    ])
    if (!rows?.[0]) return json({ error: 'insert failed' }, 500)
    return json({ watch: rows[0] })
  }

  if (req.method === 'PUT') {
    const id = url.searchParams.get('id')
    if (!id) return json({ error: 'id required' }, 400)
    let body
    try {
      body = await req.json()
    } catch {
      return json({ error: 'bad json' }, 400)
    }
    const patch = {}
    if (body.name != null) patch.name = String(body.name).slice(0, 80)
    if (body.enabled != null) patch.enabled = !!body.enabled
    if (body.cadenceMinutes != null) {
      patch.cadence_minutes = Math.max(plan.cadenceMinutes || 30, Number(body.cadenceMinutes) || 60)
    }
    if (body.config != null) patch.config = sanitizeConfig(body.config)
    // user_id filter = ownership check; service role would happily cross tenants.
    const rows = await supa.update('watches', `id=eq.${id}&user_id=eq.${user.id}`, patch)
    if (!rows?.length) throw new HttpError(404, 'NOT_FOUND', 'No such watch')
    return json({ watch: rows[0] })
  }

  if (req.method === 'DELETE') {
    const id = url.searchParams.get('id')
    if (!id) return json({ error: 'id required' }, 400)
    const ok = await supa.del('watches', `id=eq.${id}&user_id=eq.${user.id}`)
    return json({ deleted: ok })
  }

  return json({ error: 'GET/POST/PUT/DELETE only' }, 405)
})
