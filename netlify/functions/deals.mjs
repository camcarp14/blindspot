import { sb } from './_shared/ebay.mjs'

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

export default async (req) => {
  const supa = sb()
  if (!supa) return json({ configured: false, deals: [] })

  if (req.method === 'GET') {
    const rows = await supa.select('deals', 'select=*&order=created_at.desc&limit=100')
    return json({ configured: true, deals: rows || [] })
  }

  if (req.method === 'POST') {
    let body
    try {
      body = await req.json()
    } catch {
      return json({ error: 'bad json' }, 400)
    }
    const { itemId, title, url, buyPrice, compMedian, estNet } = body
    if (!itemId) return json({ error: 'itemId required' }, 400)
    const ok = await supa.upsert(
      'deals',
      [
        {
          item_id: itemId,
          title,
          url,
          buy_price: buyPrice ?? null,
          comp_median: compMedian ?? null,
          est_net: estNet ?? null,
        },
      ],
      'item_id',
    )
    return json({ configured: true, saved: ok })
  }

  return json({ error: 'GET or POST only' }, 405)
}
