// Deals pipeline — the status column (watching → bid → won/lost → listed →
// sold) existed in v1's schema with no interface. This is that interface,
// plus the outcome fields that close the loop: what it actually sold for and
// what shipping actually cost, so realized P&L can be checked against the
// comp math that justified the buy.

import { sb } from './_shared/ebay.mjs'
import { requireUser, guarded, json, HttpError } from './_shared/auth.mjs'

export const STATUSES = ['watching', 'bid', 'won', 'lost', 'listed', 'sold']

export default guarded(async (req) => {
  const { user } = await requireUser(req)
  const supa = sb()
  const url = new URL(req.url)

  if (req.method === 'GET') {
    const deals = await supa.select(
      'deals',
      `user_id=eq.${user.id}&select=*&order=updated_at.desc&limit=500`,
    )
    return json({ configured: true, deals: deals || [] })
  }

  if (req.method === 'POST') {
    let body
    try {
      body = await req.json()
    } catch {
      return json({ error: 'bad json' }, 400)
    }
    const { itemId, title, url: itemUrl, buyPrice, compMedian, estNet } = body
    if (!itemId) return json({ error: 'itemId required' }, 400)
    const ok = await supa.upsert(
      'deals',
      [
        {
          user_id: user.id,
          item_id: itemId,
          title,
          url: itemUrl,
          buy_price: buyPrice ?? null,
          comp_median: compMedian ?? null,
          est_net: estNet ?? null,
          updated_at: new Date().toISOString(),
        },
      ],
      'user_id,item_id',
    )
    return json({ configured: true, saved: ok })
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
    const num = (v) => (v === '' || v == null || Number.isNaN(Number(v)) ? null : Number(v))
    const patch = { updated_at: new Date().toISOString() }
    if (body.status != null) {
      if (!STATUSES.includes(body.status)) {
        throw new HttpError(400, 'BAD_STATUS', `status must be one of ${STATUSES.join(', ')}`)
      }
      patch.status = body.status
    }
    if ('notes' in body) patch.notes = body.notes == null ? null : String(body.notes).slice(0, 2000)
    if ('buyPrice' in body) patch.buy_price = num(body.buyPrice)
    if ('soldPrice' in body) patch.sold_price = num(body.soldPrice)
    if ('shipCost' in body) patch.ship_cost = num(body.shipCost)
    if ('compMedian' in body) patch.comp_median = num(body.compMedian)

    const rows = await supa.update('deals', `id=eq.${id}&user_id=eq.${user.id}`, patch)
    if (!rows?.length) throw new HttpError(404, 'NOT_FOUND', 'No such deal')
    return json({ deal: rows[0] })
  }

  if (req.method === 'DELETE') {
    const id = url.searchParams.get('id')
    if (!id) return json({ error: 'id required' }, 400)
    const ok = await supa.del('deals', `id=eq.${id}&user_id=eq.${user.id}`)
    return json({ deleted: ok })
  }

  return json({ error: 'GET/POST/PUT/DELETE only' }, 405)
})
