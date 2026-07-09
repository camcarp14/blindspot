import { useEffect, useState } from 'react'
import { api, ApiError } from '../lib/api.js'
import { useToast, SkList, Expand } from './polish.jsx'

const rel = (ts) => {
  if (!ts) return 'never'
  const s = (Date.now() - new Date(ts).getTime()) / 1000
  if (s < 90) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

const CADENCES = [30, 60, 120, 360, 720, 1440]
const cadenceLabel = (m) => (m < 60 ? `${m} min` : m < 1440 ? `${m / 60}h` : 'daily')

const toForm = (w) => {
  const c = w?.config || {}
  return {
    name: w?.name || '',
    queries: (c.queries || []).join('\n'),
    typoBrands: (c.typoBrands || []).join(', '),
    typoHunt: c.typoHunt !== false,
    auctionOnly: c.auctionOnly !== false,
    fixable: !!c.fixable,
    maxPrice: c.maxPrice ?? '',
    endingWithinHours: c.endingWithinHours ?? '',
    minScore: c.minScore ?? 45,
    minMarginPct: c.threshold?.minMarginPct ?? 30,
    minNetUsd: c.threshold?.minNetUsd ?? 25,
    shipEstimate: c.econ?.shipEstimate ?? '',
    cadence: w?.cadence_minutes ?? 60,
    comps: c.comps || {},
  }
}

const toPayload = (f) => ({
  name: f.name || f.queries.split('\n')[0] || 'untitled watch',
  cadenceMinutes: Number(f.cadence) || 60,
  config: {
    queries: f.queries.split('\n').map((s) => s.trim()).filter(Boolean),
    typoBrands: f.typoBrands.split(',').map((s) => s.trim()).filter(Boolean),
    typoHunt: f.typoHunt,
    auctionOnly: f.auctionOnly,
    fixable: f.fixable,
    maxPrice: f.maxPrice || null,
    endingWithinHours: f.endingWithinHours || null,
    minScore: f.minScore,
    threshold: { minMarginPct: f.minMarginPct, minNetUsd: f.minNetUsd },
    econ: f.shipEstimate === '' ? {} : { shipEstimate: f.shipEstimate },
    comps: f.comps,
  },
})

export default function Watches({ onGoSettings }) {
  const toast = useToast()
  const [data, setData] = useState(null)
  const [editor, setEditor] = useState(null) // { id?, form }
  const [busy, setBusy] = useState(false)
  const [confirmDel, setConfirmDel] = useState(null)

  const load = () => api.watches().then(setData).catch(() => setData({ error: true }))
  useEffect(() => {
    load()
  }, [])

  if (!data) return <div className="view"><SkList n={3} /></div>
  if (data.error) {
    return (
      <div className="view pagefade">
        <div className="empty">
          <p className="empty-head">Couldn't load watches.</p>
          <button className="btn-ghost" onClick={() => { setData(null); load() }}>Retry</button>
        </div>
      </div>
    )
  }

  const { watches = [], hits = [], slots = { used: 0, max: 0 }, cadenceFloor = 60 } = data

  if (slots.max === 0) {
    return (
      <div className="view pagefade">
        <div className="empty">
          <p className="empty-head">Watches hunt while you sleep.</p>
          <p>
            A watch runs your loadout on a schedule and pings Discord the moment something clears
            your bar — zero-bid Takumars at 3am, decommissioned Catalysts on a Sunday. Scout
            doesn't include watch slots.
          </p>
          <button className="btn-ghost" onClick={onGoSettings}>See plans →</button>
        </div>
      </div>
    )
  }

  const save = async () => {
    setBusy(true)
    try {
      const payload = toPayload(editor.form)
      if (editor.id) await api.updateWatch(editor.id, payload)
      else await api.createWatch(payload)
      toast(editor.id ? 'Watch updated' : 'Watch created')
      setEditor(null)
      load()
    } catch (e) {
      if (e instanceof ApiError && e.status === 402) onGoSettings()
      toast(e.message, { err: true })
    } finally {
      setBusy(false)
    }
  }

  const toggle = async (w) => {
    try {
      await api.updateWatch(w.id, { enabled: !w.enabled })
      setData((d) => ({
        ...d,
        watches: d.watches.map((x) => (x.id === w.id ? { ...x, enabled: !w.enabled } : x)),
      }))
    } catch (e) {
      toast(e.message, { err: true })
    }
  }

  const remove = async (w) => {
    try {
      await api.deleteWatch(w.id)
      toast('Watch deleted')
      setConfirmDel(null)
      load()
    } catch (e) {
      toast(e.message, { err: true })
    }
  }

  const set = (key) => (e) =>
    setEditor((ed) => ({
      ...ed,
      form: { ...ed.form, [key]: e.target.type === 'checkbox' ? e.target.checked : e.target.value },
    }))

  const cadenceOptions = CADENCES.filter((c) => c >= (cadenceFloor || 30))

  return (
    <div className="view pagefade">
      <div className="view-head">
        <h2>Watches</h2>
        <span className="mono dim-note">
          {slots.used}/{slots.max} slots · runs every {cadenceLabel(cadenceFloor)} or slower
        </span>
        {!editor && slots.used < slots.max && (
          <button className="btn-ghost" onClick={() => setEditor({ id: null, form: toForm(null) })}>
            + New watch
          </button>
        )}
      </div>

      <Expand open={!!editor}>
        {editor && (
          <div className="editor">
            <div className="field-row">
              <label className="field field-half">
                <span>Name</span>
                <input className="input" value={editor.form.name} onChange={set('name')} placeholder="lenses-overnight" />
              </label>
              <label className="field field-half">
                <span>Cadence</span>
                <select className="input" value={editor.form.cadence} onChange={set('cadence')}>
                  {cadenceOptions.map((c) => (
                    <option key={c} value={c}>every {cadenceLabel(c)}</option>
                  ))}
                </select>
              </label>
            </div>
            <label className="field">
              <span>Queries — one per line</span>
              <textarea className="input" rows={4} value={editor.form.queries} onChange={set('queries')} />
            </label>
            <label className="field">
              <span>Typo-hunt brands — comma separated</span>
              <input className="input" value={editor.form.typoBrands} onChange={set('typoBrands')} />
            </label>
            <div className="field-row">
              <label className="check"><input type="checkbox" checked={editor.form.typoHunt} onChange={set('typoHunt')} /><span>Typo hunt</span></label>
              <label className="check"><input type="checkbox" checked={editor.form.auctionOnly} onChange={set('auctionOnly')} /><span>Auctions only</span></label>
              <label className="check"><input type="checkbox" checked={editor.form.fixable} onChange={set('fixable')} /><span>Fixable category</span></label>
            </div>
            <div className="field-row">
              <label className="field field-half"><span>Max price $</span><input className="input" inputMode="numeric" value={editor.form.maxPrice} onChange={set('maxPrice')} /></label>
              <label className="field field-half"><span>Ends within (h)</span><input className="input" inputMode="numeric" value={editor.form.endingWithinHours} onChange={set('endingWithinHours')} placeholder="any" /></label>
              <label className="field field-half"><span>Ship est $</span><input className="input" inputMode="numeric" value={editor.form.shipEstimate} onChange={set('shipEstimate')} placeholder="default" /></label>
            </div>
            <div className="field-row">
              <label className="field field-half"><span>Min score</span><input className="input" inputMode="numeric" value={editor.form.minScore} onChange={set('minScore')} /></label>
              <label className="field field-half"><span>Min margin %</span><input className="input" inputMode="numeric" value={editor.form.minMarginPct} onChange={set('minMarginPct')} /></label>
              <label className="field field-half"><span>Min net $</span><input className="input" inputMode="numeric" value={editor.form.minNetUsd} onChange={set('minNetUsd')} /></label>
            </div>
            {Object.keys(editor.form.comps).length > 0 && (
              <p className="dim-note mono">
                comps carried: {Object.entries(editor.form.comps).map(([k, v]) => `${k} → $${v.median}`).join(' · ')}
              </p>
            )}
            <div className="field-row">
              <button className="btn-ghost btn-ghost-active" onClick={save} disabled={busy}>
                {busy ? 'saving…' : editor.id ? 'Save changes' : 'Create watch'}
              </button>
              <button className="btn-ghost" onClick={() => setEditor(null)}>Cancel</button>
            </div>
          </div>
        )}
      </Expand>

      {watches.length === 0 && !editor && (
        <div className="empty">
          <p className="empty-head">No watches yet.</p>
          <p>
            Build a loadout on Scan and hit "→ Save as watch" — it carries your queries, filters,
            and comps straight in. Or start blank with "+ New watch" above.
          </p>
        </div>
      )}

      <div className="stagger">
        {watches.map((w) => (
          <article key={w.id} className={`card watch-card ${w.enabled ? '' : 'watch-off'}`}>
            <div className="card-main">
              <div className="watch-head">
                <label className="check" title={w.enabled ? 'Running' : 'Paused'}>
                  <input type="checkbox" checked={w.enabled} onChange={() => toggle(w)} />
                </label>
                <span className="watch-name">{w.name}</span>
                <span className="mono dim-note">every {cadenceLabel(w.cadence_minutes)}</span>
              </div>
              <div className="card-signals">
                {(w.config?.queries || []).map((q) => (
                  <span key={q} className="chip chip-muted">{q}</span>
                ))}
                {w.config?.typoHunt &&
                  (w.config?.typoBrands || []).map((b) => (
                    <span key={b} className="chip">typo: {b}</span>
                  ))}
              </div>
              <div className="card-stats">
                <span className="stat mono">ran {rel(w.last_run_at)}</span>
                <span className="stat mono">last catch {rel(w.last_hit_at)}</span>
                {w.config?.maxPrice && <span className="stat">≤ ${w.config.maxPrice}</span>}
                {w.config?.threshold && (
                  <span className="stat">
                    bar ≥{w.config.threshold.minMarginPct}% / ${w.config.threshold.minNetUsd}
                  </span>
                )}
              </div>
              <div className="card-actions">
                <button className="btn-ghost" onClick={() => setEditor({ id: w.id, form: toForm(w) })}>Edit</button>
                {confirmDel === w.id ? (
                  <>
                    <button className="btn-ghost btn-danger" onClick={() => remove(w)}>Confirm delete</button>
                    <button className="btn-ghost" onClick={() => setConfirmDel(null)}>Keep</button>
                  </>
                ) : (
                  <button className="btn-ghost" onClick={() => setConfirmDel(w.id)}>Delete</button>
                )}
              </div>
            </div>
          </article>
        ))}
      </div>

      {hits.length > 0 && (
        <details className="breakdown" open>
          <summary>Recent catches ({hits.length})</summary>
          <div className="hit-list">
            {hits.map((h) => (
              <a
                key={`${h.watch_id}-${h.item_id}`}
                className="hit-row"
                href={`https://www.ebay.com/itm/${(h.item_id || '').split('|')[1] || h.item_id}`}
                target="_blank"
                rel="noreferrer"
              >
                <span className="mono hit-score">{h.score}</span>
                <span className="hit-title">{h.title}</span>
                <span className="mono dim-note">{rel(h.seen_at)}</span>
              </a>
            ))}
          </div>
        </details>
      )}
    </div>
  )
}
