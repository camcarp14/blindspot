import { sb } from './_shared/ebay.mjs'

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

const soldUrl = (kw) =>
  `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(kw)}&LH_Sold=1&LH_Complete=1&_ipg=120`

const CACHE_TTL_MS = 7 * 24 * 36e5

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405)
  let body
  try {
    body = await req.json()
  } catch {
    return json({ error: 'bad json' }, 400)
  }
  const { keywords, categoryId = null, excluded = '' } = body
  if (!keywords) return json({ error: 'keywords required' }, 400)

  const supa = sb()

  // 1. Cache hit?
  if (supa) {
    const rows = await supa.select(
      'comps_cache',
      `keywords=eq.${encodeURIComponent(keywords)}&select=*`,
    )
    const hit = rows?.[0]
    if (hit && Date.now() - new Date(hit.fetched_at).getTime() < CACHE_TTL_MS) {
      return json({ ...hit.payload, source: hit.payload.source + ' (cached)', soldUrl: soldUrl(keywords) })
    }
  }

  // 2. RapidAPI sold-listings provider (third-party — eBay gates official sold data)
  const key = process.env.RAPIDAPI_KEY
  if (!key) {
    return json({
      manual: true,
      soldUrl: soldUrl(keywords),
      note: 'No RAPIDAPI_KEY set. Open the sold URL (or Terapeak in Seller Hub), eyeball the median of the last 5–10 true comps, and enter it manually on the card.',
    })
  }

  try {
    const res = await fetch('https://ebay-average-selling-price.p.rapidapi.com/findCompletedItems', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-rapidapi-key': key,
        'x-rapidapi-host': 'ebay-average-selling-price.p.rapidapi.com',
      },
      body: JSON.stringify({
        keywords,
        excluded_keywords: excluded,
        max_search_results: 120,
        remove_outliers: true,
        site_id: '0',
        ...(categoryId ? { category_id: String(categoryId) } : {}),
      }),
    })
    if (!res.ok) throw new Error(`RAPIDAPI_${res.status}`)
    const data = await res.json()
    const num = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v))
    const payload = {
      median: num(data.median_price),
      average: num(data.average_price),
      min: num(data.min_price),
      max: num(data.max_price),
      n: num(data.results) ?? 0,
      source: 'rapidapi',
    }
    if (supa && payload.median) {
      await supa.upsert(
        'comps_cache',
        [{ keywords, payload, fetched_at: new Date().toISOString() }],
        'keywords',
      )
    }
    return json({ ...payload, soldUrl: soldUrl(keywords) })
  } catch (e) {
    return json({
      manual: true,
      soldUrl: soldUrl(keywords),
      note: `Comps provider failed (${String(e.message)}). Enter the median manually.`,
    })
  }
}
