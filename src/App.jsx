import { useEffect, useMemo, useState } from 'react'
import Loadout from './components/Loadout.jsx'
import DealCard from './components/DealCard.jsx'
import { api } from './lib/api.js'
import { scoreItem, DEFAULT_ECON } from './lib/scoring.js'

const DEFAULT_CFG = {
  presetId: null,
  queries: '',
  typoBrands: '',
  typoHunt: true,
  auctionOnly: true,
  fixable: false,
  expectModelNumbers: true,
  maxPrice: 500,
  endingWithinHours: '',
  shipEstimate: 15,
  categoryIds: '',
}

const loadComps = () => {
  try {
    return JSON.parse(localStorage.getItem('blindspot.comps') || '{}')
  } catch {
    return {}
  }
}

export default function App() {
  const [cfg, setCfg] = useState(DEFAULT_CFG)
  const [comps, setComps] = useState(loadComps)
  const [results, setResults] = useState(null)
  const [scanning, setScanning] = useState(false)
  const [compsBusy, setCompsBusy] = useState(null) // itemId currently fetching
  const [status, setStatus] = useState({ token: 'checking', apiCalls: 0, errors: [] })

  useEffect(() => {
    api
      .health()
      .then((h) =>
        setStatus((s) => ({
          ...s,
          token: h.ok ? 'live' : 'error',
          tokenError: h.error,
          econ: h.econ || null, // server's fee config, so client scores match
        })),
      )
      .catch(() => setStatus((s) => ({ ...s, token: 'error' })))
  }, [])

  useEffect(() => {
    localStorage.setItem('blindspot.comps', JSON.stringify(comps))
  }, [comps])

  const buildPayload = () => ({
    queries: cfg.queries.split('\n').map((s) => s.trim()).filter(Boolean),
    typoBrands: cfg.typoBrands.split(',').map((s) => s.trim()).filter(Boolean),
    typoHunt: cfg.typoHunt,
    auctionOnly: cfg.auctionOnly,
    fixable: cfg.fixable,
    expectModelNumbers: cfg.expectModelNumbers,
    maxPrice: cfg.maxPrice ? Number(cfg.maxPrice) : null,
    endingWithinHours: cfg.endingWithinHours ? Number(cfg.endingWithinHours) : null,
    categoryIds: cfg.categoryIds.split(',').map((s) => s.trim()).filter(Boolean),
    conditionIds: cfg.conditionIds || [],
    comps,
    econ: { shipEstimate: Number(cfg.shipEstimate) || 15 },
  })

  const scan = async () => {
    setScanning(true)
    try {
      const data = await api.scan(buildPayload())
      setResults(data.results || [])
      setStatus((s) => ({
        ...s,
        apiCalls: s.apiCalls + (data.apiCalls || 0),
        errors: data.errors || [],
      }))
    } catch (e) {
      setResults([])
      setStatus((s) => ({ ...s, errors: [String(e.message)] }))
    } finally {
      setScanning(false)
    }
  }

  // Fetch comps for a deal's originating query, store, rescore locally.
  const getComps = async (deal) => {
    setCompsBusy(deal.itemId)
    try {
      const kw = deal.queryKey.startsWith('typo:')
        ? deal.queryKey.slice(5)
        : deal.queryKey
      const data = await api.comps(kw)
      if (data.median) {
        setComps((c) => ({
          ...c,
          [deal.queryKey]: { median: Number(data.median), n: Number(data.n) || 0 },
        }))
      } else if (data.manual) {
        window.open(data.soldUrl, '_blank', 'noopener')
      }
    } finally {
      setCompsBusy(null)
    }
  }

  const manualComp = (deal, median) => {
    setComps((c) => ({ ...c, [deal.queryKey]: { median, n: 1 } }))
  }

  // Re-scoring after comps land happens LOCALLY — scoring.js is the same module
  // the functions import, so scores can't drift, and no API quota is spent.
  const rescored = useMemo(() => {
    if (!results) return null
    const econ = {
      ...DEFAULT_ECON,
      ...(status.econ || {}),
      shipEstimate: Number(cfg.shipEstimate) || DEFAULT_ECON.shipEstimate,
    }
    return results
      .map((deal) => {
        if (!deal.raw) return deal
        const compEntry = comps[deal.queryKey] || null
        const scored = scoreItem(deal.raw, {
          typoOrigin: deal.typoOrigin,
          correctBrand: deal.correctBrand,
          fixable: cfg.fixable,
          expectModelNumbers: cfg.expectModelNumbers,
          compMedian: compEntry?.median || null,
          compN: compEntry?.n || 0,
          econ,
        })
        return { ...deal, ...scored }
      })
      .sort((a, b) => b.score - a.score)
  }, [results, comps, status.econ, cfg.shipEstimate, cfg.fixable, cfg.expectModelNumbers])

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">◎</span>
          <h1>Blindspot</h1>
          <span className="brand-sub">the market's blind spot, ranked</span>
        </div>
        <div className="statusbar mono">
          <span className={`led led-${status.token}`} />
          <span>{status.token === 'live' ? 'eBay token live' : status.token === 'checking' ? 'checking token…' : 'token error'}</span>
          <span className="sep">·</span>
          <span>{status.apiCalls} calls this session</span>
        </div>
      </header>

      {status.token === 'error' && (
        <div className="banner">
          eBay credentials failed{status.tokenError ? ` — ${status.tokenError}` : ''}. Set
          EBAY_CLIENT_ID and EBAY_CLIENT_SECRET in your environment, then reload.
        </div>
      )}
      {status.errors.length > 0 && (
        <div className="banner banner-warn">
          {status.errors.length} quer{status.errors.length === 1 ? 'y' : 'ies'} failed:{' '}
          {status.errors[0]}
        </div>
      )}

      <main className="layout">
        <Loadout cfg={cfg} setCfg={setCfg} onScan={scan} scanning={scanning} />

        <section className="feed" aria-live="polite">
          {scanning && <div className="sweep" aria-hidden="true" />}
          {!results && !scanning && (
            <div className="empty">
              <p className="empty-head">No scan yet.</p>
              <p>Pick a loadout, tune the filters, hit Scan. Typo hunt runs misspelled brand variants that regular searchers never see.</p>
            </div>
          )}
          {rescored && rescored.length === 0 && !scanning && (
            <div className="empty">
              <p className="empty-head">Nothing cleared.</p>
              <p>No listings matched this loadout. Widen price, drop the ending-soon window, or add queries — don't lower your bar.</p>
            </div>
          )}
          {rescored &&
            rescored.map((deal, i) => (
              <DealCard
                key={deal.itemId}
                deal={deal}
                rank={i + 1}
                onGetComps={getComps}
                onManualComp={manualComp}
                compsBusy={compsBusy === deal.itemId}
              />
            ))}
        </section>
      </main>

      <footer className="foot">
        Scanner + alerts only — bids are placed by you, on eBay. Comps: median of true sold
        comparables beats asking prices every time.
      </footer>
    </div>
  )
}
