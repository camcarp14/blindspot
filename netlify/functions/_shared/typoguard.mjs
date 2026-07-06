// Shared typo-hunt safety net — used by scan.mjs and watch-scan.mjs so the
// two never drift out of sync on how they handle typo false-positives.
import { KNOWN_REAL_WORD_COLLISIONS } from '../../../src/lib/scoring.js'

export function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Skip generating/querying a typo variant we already know is a real word or
// brand, not an accident. Saves an API call AND avoids scoring it as a find.
export function isKnownCollision(variant, userExclude = []) {
  const v = variant.toLowerCase().trim()
  if (KNOWN_REAL_WORD_COLLISIONS.includes(v)) return true
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
