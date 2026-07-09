import { Component, useEffect, useState } from 'react'
import { auth, authConfigured } from './lib/supabase.js'
import { api } from './lib/api.js'
import AuthGate from './components/AuthGate.jsx'
import ScanView from './components/ScanView.jsx'
import Watches from './components/Watches.jsx'
import Pipeline from './components/Pipeline.jsx'
import Settings from './components/Settings.jsx'
import Admin from './components/Admin.jsx'
import { ToastProvider, CommandK, useToast, Num } from './components/polish.jsx'
import { PLANS } from './lib/plans.js'

const VIEWS = ['scan', 'watches', 'pipeline', 'settings']

// A crashed view must never take the shell down with it. Keyed by view so
// switching tabs gives the next view a clean boundary.
class ViewBoundary extends Component {
  state = { err: null }
  static getDerivedStateFromError(err) {
    return { err }
  }
  render() {
    if (!this.state.err) return this.props.children
    return (
      <div className="view pagefade">
        <div className="empty">
          <p className="empty-head">This view hit a snag.</p>
          <p className="mono dim-note">{String(this.state.err?.message || this.state.err)}</p>
          <button className="btn-ghost" onClick={() => this.setState({ err: null })}>
            Retry
          </button>
        </div>
      </div>
    )
  }
}

function Shell() {
  const toast = useToast()
  const [boot, setBoot] = useState('booting') // booting | out | in
  const [view, setView] = useState('scan')
  const [me, setMe] = useState(null)
  const [tokenState, setTokenState] = useState('checking')

  useEffect(() => {
    auth.init().then((s) => setBoot(s ? 'in' : 'out'))
    return auth.subscribe((s) => setBoot(s ? 'in' : 'out'))
  }, [])

  useEffect(() => {
    api
      .health()
      .then((h) => setTokenState(h.ok ? 'live' : 'error'))
      .catch(() => setTokenState('error'))
  }, [])

  const refreshMe = () => api.me().then(setMe).catch(() => {})

  useEffect(() => {
    if (boot !== 'in') {
      setMe(null)
      return
    }
    refreshMe()
    // Back from Stripe? Say so, then clean the URL.
    const params = new URLSearchParams(window.location.search)
    const billing = params.get('billing')
    if (billing) {
      if (billing === 'success') {
        toast('Plan upgraded — welcome to the bigger loadout')
        setView('settings')
        // Stripe's webhook may land a beat after the redirect; check twice.
        setTimeout(refreshMe, 2500)
      } else {
        toast('Checkout cancelled', { err: true })
      }
      history.replaceState(null, '', window.location.pathname)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boot])

  // Scan responses carry fresh usage/budget — cheaper than refetching /api/me.
  const onUsage = (usage, budget) =>
    setMe((m) => (m ? { ...m, usage: usage || m.usage, budget: budget || m.budget } : m))

  if (!authConfigured) {
    return (
      <div className="shell">
        <div className="banner">
          Supabase is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY (plus the
          server vars in .env.example), run supabase-schema.sql, and rebuild. The README walks
          through it.
        </div>
      </div>
    )
  }

  if (boot === 'booting') return <div className="shell" />
  if (boot === 'out') return <AuthGate />

  const plan = PLANS[me?.profile?.plan] || PLANS.scout
  const isAdmin = !!me?.profile?.isAdmin
  const usage = me?.usage
  const pool = me?.budget?.pools?.interactive

  const navItems = [
    ...VIEWS.map((v) => ({
      id: v,
      label: { scan: 'Go to Scan', watches: 'Go to Watches', pipeline: 'Go to Pipeline', settings: 'Go to Settings' }[v],
      hint: 'view',
      run: () => setView(v),
    })),
    ...(isAdmin ? [{ id: 'admin', label: 'Go to Deployment console', hint: 'admin', run: () => setView('admin') }] : []),
    {
      id: 'scan-now',
      label: 'Scan now',
      hint: 'S',
      run: () => {
        setView('scan')
        setTimeout(() => window.dispatchEvent(new Event('blindspot:scan')), 50)
      },
    },
    { id: 'sign-out', label: 'Sign out', hint: me?.profile?.email || '', run: () => auth.signOut() },
  ]

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">◎</span>
          <h1>Blindspot</h1>
          <span className="brand-sub">the market's blind spot, ranked</span>
        </div>

        <nav className="tabs" aria-label="Views">
          {VIEWS.map((v) => (
            <button key={v} className={view === v ? 'on' : ''} onClick={() => setView(v)}>
              {v}
            </button>
          ))}
          {isAdmin && (
            <button className={view === 'admin' ? 'on' : ''} onClick={() => setView('admin')}>
              deploy
            </button>
          )}
        </nav>

        <div className="statusbar mono">
          <span className={`led led-${tokenState}`} />
          <span className="chip chip-plan">{plan.label}</span>
          {usage && (
            <span className={usage.scans >= usage.scansLimit ? 'budget-warn' : ''}>
              <Num v={usage.scans} />/{usage.scansLimit} scans
            </span>
          )}
          {pool && (
            <>
              <span className="sep">·</span>
              <span
                className={pool.used > pool.cap * 0.8 ? 'budget-warn' : ''}
                title="Deployment-wide interactive pool (all users share eBay's daily quota)"
              >
                pool <Num v={pool.used} />/{pool.cap}
              </span>
            </>
          )}
          <span className="sep">·</span>
          <span className="kbd-hint"><kbd>⌘K</kbd></span>
        </div>
      </header>

      {tokenState === 'error' && (
        <div className="banner">
          eBay credentials failed on the server. Set EBAY_CLIENT_ID and EBAY_CLIENT_SECRET in the
          deployment environment, then redeploy.
        </div>
      )}

      <div key={view} className="pagefade view-wrap">
        <ViewBoundary>
          {view === 'scan' && (
            <ScanView
              me={me}
              onUsage={onUsage}
              onGoSettings={() => setView('settings')}
              watchSlots={plan.watchSlots}
            />
          )}
          {view === 'watches' && <Watches onGoSettings={() => setView('settings')} />}
          {view === 'pipeline' && <Pipeline me={me} />}
          {view === 'settings' && <Settings me={me} refreshMe={refreshMe} />}
          {view === 'admin' && isAdmin && <Admin />}
        </ViewBoundary>
      </div>

      <footer className="foot">
        Scanner + alerts only — bids are placed by you, on eBay. Press "S" to scan, ⌘K to jump.
      </footer>

      <CommandK items={navItems} />
    </div>
  )
}

export default function App() {
  return (
    <ToastProvider>
      <Shell />
    </ToastProvider>
  )
}
