import { useEffect, useMemo, useState } from 'react'
import Loadout from './Loadout.jsx'
import DealCard from './DealCard.jsx'
import { api, ApiError } from '../lib/api.js'
import { PRESETS } from '../lib/presets.js'
import { clearsThreshold, maxJustifiedBid, DEFAULT_ECON } from '../lib/scoring.js'
import { useToast } from './polish.jsx'

const DEFAULT_CFG = {
  presetId: null,
  queries: '',
  typoBrands: '',
  typoExclude: '',
  excludeKeywords: '',
  typoHunt: true,
  auctionOnly: true,
  fixable: false,
  expectModelNumbers: true,
  maxPrice: 500,
  endingWithinHours: '',
  shipEstimate: 15,
  categoryIds: '',
  conditionIds: '',
}

const loadJSON = (key, fallback) => {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : fallback
  } catch {
    return fallback
  }
}

const SORTERS = {
  score: (a, b) => b.score - a.score,
  margin: (a, b) => (b.margin?.marginPct ?? -Infinity) - (a.margin?.marginPct ?? -Infinity),
  net: (a, b) => (b.margin?.estNet ?? -Infinity) - (a.margin?.estNet ?? -Infinity),
  ending: (a, b) => {
    const ea = a.endDate ? new Date(a.endDate).getTime() : Infinity
    const eb = b.endDate ? new Date(b.endDate).getTime() : Infinity
    return ea - eb
  },
  price: (a, b) => a.price - b.price,
}

export default function ScanView({ me, onUsage, onGoSettings, watchSlots }) {
  const toast = useToast()
  const [cfg, setCfg] = useState(() => ({ ...DEFAULT_CFG, ...loadJSON('blindspot.cfg', {}) }))
  const [comps, setComps] = useState(() => loadJSON('blindspot.comps', {}))
  const [results, setResults] = useState(null)
  const [queryStats, setQueryStats] = useState([])
  const [scanning, setScanning] = useState(false)
  const [compsBusy, setCompsBusy] = useState(null)
  const [bulkCompsBusy, setBulkCompsBusy] = useState(false)
  const [errors, setErrors] = useState([])
  const [limitHit, setLimitHit] = useState(null) // message from a 402
  const [degraded, setDegraded] = useState(false)
  const [saved, setSaved] = useState(new Set())
  const [dismissed, setDismissed] = useState(new Set())
  const [sortBy, setSortBy] = useState('score')
  const [thresholdOn, setThresholdOn] = useState(false)
  const [minMarginPct, setMinMarginPct] = useState(30)
  const [minNetUsd, setMinNetUsd] = useState(25)
  const [loadoutOpen, setLoadoutOpen] = useState(false)
  const [savingWatch, setSavingWatch] = useState(false)

  useEffect(() => {
    localStorage.setItem('blindspot.comps', JSON.stringify(comps))
  }, [comps])

  useEffect(() => {
    localStorage.setItem('blindspot.cfg', JSON.stringify(cfg))
  }, [cfg])

  // Power-user shortcut: "S" triggers a scan, unless you're typing somewhere.
  // The command palette fires the same custom event.
  useEffect(() => {
    const onKey = (e) => {
      const tag = document.activeElement?.tagName
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) return
      if (e.key.toLowerCase() === 's' && !e.metaKey && !e.ctrlKey) scan()
    }
    const onEvent = () => scan()
    window.addEventListener('keydown', onKey)
    window.addEventListener('blindspot:scan', onEvent)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('blindspot:scan', onEvent)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg, comps])

  const buildPayload = () => ({
    queries: cfg.queries.split('\n').map((s) => s.trim()).filter(Boolean),
    typoBrands: cfg.typoBrands.split(',').map((s) => s.trim()).filter(Boolean),
    typoExclude: cfg.typoExclude.split(',').map((s) => s.trim()).filter(Boolean),
    excludeKeywords: cfg.excludeKeywords.split(',').map((s) => s.trim()).filter(Boolean),
    typoHunt: cfg.typoHunt,
    auctionOnly: cfg.auctionOnly,
    fixable: cfg.fixable,
    expectModelNumbers: cfg.expectModelNumbers,
    maxPrice: cfg.maxPrice ? Number(cfg.maxPrice) : null,
    endingWithinHours: cfg.endingWithinHours ? Number(cfg.endingWithinHours) : null,
    categoryIds: cfg.categoryIds.split(',').map((s) => s.trim()).filter(Boolean),
    conditionIds: cfg.conditionIds.split(',').map((s) => s.trim()).filter(Boolean),
    comps,
    econ: { shipEstimate: Number(cfg.shipEstimate) || 15 },
  })

  const scan = async () => {
    setScanning(true)
    setLimitHit(null)
    try {
      const data = await api.scan(buildPayload())
      setResults(data.results || [])
      setQueryStats(data.queryStats || [])
      setErrors(data.errors || [])
      setDegraded(!!data.degraded)
      if (data.usage) onUsage(data.usage, data.budget)
      if (window.innerWidth <= 880) setLoadoutOpen(false) // reveal results on mobile
    } catch (e) {
      if (e instanceof ApiError && e.status === 402) {
        setLimitHit(e.message)
      } else {
        setResults([])
        setErrors([String(e.message)])
      }
    } finally {
      setScanning(false)
    }
  }

  const getComps = async (deal) => {
    setCompsBusy(deal.itemId)
    try {
      const kw = deal.queryKey.startsWith('typo:') ? deal.queryKey.slice(5) : deal.queryKey
      const data = await api.comps(kw)
      if (data.median) {
        setComps((c) => ({ ...c, [deal.queryKey]: { median: data.median, n: data.n } }))
      } else if (data.manual) {
        if (data.upgrade) toast('Automated comps are a Picker feature — sold URL opened instead', { err: true })
        window.open(data.soldUrl, '_blank', 'noopener')
      }
    } finally {
      setCompsBusy(null)
    }
  }

  const manualComp = (deal, median) => {
    setComps((c) => ({ ...c, [deal.queryKey]: { median, n: 1 } }))
  }

  const uncompedKeys = useMemo(
    () => [...new Set((results || []).filter((d) => !d.margin).map((d) => d.queryKey))],
    [results],
  )

  const getCompsForAll = async () => {
    setBulkCompsBusy(true)
    const next = {}
    for (const key of uncompedKeys) {
      const kw = key.startsWith('typo:') ? key.slice(5) : key
      try {
        const data = await api.comps(kw)
        if (data.median) next[key] = { median: data.median, n: data.n }
      } catch {
        // one failure shouldn't stop the batch
      }
      await new Promise((r) => setTimeout(r, 250))
    }
    if (Object.keys(next).length) setComps((c) => ({ ...c, ...next })) // one update → one rescan
    setBulkCompsBusy(false)
  }

  const saveDeal = async (deal) => {
    try {
      await api.saveDeal({
        itemId: deal.itemId,
        title: deal.title,
        url: deal.url,
        buyPrice: deal.price,
        compMedian: deal.margin?.compMedian ?? null,
        estNet: deal.margin?.estNet ?? null,
      })
      setSaved((s) => new Set(s).add(deal.itemId))
      toast('Saved to pipeline')
    } catch {
      toast('Save failed — try again', { err: true })
    }
  }

  const dismiss = (itemId) => setDismissed((s) => new Set(s).add(itemId))

  // Re-scoring after comps land: cheapest correct path is re-running the scan
  // with the updated comps map (usually free — the scan cache still has it).
  const compsKey = useMemo(() => JSON.stringify(comps), [comps])
  useEffect(() => {
    if (results && results.length) scan()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compsKey])

  const saveAsWatch = async () => {
    setSavingWatch(true)
    try {
      const payload = buildPayload()
      const preset = PRESETS.find((p) => p.id === cfg.presetId)
      await api.createWatch({
        name: preset?.label || payload.queries[0] || 'custom loadout',
        config: {
          ...payload,
          minScore: 45,
          threshold: { minMarginPct, minNetUsd },
        },
      })
      toast('Watch created — it hunts on schedule now')
    } catch (e) {
      if (e instanceof ApiError && e.status === 402) {
        toast(e.message, { err: true })
        onGoSettings()
      } else {
        toast(`Watch failed: ${e.message}`, { err: true })
      }
    } finally {
      setSavingWatch(false)
    }
  }

  const presetLabel = PRESETS.find((p) => p.id === cfg.presetId)?.label
  const econBase = { ...DEFAULT_ECON, ...(me?.profile?.econ || {}) }
  const econ = { ...econBase, shipEstimate: Number(cfg.shipEstimate) || 15 }

  const visible = useMemo(() => {
    if (!results) return null
    let list = results.filter((d) => !dismissed.has(d.itemId))
    if (thresholdOn) list = list.filter((d) => clearsThreshold(d, { minMarginPct, minNetUsd }))
    return [...list].sort(SORTERS[sortBy])
  }, [results, dismissed, thresholdOn, minMarginPct, minNetUsd, sortBy])

  const exportSnipeList = () => {
    const rows = (visible || [])
      .filter((d) => d.margin)
      .map((d) => {
        const bid = maxJustifiedBid(d.margin.compMedian, econ, { minMarginPct, minNetUsd })
        const safeTitle = d.title.replace(/"/g, '""')
        return `${d.itemId},"${safeTitle}",${d.price},${bid ?? ''},${d.margin.compMedian},${d.url}`
      })
    const csv = ['item_id,title,current_price,max_bid,comp_median,url', ...rows].join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `blindspot-snipe-list-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <>
      {limitHit && (
        <div className="banner banner-warn">
          {limitHit}.{' '}
          <button className="banner-link" onClick={onGoSettings}>
            See plans →
          </button>
        </div>
      )}
      {degraded && (
        <div className="banner banner-warn">
          Deployment budget is running hot — some queries were served from cache or skipped. Fresh
          results return when the ledger resets at midnight UTC.
        </div>
      )}
      {errors.length > 0 && (
        <div className="banner banner-warn">
          {errors.length} quer{errors.length === 1 ? 'y' : 'ies'} failed: {errors[0]}
        </div>
      )}

      <main className="layout">
        <Loadout
          cfg={cfg}
          setCfg={setCfg}
          onScan={scan}
          scanning={scanning}
          open={loadoutOpen}
          onToggle={() => setLoadoutOpen((v) => !v)}
          presetLabel={presetLabel}
        />

        <section className="feed" aria-live="polite">
          {scanning && <div className="sweep" aria-hidden="true" />}

          {visible && visible.length > 0 && (
            <div className="feed-toolbar">
              <label className="toolbar-item">
                <span>Sort</span>
                <select className="input" value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
                  <option value="score">Score</option>
                  <option value="margin">Margin %</option>
                  <option value="net">Est. net $</option>
                  <option value="ending">Ending soonest</option>
                  <option value="price">Price low→high</option>
                </select>
              </label>

              <label className="check toolbar-item">
                <input type="checkbox" checked={thresholdOn} onChange={(e) => setThresholdOn(e.target.checked)} />
                <span>Only clears my bar</span>
              </label>
              {thresholdOn && (
                <span className="toolbar-item threshold-inputs">
                  ≥
                  <input className="input input-tiny" inputMode="numeric" value={minMarginPct} onChange={(e) => setMinMarginPct(Number(e.target.value) || 0)} />
                  % or $
                  <input className="input input-tiny" inputMode="numeric" value={minNetUsd} onChange={(e) => setMinNetUsd(Number(e.target.value) || 0)} />
                </span>
              )}

              {uncompedKeys.length > 0 && (
                <button className="btn-ghost toolbar-item" onClick={getCompsForAll} disabled={bulkCompsBusy}>
                  {bulkCompsBusy ? 'pulling…' : `Get comps for ${uncompedKeys.length} queries`}
                </button>
              )}

              {visible.some((d) => d.margin) && (
                <button className="btn-ghost toolbar-item" onClick={exportSnipeList}>
                  Export snipe list ({visible.filter((d) => d.margin).length})
                </button>
              )}

              <button
                className="btn-ghost toolbar-item"
                onClick={saveAsWatch}
                disabled={savingWatch}
                title={
                  watchSlots > 0
                    ? 'Run this loadout on a schedule with Discord alerts'
                    : 'Watches need a paid plan'
                }
              >
                {savingWatch ? 'saving…' : '→ Save as watch'}
              </button>

              {dismissed.size > 0 && (
                <button className="btn-ghost toolbar-item" onClick={() => setDismissed(new Set())}>
                  {dismissed.size} dismissed · reset
                </button>
              )}
            </div>
          )}

          {queryStats.length > 0 && (
            <details className="breakdown">
              <summary>Scan breakdown ({queryStats.length} queries)</summary>
              <div className="breakdown-list">
                {queryStats.map((q, i) => (
                  <span key={i} className={`breakdown-pill ${q.commonTerm ? 'breakdown-flag' : ''}`}>
                    {q.typoOrigin ? `typo "${q.query}"` : q.query} ·{' '}
                    {q.skipped ? `skipped (${q.skipped === true ? 'known term' : q.skipped})` : `${q.raw} hits`}
                    {q.cached ? ' · cached' : ''}
                    {q.commonTerm && !q.skipped ? ' · common term, typo bonus suppressed' : ''}
                  </span>
                ))}
              </div>
            </details>
          )}

          {!results && !scanning && (
            <div className="empty">
              <p className="empty-head">No scan yet.</p>
              <p>
                Pick a loadout, tune the filters, hit Scan (or press "S"). Typo hunt runs
                misspelled brand variants that regular searchers never see — and screens out real
                words that only look like typos, using every user's confirmed collisions.
              </p>
            </div>
          )}
          {results && results.length === 0 && !scanning && (
            <div className="empty">
              <p className="empty-head">Nothing cleared.</p>
              <p>No listings matched this loadout. Widen price, drop the ending-soon window, or add queries — don't lower your bar.</p>
            </div>
          )}
          {results && results.length > 0 && visible.length === 0 && !scanning && (
            <div className="empty">
              <p className="empty-head">Everything's hidden.</p>
              <p>
                {dismissed.size > 0 ? `All ${dismissed.size} results are dismissed. ` : ''}
                {thresholdOn ? 'Your margin bar may be filtering everything out — loosen it in the toolbar above.' : ''}
              </p>
            </div>
          )}

          <div className="stagger">
            {visible &&
              visible.map((deal, i) => (
                <DealCard
                  key={deal.itemId}
                  deal={deal}
                  rank={i + 1}
                  onGetComps={getComps}
                  onManualComp={manualComp}
                  compsBusy={compsBusy === deal.itemId}
                  onDismiss={dismiss}
                  onSave={saveDeal}
                  saved={saved.has(deal.itemId)}
                  dealsConfigured={true}
                  econ={econ}
                  minMarginPct={minMarginPct}
                  minNetUsd={minNetUsd}
                />
              ))}
          </div>
        </section>
      </main>

      <div className={`mobile-scanbar ${loadoutOpen ? 'drawer-open' : ''}`}>
        <span className="mobile-scanbar-label">{presetLabel || 'Custom loadout'}</span>
        <button onClick={scan} disabled={scanning}>{scanning ? '…' : 'Scan'}</button>
      </div>
    </>
  )
}
