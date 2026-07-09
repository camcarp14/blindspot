import { categorySuggestions } from './_shared/ebay.mjs'
import { requireUser, guarded, json } from './_shared/auth.mjs'

// Taxonomy API has its own eBay rate bucket (not Browse), so it doesn't touch
// the ledger — but it's still authenticated, because it's still our keyset.
export default guarded(async (req) => {
  await requireUser(req)
  const q = new URL(req.url).searchParams.get('q')
  if (!q) return json({ error: 'q required' }, 400)
  const suggestions = await categorySuggestions(q)
  return json({ suggestions })
})
