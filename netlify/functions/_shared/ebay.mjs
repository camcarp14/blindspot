// eBay Browse API client — client-credentials OAuth with in-memory token cache.
// Browse API is the official, ToS-compliant way to read active listings.

const TOKEN_URL = 'https://api.ebay.com/identity/v1/oauth2/token'
const BROWSE_URL = 'https://api.ebay.com/buy/browse/v1/item_summary/search'
const TAXONOMY_URL = 'https://api.ebay.com/commerce/taxonomy/v1/category_tree/0'

let cached = { token: null, exp: 0 }

export async function getToken() {
  if (cached.token && Date.now() < cached.exp - 60_000) return cached.token
  const id = process.env.EBAY_CLIENT_ID
  const secret = process.env.EBAY_CLIENT_SECRET
  if (!id || !secret) throw new Error('MISSING_EBAY_CREDS')

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64'),
    },
    body: 'grant_type=client_credentials&scope=' +
      encodeURIComponent('https://api.ebay.com/oauth/api_scope'),
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`EBAY_TOKEN_${res.status}: ${body.slice(0, 300)}`)
  }
  const data = await res.json()
  cached = { token: data.access_token, exp: Date.now() + data.expires_in * 1000 }
  return cached.token
}

function buildFilter({ maxPrice, minPrice, auctionOnly, conditionIds, endingWithinHours }) {
  const parts = []
  if (maxPrice || minPrice) {
    parts.push(`price:[${minPrice || 1}..${maxPrice || ''}]`, 'priceCurrency:USD')
  }
  if (auctionOnly) parts.push('buyingOptions:{AUCTION}')
  if (conditionIds?.length) parts.push(`conditionIds:{${conditionIds.join('|')}}`)
  if (endingWithinHours) {
    const until = new Date(Date.now() + endingWithinHours * 36e5).toISOString().replace(/\.\d+Z$/, 'Z')
    parts.push(`itemEndDate:[..${until}]`)
  }
  return parts.join(',')
}

export async function browseSearch(params) {
  const token = await getToken()
  const q = new URLSearchParams()
  if (params.q) q.set('q', params.q)
  if (params.categoryIds?.length) q.set('category_ids', params.categoryIds.join(','))
  q.set('limit', String(Math.min(params.limit || 50, 200)))
  if (params.sort) q.set('sort', params.sort)
  const filter = buildFilter(params)
  if (filter) q.set('filter', filter)

  const res = await fetch(`${BROWSE_URL}?${q}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'X-EBAY-C-MARKETPLACE-ID': process.env.EBAY_MARKETPLACE || 'EBAY_US',
    },
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`EBAY_BROWSE_${res.status}: ${body.slice(0, 300)}`)
  }
  const data = await res.json()
  return data.itemSummaries || []
}

export async function categorySuggestions(query) {
  const token = await getToken()
  const res = await fetch(
    `${TAXONOMY_URL}/get_category_suggestions?q=${encodeURIComponent(query)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  )
  if (!res.ok) throw new Error(`EBAY_TAXONOMY_${res.status}`)
  const data = await res.json()
  return (data.categorySuggestions || []).slice(0, 8).map((s) => ({
    categoryId: s.category?.categoryId,
    name: s.category?.categoryName,
    path: (s.categoryTreeNodeAncestors || [])
      .map((a) => a.categoryName)
      .reverse()
      .join(' › '),
  }))
}

// Server-side economics overrides from env (FEE_RATE / PER_ORDER_FEE).
// Merged over DEFAULT_ECON, under any per-request/per-watch econ.
export function envEcon() {
  const e = {}
  if (process.env.FEE_RATE && !Number.isNaN(Number(process.env.FEE_RATE))) {
    e.feeRate = Number(process.env.FEE_RATE)
  }
  if (process.env.PER_ORDER_FEE && !Number.isNaN(Number(process.env.PER_ORDER_FEE))) {
    e.perOrderFee = Number(process.env.PER_ORDER_FEE)
  }
  return e
}

// Tiny Supabase REST helper — zero-dep, only used when env is configured.
export function sb() {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) return null
  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
  }
  return {
    async select(table, query = '') {
      const r = await fetch(`${url}/rest/v1/${table}?${query}`, { headers })
      return r.ok ? r.json() : []
    },
    async upsert(table, rows, onConflict) {
      const r = await fetch(
        `${url}/rest/v1/${table}${onConflict ? `?on_conflict=${onConflict}` : ''}`,
        {
          method: 'POST',
          headers: { ...headers, Prefer: 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify(rows),
        },
      )
      return r.ok
    },
  }
}
