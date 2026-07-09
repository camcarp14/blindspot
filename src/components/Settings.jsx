import { useEffect, useState } from 'react'
import { api } from '../lib/api.js'
import { auth } from '../lib/supabase.js'
import { PLANS } from '../lib/plans.js'
import { useToast, SkList, Num } from './polish.jsx'

// Settings — everything that was a deployment env var in v1 but is really a
// per-seller fact: fee economics, the Discord webhook, typo excludes. Plus the
// plan card, because the plan IS a setting here: it's your slice of the
// deployment's 5,000 calls.

function Meter({ label, used, cap, warnAt = 0.8 }) {
  const pct = cap ? Math.min(100, Math.round((used / cap) * 100)) : 0
  return (
    <div className="meter">
      <div className="meter-head">
        <span>{label}</span>
        <span className="mono">
          <Num v={used} />/{cap}
        </span>
      </div>
      <div className="meter-track">
        <div
          className={`meter-fill ${used / (cap || 1) > warnAt ? 'meter-hot' : ''}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}

export default function Settings({ me, refreshMe }) {
  const toast = useToast()
  const [billing, setBilling] = useState(null)
  const [form, setForm] = useState(null)
  const [busy, setBusy] = useState(false)
  const [checkoutBusy, setCheckoutBusy] = useState(null)

  useEffect(() => {
    api.billing().then(setBilling).catch(() => setBilling({ configured: false }))
  }, [])

  useEffect(() => {
    if (me?.profile && !form) {
      setForm({
        feeRatePct: (me.profile.econ.feeRate * 100).toFixed(2),
        perOrderFee: String(me.profile.econ.perOrderFee),
        discordWebhookUrl: me.profile.discordWebhookUrl,
        typoExclude: (me.profile.typoExclude || []).join(', '),
      })
    }
  }, [me, form])

  if (!me || !form) return <div className="view"><SkList n={3} /></div>

  const { profile, usage, budget } = me
  const plan = PLANS[profile.plan] || PLANS.scout

  const saveSettings = async () => {
    setBusy(true)
    try {
      await api.saveSettings({
        econ: {
          feeRate: Number(form.feeRatePct) / 100,
          perOrderFee: Number(form.perOrderFee),
        },
        discordWebhookUrl: form.discordWebhookUrl,
        typoExclude: form.typoExclude.split(',').map((s) => s.trim()).filter(Boolean),
      })
      toast('Settings saved')
      refreshMe()
    } catch (e) {
      toast(e.message, { err: true })
    } finally {
      setBusy(false)
    }
  }

  const upgrade = async (planId) => {
    setCheckoutBusy(planId)
    try {
      const { url } = await api.checkout(planId)
      window.location.href = url
    } catch (e) {
      toast(e.message, { err: true })
      setCheckoutBusy(null)
    }
  }

  const openPortal = async () => {
    try {
      const { url } = await api.portal()
      window.location.href = url
    } catch (e) {
      toast(e.message, { err: true })
    }
  }

  const testWebhook = async () => {
    try {
      const r = await api.testWebhook(form.discordWebhookUrl)
      toast(r.ok ? 'Test sent — check the channel' : r.error || 'Test failed', { err: !r.ok })
    } catch (e) {
      toast(e.message, { err: true })
    }
  }

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }))

  return (
    <div className="view pagefade">
      <div className="view-head">
        <h2>Settings</h2>
        <span className="mono dim-note">{profile.email}</span>
        <button className="btn-ghost" onClick={() => auth.signOut()}>Sign out</button>
      </div>

      <div className="settings-grid stagger">
        <section className="panel">
          <h3>Plan & usage</h3>
          <Meter label="scans today" used={usage.scans} cap={usage.scansLimit} />
          <Meter
            label="deployment pool · interactive"
            used={budget.pools.interactive.used}
            cap={budget.pools.interactive.cap}
          />
          <Meter
            label="deployment pool · watches"
            used={budget.pools.watch.used}
            cap={budget.pools.watch.cap}
          />
          <p className="dim-note">
            Every tenant shares eBay's {budget.quota.toLocaleString()}-call/day ceiling. Scans hit a
            shared 10-minute cache first, so overlapping loadouts are free — the meters above are
            the honest remainder.
          </p>

          <div className="plan-grid">
            {Object.values(PLANS).map((p) => (
              <div key={p.id} className={`plan-card ${p.id === plan.id ? 'plan-current' : ''}`}>
                <div className="gate-plan-head">
                  <span className="gate-plan-name">{p.label}</span>
                  <span className="gate-plan-price mono">{p.price ? `$${p.price}/mo` : 'free'}</span>
                </div>
                <p className="mono dim-note">
                  {p.scansPerDay} scans/day
                  {p.watchSlots ? ` · ${p.watchSlots} watches @ ${p.cadenceMinutes}min` : ' · manual comps'}
                  {p.alerts ? ' · alerts' : ''}
                </p>
                {p.id === plan.id ? (
                  <span className="chip">current plan</span>
                ) : p.price > plan.price ? (
                  billing?.configured ? (
                    <button
                      className="btn-ghost btn-ghost-active"
                      onClick={() => upgrade(p.id)}
                      disabled={checkoutBusy === p.id}
                    >
                      {checkoutBusy === p.id ? 'opening…' : `Upgrade to ${p.label}`}
                    </button>
                  ) : (
                    <span className="dim-note">billing not configured on this deployment</span>
                  )
                ) : null}
              </div>
            ))}
          </div>
          {billing?.subscription && (
            <button className="btn-ghost" onClick={openPortal}>
              Manage billing → invoices, card, cancel
            </button>
          )}
        </section>

        <section className="panel">
          <h3>Seller economics</h3>
          <p className="dim-note">
            Used in every margin calc and ceiling bid. Verify yours in Seller Hub — final value
            fees vary by category and store level.
          </p>
          <div className="field-row">
            <label className="field field-half">
              <span>Final value fee %</span>
              <input className="input" inputMode="decimal" value={form.feeRatePct} onChange={set('feeRatePct')} />
            </label>
            <label className="field field-half">
              <span>Per-order fee $</span>
              <input className="input" inputMode="decimal" value={form.perOrderFee} onChange={set('perOrderFee')} />
            </label>
          </div>

          <h3>Discord alerts</h3>
          <p className="dim-note">
            Watches post fresh catches here. Channel settings → Integrations → Webhooks → copy URL.
          </p>
          <label className="field">
            <span>Webhook URL</span>
            <input
              className="input"
              value={form.discordWebhookUrl}
              onChange={set('discordWebhookUrl')}
              placeholder="https://discord.com/api/webhooks/…"
            />
          </label>
          {form.discordWebhookUrl && (
            <button className="btn-ghost" onClick={testWebhook}>Send test message</button>
          )}

          <h3>Typo excludes</h3>
          <p className="dim-note">
            Real words that only look like typos ("nikor"). Yours stack on the community list —
            every user's confirmed collisions already protect you.
          </p>
          <label className="field">
            <span>Comma separated</span>
            <input className="input" value={form.typoExclude} onChange={set('typoExclude')} />
          </label>

          <button className="btn-ghost btn-ghost-active" onClick={saveSettings} disabled={busy}>
            {busy ? 'saving…' : 'Save settings'}
          </button>
        </section>
      </div>
    </div>
  )
}
