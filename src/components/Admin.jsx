import { useEffect, useState } from 'react'
import { api } from '../lib/api.js'
import { useToast, SkList, Num } from './polish.jsx'

// The deployment console. One number matters here: how much of the shared
// 5,000-call ceiling is spoken for, and how much the dedupe is saving.

function Bar({ label, used, cap }) {
  const pct = cap ? Math.min(100, Math.round((used / cap) * 100)) : 0
  return (
    <div className="meter">
      <div className="meter-head">
        <span>{label}</span>
        <span className="mono"><Num v={used} />/{cap} · {pct}%</span>
      </div>
      <div className="meter-track">
        <div className={`meter-fill ${pct > 80 ? 'meter-hot' : ''}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

export default function Admin() {
  const toast = useToast()
  const [data, setData] = useState(null)
  const [failed, setFailed] = useState(false)

  const load = () => api.admin().then(setData).catch(() => setFailed(true))
  useEffect(() => {
    load()
  }, [])

  if (failed) {
    return (
      <div className="view pagefade">
        <div className="empty">
          <p className="empty-head">Couldn't load the console.</p>
          <button className="btn-ghost" onClick={() => { setFailed(false); load() }}>Retry</button>
        </div>
      </div>
    )
  }
  if (!data) return <div className="view"><SkList n={3} /></div>

  const {
    quota = 5000,
    budget = { pools: { interactive: { used: 0, cap: 0 }, watch: { used: 0, cap: 0 } } },
    users = [],
    planCounts = {},
    watchCapacity = { pool: 0, naiveCostPerDay: 0, dedupedCostPerDay: 0, uniqueQueries: 0 },
    collisions = [],
  } = data
  const dividend = watchCapacity.naiveCostPerDay - watchCapacity.dedupedCostPerDay

  const dropCollision = async (term) => {
    try {
      await api.deleteCollision(term)
      setData((d) => ({ ...d, collisions: d.collisions.filter((c) => c.term !== term) }))
      toast(`"${term}" removed — it'll be typo-hunted again`)
    } catch (e) {
      toast(e.message, { err: true })
    }
  }

  return (
    <div className="view pagefade">
      <div className="view-head">
        <h2>Deployment</h2>
        <span className="mono dim-note">{quota.toLocaleString()} Browse calls/day, shared by everyone</span>
      </div>

      <div className="settings-grid stagger">
        <section className="panel">
          <h3>Today's ledger</h3>
          <Bar label="interactive scans" used={budget.pools.interactive.used} cap={budget.pools.interactive.cap} />
          <Bar label="watch scheduler" used={budget.pools.watch.used} cap={budget.pools.watch.cap} />
          <p className="dim-note mono">
            reserve: {quota - budget.pools.interactive.cap - budget.pools.watch.cap} calls held back
          </p>

          <h3>Watch capacity</h3>
          <p className="dim-note">
            Enabled watches want <strong className="mono">{watchCapacity.naiveCostPerDay}</strong> calls/day
            naively; after cross-user dedupe they cost{' '}
            <strong className="mono">{watchCapacity.dedupedCostPerDay}</strong> across{' '}
            {watchCapacity.uniqueQueries} unique queries — the overlap dividend is{' '}
            <strong className="mono">{dividend}</strong> calls/day. Pool holds {watchCapacity.pool}.
          </p>
          {watchCapacity.dedupedCostPerDay > watchCapacity.pool && (
            <div className="banner banner-warn">
              Deduped demand exceeds the watch pool — the scheduler is stretching cadences.
              Time to request a higher eBay quota or gate new watch slots.
            </div>
          )}

          <h3>Plans</h3>
          <div className="card-signals">
            {Object.entries(planCounts).map(([p, n]) => (
              <span key={p} className="chip">{p}: {n}</span>
            ))}
          </div>
        </section>

        <section className="panel">
          <h3>Users ({users.length})</h3>
          <div className="admin-table">
            <div className="admin-row admin-head mono">
              <span>email</span><span>plan</span><span>scans</span><span>calls</span><span>watches</span>
            </div>
            {users.map((u) => (
              <div key={u.id} className="admin-row mono">
                <span title={u.email}>{u.email}{u.isAdmin ? ' ◎' : ''}</span>
                <span>{u.plan}</span>
                <span>{u.scansToday}</span>
                <span>{u.callsToday}</span>
                <span>{u.watches}</span>
              </div>
            ))}
          </div>

          <h3>Learned typo collisions ({collisions.length})</h3>
          <p className="dim-note">
            Auto-confirmed real words the typo hunter now skips for everyone. Prune anything that's
            actually a typo after all.
          </p>
          <div className="card-signals">
            {collisions.map((c) => (
              <span key={c.term} className="chip chip-muted collision-chip">
                {c.term}
                {c.brand ? ` ← ${c.brand}` : ''}
                <button
                  className="collision-x"
                  title="Remove — hunt this spelling again"
                  onClick={() => dropCollision(c.term)}
                >
                  ×
                </button>
              </span>
            ))}
            {collisions.length === 0 && <span className="dim-note">none learned yet</span>}
          </div>
        </section>
      </div>
    </div>
  )
}
