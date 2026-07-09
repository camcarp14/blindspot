// eBay Browse API client — client-credentials OAuth with in-memory token cache.
// Browse API is the official, ToS-compliant way to read active listings.

import { createHash } from 'node:crypto'

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

// Everything that changes which items come back — used by the shared scan
// cache so two tenants running the same loadout share one Browse call. The
// endingWithinHours window is bucketed to the hour; sub-hour drift between two
// users' identical scans doesn't defeat the cache, TTL keeps it honest.
export function scanCacheKey(params) {
  const sig = JSON.stringify({
    q: params.q || '',
    cat: [...(params.categoryIds || [])].sort(),
    cond: [...(params.conditionIds || [])].sort(),
    auc: !!params.auctionOnly,
    max: params.maxPrice || null,
    min: params.minPrice || null,
    end: params.endingWithinHours || null,
    lim: params.limit || 50,
    sort: params.sort || '',
    mkt: process.env.EBAY_MARKETPLACE || 'EBAY_US',
  })
  return createHash('sha1').update(sig).digest('hex')
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

// Tiny Supabase REST helper — zero-dep, service role, server-side only.
// VITE_-first so functions and client can never point at different projects.
export function sb() {
  const url = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL
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
    async insert(table, rows) {
      const r = await fetch(`${url}/rest/v1/${table}`, {
        method: 'POST',
        headers: { ...headers, Prefer: 'return=representation' },
        body: JSON.stringify(rows),
      })
      return r.ok ? r.json() : null
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
    async update(table, query, patch) {
      const r = await fetch(`${url}/rest/v1/${table}?${query}`, {
        method: 'PATCH',
        headers: { ...headers, Prefer: 'return=representation' },
        body: JSON.stringify(patch),
      })
      return r.ok ? r.json() : null
    },
    async del(table, query) {
      const r = await fetch(`${url}/rest/v1/${table}?${query}`, {
        method: 'DELETE',
        headers,
      })
      return r.ok
    },
    async rpc(fn, args) {
      const r = await fetch(`${url}/rest/v1/rpc/${fn}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(args || {}),
      })
      if (!r.ok) return null
      const text = await r.text()
      try { return JSON.parse(text) } catch { return text }
    },
  }
}
