import { useState } from 'react'
import { auth } from '../lib/supabase.js'
import { PLANS } from '../lib/plans.js'

// Landing + sign-in. The pitch is the product's actual point of view, not
// SaaS copy: signals stack, margin math against real comps, and the bid stays
// in your hands.
export default function AuthGate() {
  const [mode, setMode] = useState('signin') // signin | signup | magic
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)

  const submit = async (e) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      if (mode === 'magic') {
        await auth.magicLink(email.trim())
        setNotice('Link sent — check your email and click it on this device.')
      } else if (mode === 'signup') {
        const r = await auth.signUp(email.trim(), password)
        if (r.needsConfirm) setNotice('Account created — confirm via the email we just sent, then sign in.')
        // else: session live, App re-renders past the gate
      } else {
        await auth.signIn(email.trim(), password)
      }
    } catch (err) {
      setError(String(err.message))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="gate pagefade">
      <div className="gate-pitch">
        <div className="gate-brand">
          <span className="brand-mark" aria-hidden="true">◎</span>
          <h1>Blindspot</h1>
        </div>
        <p className="gate-tag">the market's blind spot, ranked</p>
        <ul className="gate-points stagger">
          <li>
            <strong>Signal-stack scoring.</strong> Zero-bid auctions ending soon, misspelled brands
            no search ever finds, estate sellers who don't know what they're holding.
          </li>
          <li>
            <strong>Margin math, not vibes.</strong> Every find ranked against sold comps — net of
            fees and shipping, with the ceiling bid that still clears your bar.
          </li>
          <li>
            <strong>Watches that hunt while you sleep.</strong> Scheduled scans with Discord alerts
            the moment something clears your threshold.
          </li>
          <li>
            <strong>You place every bid.</strong> Scanner and alerts only — no bid automation,
            ever. The handoff is the point: your account, your judgment, your catch.
          </li>
        </ul>

        <div className="gate-plans stagger">
          {Object.values(PLANS).map((p) => (
            <div key={p.id} className="gate-plan">
              <div className="gate-plan-head">
                <span className="gate-plan-name">{p.label}</span>
                <span className="gate-plan-price mono">{p.price ? `$${p.price}/mo` : 'free'}</span>
              </div>
              <p>{p.blurb}</p>
              <p className="mono dim-note">
                {p.scansPerDay} scans/day
                {p.watchSlots ? ` · ${p.watchSlots} watches @ ${p.cadenceMinutes}min` : ' · manual comps'}
                {p.alerts ? ' · alerts' : ''}
              </p>
            </div>
          ))}
        </div>
      </div>

      <form className="gate-card" onSubmit={submit}>
        <div className="gate-tabs" role="tablist">
          <button
            type="button"
            className={mode !== 'signup' ? 'on' : ''}
            onClick={() => setMode('signin')}
            role="tab"
            aria-selected={mode !== 'signup'}
          >
            Sign in
          </button>
          <button
            type="button"
            className={mode === 'signup' ? 'on' : ''}
            onClick={() => setMode('signup')}
            role="tab"
            aria-selected={mode === 'signup'}
          >
            Create account
          </button>
        </div>

        <label className="field">
          <span>Email</span>
          <input
            className="input"
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@bench.local"
          />
        </label>

        {mode !== 'magic' && (
          <label className="field">
            <span>Password</span>
            <input
              className="input"
              type="password"
              required
              minLength={8}
              autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="min 8 characters"
            />
          </label>
        )}

        {error && <div className="gate-error">{error}</div>}
        {notice && <div className="gate-notice">{notice}</div>}

        <button className="btn-scan" disabled={busy}>
          {busy ? '…' : mode === 'signup' ? 'Create account' : mode === 'magic' ? 'Email me a link' : 'Sign in'}
        </button>

        <button
          type="button"
          className="gate-alt"
          onClick={() => {
            setMode((m) => (m === 'magic' ? 'signin' : 'magic'))
            setError(null)
            setNotice(null)
          }}
        >
          {mode === 'magic' ? 'Use a password instead' : 'Email me a sign-in link instead'}
        </button>

        <p className="gate-fine">
          Free plan, no card. Upgrade when the watches should hunt for you.
        </p>
      </form>
    </div>
  )
}
