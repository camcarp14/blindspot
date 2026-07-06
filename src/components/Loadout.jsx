import { useState } from 'react'
import { PRESETS } from '../lib/presets.js'
import { api } from '../lib/api.js'

export default function Loadout({ cfg, setCfg, onScan, scanning }) {
  const [catQuery, setCatQuery] = useState('')
  const [catResults, setCatResults] = useState(null)
  const [catBusy, setCatBusy] = useState(false)

  const loadPreset = (p) => {
    setCfg((c) => ({
      ...c,
      presetId: p.id,
      queries: p.queries.join('\n'),
      typoBrands: p.typoBrands.join(', '),
      conditionIds: p.conditionIds,
      auctionOnly: p.auctionOnly,
      fixable: p.fixable,
      expectModelNumbers: p.expectModelNumbers,
      shipEstimate: p.shipEstimate,
      maxPrice: p.maxPrice,
      categoryIds: '',
    }))
  }

  const lookupCategory = async () => {
    if (!catQuery.trim()) return
    setCatBusy(true)
    try {
      const data = await api.taxonomy(catQuery.trim())
      setCatResults(data.suggestions || [])
    } catch {
      setCatResults([])
    } finally {
      setCatBusy(false)
    }
  }

  const set = (key) => (e) =>
    setCfg((c) => ({
      ...c,
      [key]: e.target.type === 'checkbox' ? e.target.checked : e.target.value,
    }))

  return (
    <aside className="loadout">
      <h2 className="rail-head">Loadout</h2>

      <div className="preset-grid">
        {PRESETS.map((p) => (
          <button
            key={p.id}
            className={`preset ${cfg.presetId === p.id ? 'preset-active' : ''}`}
            onClick={() => loadPreset(p)}
            title={p.blurb}
          >
            {p.label}
          </button>
        ))}
      </div>
      {cfg.presetId && (
        <p className="preset-blurb">{PRESETS.find((p) => p.id === cfg.presetId)?.blurb}</p>
      )}

      <label className="field">
        <span>Queries — one per line</span>
        <textarea
          className="input"
          rows={5}
          value={cfg.queries}
          onChange={set('queries')}
          placeholder={'canon fd 50mm 1.2\nmarantz receiver'}
        />
      </label>

      <label className="field">
        <span>Typo-hunt brands — comma separated</span>
        <input
          className="input"
          value={cfg.typoBrands}
          onChange={set('typoBrands')}
          placeholder="takumar, marantz"
        />
      </label>

      <div className="field-row">
        <label className="check">
          <input type="checkbox" checked={cfg.typoHunt} onChange={set('typoHunt')} />
          <span>Typo hunt</span>
        </label>
        <label className="check">
          <input type="checkbox" checked={cfg.auctionOnly} onChange={set('auctionOnly')} />
          <span>Auctions only</span>
        </label>
        <label className="check">
          <input type="checkbox" checked={cfg.fixable} onChange={set('fixable')} />
          <span>Fixable category</span>
        </label>
      </div>

      <div className="field-row">
        <label className="field field-half">
          <span>Max price $</span>
          <input className="input" inputMode="numeric" value={cfg.maxPrice ?? ''} onChange={set('maxPrice')} />
        </label>
        <label className="field field-half">
          <span>Ends within (h)</span>
          <input className="input" inputMode="numeric" value={cfg.endingWithinHours ?? ''} onChange={set('endingWithinHours')} placeholder="any" />
        </label>
      </div>

      <div className="field-row">
        <label className="field field-half">
          <span>Ship est $</span>
          <input className="input" inputMode="numeric" value={cfg.shipEstimate ?? ''} onChange={set('shipEstimate')} />
        </label>
        <label className="field field-half">
          <span>Category IDs</span>
          <input className="input" value={cfg.categoryIds} onChange={set('categoryIds')} placeholder="optional" />
        </label>
      </div>

      <details className="cat-lookup">
        <summary>Find category ID</summary>
        <div className="field-row">
          <input
            className="input"
            value={catQuery}
            onChange={(e) => setCatQuery(e.target.value)}
            placeholder="e.g. camera lenses"
          />
          <button className="btn-ghost" onClick={lookupCategory} disabled={catBusy}>
            {catBusy ? '…' : 'Look up'}
          </button>
        </div>
        {catResults && (
          <ul className="cat-results">
            {catResults.length === 0 && <li className="dim-note">No matches.</li>}
            {catResults.map((c) => (
              <li key={c.categoryId}>
                <button
                  className="cat-pick"
                  onClick={() =>
                    setCfg((s) => ({
                      ...s,
                      categoryIds: s.categoryIds
                        ? `${s.categoryIds},${c.categoryId}`
                        : c.categoryId,
                    }))
                  }
                >
                  <span className="mono">{c.categoryId}</span> {c.name}
                  <span className="cat-path">{c.path}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </details>

      <button className="btn-scan" onClick={onScan} disabled={scanning}>
        {scanning ? 'Scanning…' : 'Scan'}
      </button>
    </aside>
  )
}
