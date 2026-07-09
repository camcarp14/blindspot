// Auth for functions — verifies the caller's Supabase JWT and resolves their
// profile + plan. Zero-dep: GoTrue REST, same style as the sb() helper.
//
// Env alignment rule: the CLIENT mints these tokens against VITE_SUPABASE_URL /
// VITE_SUPABASE_ANON_KEY, so the server verifies against the SAME vars first
// and only falls back to server-only names. Two names, one project — always.

import { sb } from './ebay.mjs'
import { planOf } from '../../../src/lib/plans.js'

const SUPA_URL = () => process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL
const ANON_KEY = () => process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY

export const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message || code)
    this.status = status
    this.code = code
  }
}

// Loud guard: a missing env var must read as "server misconfigured", never as
// "not signed in" — that lie once cost a whole debugging session.
function requireEnv() {
  const missing = []
  if (!SUPA_URL()) missing.push('VITE_SUPABASE_URL')
  if (!ANON_KEY()) missing.push('VITE_SUPABASE_ANON_KEY')
  if (!process.env.SUPABASE_SERVICE_KEY) missing.push('SUPABASE_SERVICE_KEY')
  if (missing.length) {
    throw new HttpError(500, 'SERVER_MISCONFIGURED', `Missing env: ${missing.join(', ')}`)
  }
}

// Verify the bearer token and return { user, profile, plan }.
// Creates the profile row if the signup trigger somehow missed it, and
// bootstraps the admin account (ADMIN_EMAIL) — including claiming any v1 rows
// that predate multi-tenancy (user_id is null).
export async function requireUser(req) {
  requireEnv()
  const authz = req.headers.get('authorization') || ''
  const token = authz.startsWith('Bearer ') ? authz.slice(7) : null
  if (!token) throw new HttpError(401, 'NOT_SIGNED_IN', 'Sign in required')

  const res = await fetch(`${SUPA_URL()}/auth/v1/user`, {
    headers: { apikey: ANON_KEY(), Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new HttpError(401, 'BAD_TOKEN', 'Session expired — sign in again')
  const user = await res.json()
  if (!user?.id) throw new HttpError(401, 'BAD_TOKEN', 'Session expired — sign in again')

  const supa = sb()
  let rows = await supa.select('profiles', `id=eq.${user.id}&select=*`)
  let profile = rows?.[0]
  if (!profile) {
    const created = await supa.insert('profiles', [{ id: user.id, email: user.email }])
    profile = created?.[0] || { id: user.id, email: user.email, plan: 'scout', econ: {}, typo_exclude: [] }
  }

  const adminEmail = (process.env.ADMIN_EMAIL || '').toLowerCase()
  if (adminEmail && user.email?.toLowerCase() === adminEmail && !profile.is_admin) {
    await supa.update('profiles', `id=eq.${user.id}`, { is_admin: true })
    profile.is_admin = true
    // Claim single-user-era rows so the owner's history survives the upgrade.
    await supa.update('watches', 'user_id=is.null', { user_id: user.id })
    await supa.update('deals', 'user_id=is.null', { user_id: user.id })
  }

  return { user, profile, plan: planOf(profile.plan) }
}

// Wrapper so every endpoint reports HttpErrors uniformly and nothing leaks a stack.
export function guarded(handler) {
  return async (req, ctx) => {
    try {
      return await handler(req, ctx)
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message, code: e.code }, e.status)
      console.error('unhandled:', e)
      return json({ error: 'internal error', code: 'INTERNAL' }, 500)
    }
  }
}
