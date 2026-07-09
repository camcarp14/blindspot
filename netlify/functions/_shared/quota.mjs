// The 5,000/day ledger, server-side. v1 counted calls in localStorage — one
// browser's guess, blind to the watcher and to every other user. This is the
// real ledger: atomic reservations in Postgres, split into pools so the
// scheduler and interactive scans can't starve each other.

import { DAILY_QUOTA, poolCap } from '../../../src/lib/plans.js'

export function dailyQuota() {
  const env = Number(process.env.EBAY_DAILY_QUOTA)
  return Number.isFinite(env) && env > 0 ? env : DAILY_QUOTA
}

// Ask for `want` calls from a pool. Returns how many you actually got (0..want).
// Callers must degrade gracefully on a partial grant — cache-only beats a 500.
export async function reserveCalls(supa, pool, want) {
  if (!supa || want <= 0) return want // no ledger configured → solo mode, no limits
  const granted = await supa.rpc('reserve_api_budget', {
    p_pool: pool,
    p_want: want,
    p_cap: poolCap(pool, dailyQuota()),
  })
  return typeof granted === 'number' ? granted : 0
}

export async function recordUsage(supa, userId, { scans = 0, calls = 0, comps = 0 }) {
  if (!supa || !userId) return
  await supa.rpc('record_usage', {
    p_user: userId,
    p_scans: scans,
    p_calls: calls,
    p_comps: comps,
  })
}

export async function usageToday(supa, userId) {
  if (!supa) return { scans: 0, api_calls: 0, comp_pulls: 0 }
  const today = new Date().toISOString().slice(0, 10)
  const rows = await supa.select(
    'user_usage',
    `user_id=eq.${userId}&day=eq.${today}&select=scans,api_calls,comp_pulls`,
  )
  return rows?.[0] || { scans: 0, api_calls: 0, comp_pulls: 0 }
}

// Deployment-wide snapshot for meters (every user sees pool pressure honestly).
export async function budgetSnapshot(supa) {
  const quota = dailyQuota()
  const pools = {
    interactive: { used: 0, cap: poolCap('interactive', quota) },
    watch: { used: 0, cap: poolCap('watch', quota) },
  }
  if (supa) {
    const today = new Date().toISOString().slice(0, 10)
    const rows = await supa.select('api_budget', `day=eq.${today}&select=pool,used`)
    for (const r of rows || []) {
      if (pools[r.pool]) pools[r.pool].used = r.used
    }
  }
  return { quota, pools }
}
