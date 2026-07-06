import { useEffect, useState } from 'react'
import Reticle from './Reticle.jsx'

function useCountdown(endDate) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!endDate) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [endDate])
  if (!endDate) return null
  const ms = new Date(endDate) - now
  if (ms <= 0) return 'ENDED'
  const h = Math.floor(ms / 36e5)
  const m = Math.floor((ms % 36e5) / 6e4)
  const s = Math.floor((ms % 6e4) / 1000)
  return h > 48
    ? `${Math.floor(h / 24)}d ${h % 24}h`
    : `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

export default function DealCard({ deal, rank, onGetComps, onManualComp, compsBusy }) {
  const countdown = useCountdown(deal.endDate)
  const [manualVal, setManualVal] = useState('')
  const [showManual, setShowManual] = useState(false)
  const urgent = countdown && countdown !== 'ENDED' && new Date(deal.endDate) - Date.now() < 6 * 36e5
  const m = deal.margin

  return (
    <article className={`card ${deal.score >= 70 ? 'card-hot' : ''}`}>
      <div className="card-rank" aria-hidden="true">{String(rank).padStart(2, '0')}</div>
      <Reticle score={deal.score} />

      <div className="card-main">
        <a className="card-title" href={deal.url} target="_blank" rel="noreferrer">
          {deal.title}
        </a>

        <div className="card-stats">
          <span className="stat-price">${deal.price.toFixed(2)}</span>
          {deal.buyingOptions.includes('AUCTION') && (
            <span className="stat">{deal.bidCount ?? 0} bids</span>
          )}
          {countdown && (
            <span className={`stat mono ${urgent ? 'stat-urgent' : ''}`}>{countdown}</span>
          )}
          {deal.condition && <span className="stat">{deal.condition}</span>}
          {deal.seller && <span className="stat">fb {deal.seller.fb}</span>}
          <span className={`stat conf conf-${deal.confidence.toLowerCase()}`}>{deal.confidence}</span>
        </div>

        <div className="card-signals">
          {deal.signals.map((s) => (
            <span key={s.code} className="chip">{s.label}</span>
          ))}
        </div>

        {m ? (
          <div className={`margin ${m.estNet <= 0 ? 'margin-under' : ''}`}>
            comp ${m.compMedian} → est net{' '}
            <strong>${m.estNet}</strong> ({m.marginPct}%)
            {m.estNet <= 0 && ' — underwater after fees'}
          </div>
        ) : (
          <div className="comp-actions">
            <button
              className="btn-ghost"
              disabled={compsBusy}
              onClick={() => onGetComps(deal)}
            >
              {compsBusy ? 'pulling comps…' : 'Get comps'}
            </button>
            <button className="btn-ghost" onClick={() => setShowManual((v) => !v)}>
              Enter median
            </button>
            {showManual && (
              <span className="manual-comp">
                $
                <input
                  className="input input-tiny"
                  inputMode="decimal"
                  value={manualVal}
                  onChange={(e) => setManualVal(e.target.value)}
                  aria-label="Manual comp median"
                />
                <button
                  className="btn-ghost"
                  onClick={() => {
                    const v = parseFloat(manualVal)
                    if (v > 0) onManualComp(deal, v)
                  }}
                >
                  Apply
                </button>
              </span>
            )}
          </div>
        )}
      </div>

      {deal.image && <img className="card-thumb" src={deal.image} alt="" loading="lazy" />}
    </article>
  )
}
