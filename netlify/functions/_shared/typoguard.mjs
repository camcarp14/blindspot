// Shared typo-hunt safety net — used by scan.mjs and watch-scan.mjs so the
// two never drift out of sync on how they handle typo false-positives.
//
// Multi-tenant upgrade: collisions aren't just the seed list + one user's
// excludes anymore. Confirmed collisions land in the typo_collisions table,
// so the first tenant to trip over the next "Nikor" retires it for everyone.
import { KNOWN_REAL_WORD_COLLISIONS } from '../../../src/lib/scoring.js'

export function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Pull the community collision list once per invocation. Cheap (single select,
// tiny table) and returns [] when Supabase isn't configured.
export async function loadLearnedCollisions(supa) {
  if (!supa) return []
  const rows = await supa.select('typo_collisions', 'select=term')
  return (rows || []).map((r) => r.term)
}

// Skip generating/querying a typo variant we already know is a real word or
// brand, not an accident. Saves an API call AND avoids scoring it as a find.
export function isKnownCollision(variant, userExclude = [], learned = []) {
  const v = variant.toLowerCase().trim()
  if (KNOWN_REAL_WORD_COLLISIONS.includes(v)) return true
  if (learned.some((t) => t.toLowerCase().trim() === v)) return true
  return userExclude.some((u) => u.toLowerCase().trim() === v)
}

// After fetching results for a typo-variant query: does the "typo" spelling
// look like a real, independently-used term rather than an accident? One
// seller making a typo is still a typo. The same "mistake," verbatim, from
// several unrelated sellers usually means it isn't one — it's just a word.
export function isLikelyRealTerm(variant, items, { minSellers = 3, minRatio = 0.4 } = {}) {
  if (!items?.length) return false
  const re = new RegExp(`\\b${escapeRegex(variant.toLowerCase())}\\b`)
  const sellers = new Set()
  let matches = 0
  for (const it of items) {
    if (re.test((it.title || '').toLowerCase())) {
      matches++
      if (it.seller?.username) sellers.add(it.seller.username)
    }
  }
  return sellers.size >= minSellers && matches / items.length >= minRatio
}

// A runtime detection just fired — remember it for every tenant. First
// sighting wins (ignore-duplicates); admins can prune false entries.
export async function recordCollision(supa, term, brand, sellerCount) {
  if (!supa) return
  await supa.upsert(
    'typo_collisions',
    [{ term: term.toLowerCase().trim(), brand: brand || null, seller_count: sellerCount || 0 }],
    'term',
  )
}
