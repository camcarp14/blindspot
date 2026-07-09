import { useEffect, useMemo, useState } from 'react'
import { api } from '../lib/api.js'
import { DEFAULT_ECON } from '../lib/scoring.js'
import { useToast, SkList, Num } from './polish.jsx'

// The pipeline closes Blindspot's loop. The scanner said "this clears your
// bar"; this page records whether it actually did — what you paid, what it
// sold for, what shipping really cost — so the comp math earns (or loses)
// your trust with data.

const STATUSES = ['watching', 'bid', 'won', 'listed', 'sold', 'lost']
const STATUS_LABEL = {
  watching: 'Watching',
  bid: 'Bid placed',
  won: 'Won — inbound',
  listed: 'Relisted',
  sold: 'Sold',
  lost: 'Lost',
}

// Realized net on a sold deal, same fee model as scoring.js marginMath.
function realizedNet(deal, econ) {
  if (deal.sold_price == null || deal.buy_price == null) return null
  const gross = Number(deal.sold_price) * (1 - econ.feeRate) - econ.perOrderFee
  return Math.round((gross - Number(deal.ship_cost || 0) - Number(deal.buy_price)) * 100) / 100
}

function DealRow({ deal, econ, onUpdate, onDelete }) {
  const toast = useToast()
  const [notes, setNotes] = useState(deal.notes || '')
  const [sold, setSold] = useState({ price: deal.sold_price ?? '', ship: deal.ship_cost ?? '' })
  const [confirmDel, setConfirmDel] = useState(false)
  const net = realizedNet(deal, econ)

  const patch = async (p, msg) => {
    try {
      await onUpdate(deal.id, p)
      if (msg) toast(msg)
    } catch (e) {
      toast(e.message, { err: true })
    }
  }

  return (
    <article className="card deal-row">
      <div className="card-main">
        <a className="card-title" href={deal.url} target="_blank" rel="noreferrer">
          {deal.title || deal.item_id}
        </a>
        <div className="card-stats">
          {deal.buy_price != null && <span className="stat-price">${Number(deal.buy_price).toFixed(2)}</span>}
          {deal.comp_median != null && <span className="stat">comp ${deal.comp_median}</span>}
          {deal.est_net != null && <span className="stat">est net ${deal.est_net}</span>}
          {net != null && (
            <span className={`stat mono ${net >= 0 ? 'stat-gain' : 'stat-loss'}`}>
              realized {net >= 0 ? '+' : '−'}${Math.abs(net).toFixed(2)}
            </span>
          )}
          <span className="stat mono dim-note">{new Date(deal.created_at).toLocaleDateString()}</span>
        </div>

        <div className="deal-controls">
          <select
            className="input"
            value={deal.status}
            onChange={(e) => patch({ status: e.target.value }, `→ ${STATUS_LABEL[e.target.value]}`)}
          >
            {STATUSES.map((s) => (
              <option key={s} value={s}>{STATUS_LABEL[s]}</option>
            ))}
          </select>

          {deal.status === 'sold' && (
            <span className="sold-form mono">
              sold $
              <input
                className="input input-tiny"
                inputMode="decimal"
                value={sold.price}
                onChange={(e) => setSold((s) => ({ ...s, price: e.target.value }))}
              />
              ship $
              <input
                className="input input-tiny"
                inputMode="decimal"
                value={sold.ship}
                onChange={(e) => setSold((s) => ({ ...s, ship: e.target.value }))}
              />
              <button
                className="btn-ghost"
                onClick={() => patch({ soldPrice: sold.price, shipCost: sold.ship }, 'Outcome recorded')}
              >
                Record
              </button>
            </span>
          )}

          {confirmDel ? (
            <>
              <button className="btn-ghost btn-danger" onClick={() => onDelete(deal.id)}>Confirm</button>
              <button className="btn-ghost" onClick={() => setConfirmDel(false)}>Keep</button>
            </>
          ) : (
            <button className="btn-ghost" onClick={() => setConfirmDel(true)}>Remove</button>
          )}
        </div>

        <input
          className="input deal-notes"
          placeholder="notes — serial, flaw, recap parts, buyer…"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          onBlur={() => notes !== (deal.notes || '') && patch({ notes })}
        />
      </div>
    </article>
  )
}

export default function Pipeline({ me }) {
  const [deals, setDeals] = useState(null)
  const [failed, setFailed] = useState(false)
  const econ = { ...DEFAULT_ECON, ...(me?.profile?.econ || {}) }

  const load = () =>
    api
      .deals()
      .then((d) => setDeals(d.deals || []))
      .catch(() => setFailed(true))
  useEffect(() => {
    load()
  }, [])

  const update = async (id, p) => {
    const { deal } = await api.updateDeal(id, p)
    setDeals((ds) => ds.map((d) => (d.id === id ? deal : d)))
  }
  const remove = async (id) => {
    await api.deleteDeal(id)
    setDeals((ds) => ds.filter((d) => d.id !== id))
  }

  const summary = useMemo(() => {
    if (!deals) return null
    const inPlay = deals.filter((d) => ['won', 'listed'].includes(d.status))
    const soldDeals = deals.filter((d) => d.status === 'sold')
    const capital = inPlay.reduce((s, d) => s + Number(d.buy_price || 0), 0)
    const unrealized = inPlay.reduce((s, d) => s + Number(d.est_net || 0), 0)
    const realized = soldDeals.reduce((s, d) => s + (realizedNet(d, econ) ?? 0), 0)
    const settled = soldDeals.filter((d) => realizedNet(d, econ) != null)
    const winners = settled.filter((d) => realizedNet(d, econ) > 0)
    return {
      capital,
      unrealized,
      realized,
      hitRate: settled.length ? Math.round((winners.length / settled.length) * 100) : null,
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deals, me])

  if (failed) {
    return (
      <div className="view pagefade">
        <div className="empty">
          <p className="empty-head">Couldn't load the pipeline.</p>
          <button className="btn-ghost" onClick={() => { setFailed(false); load() }}>Retry</button>
        </div>
      </div>
    )
  }
  if (!deals) return <div className="view"><SkList n={4} /></div>

  if (deals.length === 0) {
    return (
      <div className="view pagefade">
        <div className="empty">
          <p className="empty-head">Nothing in the pipeline.</p>
          <p>
            Hit Save on a deal card after a scan and it lands here — then walk it through
            bid → won → relisted → sold, and record what it actually made. The realized column is
            how you find out which comps to trust.
          </p>
        </div>
      </div>
    )
  }

  const byStatus = (s) => deals.filter((d) => d.status === s)

  return (
    <div className="view pagefade">
      <div className="view-head">
        <h2>Pipeline</h2>
      </div>

      <div className="summary-row stagger">
        <div className="summary-cell">
          <span className="summary-label">capital in play</span>
          <span className="summary-val mono">$<Num v={Math.round(summary.capital)} /></span>
        </div>
        <div className="summary-cell">
          <span className="summary-label">est. unrealized</span>
          <span className="summary-val mono">$<Num v={Math.round(summary.unrealized)} /></span>
        </div>
        <div className="summary-cell">
          <span className="summary-label">realized net</span>
          <span className={`summary-val mono ${summary.realized >= 0 ? 'stat-gain' : 'stat-loss'}`}>
            $<Num v={Math.round(summary.realized)} />
          </span>
        </div>
        <div className="summary-cell">
          <span className="summary-label">hit rate</span>
          <span className="summary-val mono">
            {summary.hitRate == null ? '—' : <><Num v={summary.hitRate} />%</>}
          </span>
        </div>
      </div>

      {STATUSES.map((s) => {
        const list = byStatus(s)
        if (!list.length) return null
        return (
          <section key={s} className="pipe-section">
            <h3 className="pipe-head">
              {STATUS_LABEL[s]} <span className="mono dim-note">{list.length}</span>
            </h3>
            <div className="stagger">
              {list.map((d) => (
                <DealRow key={d.id} deal={d} econ={econ} onUpdate={update} onDelete={remove} />
              ))}
            </div>
          </section>
        )
      })}
    </div>
  )
}
