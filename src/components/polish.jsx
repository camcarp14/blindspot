// Polish primitives — one motion system for every state change, matching the
// bench-instrument aesthetic. Pairs with the "polish system" block in styles.css.
import { useState, useEffect, useRef, useMemo, createContext, useContext } from 'react'

// ---- numbers behave like instruments: they count to their value ----
export function useTween(target, dur = 600) {
  const [v, setV] = useState(target ?? 0)
  const fromRef = useRef(target ?? 0)
  useEffect(() => {
    if (target == null) return
    const from = fromRef.current ?? 0
    if (from === target) {
      setV(target)
      return
    }
    let raf
    const t0 = performance.now()
    const step = (now) => {
      const p = Math.min(1, (now - t0) / dur)
      setV(from + (target - from) * (1 - Math.pow(1 - p, 3)))
      if (p < 1) raf = requestAnimationFrame(step)
      else fromRef.current = target
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [target, dur])
  return target == null ? null : Math.round(v)
}

export function Num({ v, f = (x) => x.toLocaleString('en-US'), dur }) {
  const shown = useTween(typeof v === 'number' ? v : null, dur)
  return shown == null ? <>—</> : <>{f(shown)}</>
}

// ---- skeletons: pages develop instead of arriving ----
export const SkLine = ({ w }) => <div className={`sk sk-line${w ? ` ${w}` : ''}`} />
export const SkRow = () => (
  <div className="card">
    <div style={{ flex: 1 }}>
      <SkLine w="w60" />
      <SkLine w="w80" />
      <SkLine w="w40" />
    </div>
  </div>
)
export const SkList = ({ n = 4 }) => (
  <div className="pagefade">
    {Array.from({ length: n }).map((_, i) => (
      <SkRow key={i} />
    ))}
  </div>
)

// ---- height:auto expansion, zero measuring, zero jank ----
export function Expand({ open, children }) {
  return (
    <div className={`expand${open ? ' open' : ''}`} aria-hidden={!open}>
      <div>{open ? children : null}</div>
    </div>
  )
}

// ---- toasts: spring in, fade out, never shift layout ----
const ToastCtx = createContext(null)
export function ToastProvider({ children }) {
  const [items, setItems] = useState([])
  const push = (msg, opts = {}) => {
    const id = Math.random().toString(36).slice(2)
    setItems((xs) => [...xs, { id, msg, err: !!opts.err }])
    setTimeout(() => setItems((xs) => xs.map((x) => (x.id === id ? { ...x, out: true } : x))), opts.ms || 2600)
    setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), (opts.ms || 2600) + 260)
  }
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast${t.err ? ' err' : ''}${t.out ? ' out' : ''}`}>
            <span className="tdot" />
            {t.msg}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  )
}
export const useToast = () => useContext(ToastCtx) || (() => {})

// ---- ⌘K command palette — view nav + actions, no router needed ----
export function CommandK({ items = [] }) {
  // items: [{ id, label, hint, run }]
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [i, setI] = useState(0)
  const inputRef = useRef(null)
  const shown = useMemo(() => {
    const n = q.trim().toLowerCase()
    return n ? items.filter((x) => x.label.toLowerCase().includes(n) || (x.hint || '').toLowerCase().includes(n)) : items
  }, [q, items])
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen((o) => !o)
        setQ('')
        setI(0)
      } else if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 10)
  }, [open])
  useEffect(() => {
    document.body.style.overflow = open ? 'hidden' : ''
    return () => {
      document.body.style.overflow = ''
    }
  }, [open])
  useEffect(() => setI(0), [q])
  if (!open) return null
  const go = (item) => {
    setOpen(false)
    item.run()
  }
  return (
    <div className="cmdk-wrap" onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}>
      <div className="cmdk" role="dialog" aria-label="Command palette">
        <input
          ref={inputRef}
          value={q}
          placeholder="Jump to…"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setI((x) => Math.min(x + 1, shown.length - 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setI((x) => Math.max(x - 1, 0))
            } else if (e.key === 'Enter' && shown[i]) go(shown[i])
          }}
        />
        <div className="list">
          {shown.map((item, idx) => (
            <div
              key={item.id}
              className={`item${idx === i ? ' on' : ''}`}
              onMouseEnter={() => setI(idx)}
              onMouseDown={(e) => {
                e.preventDefault()
                go(item)
              }}
            >
              <span>{item.label}</span>
              {item.hint && <span className="cmdk-hint">{item.hint}</span>}
            </div>
          ))}
          {shown.length === 0 && <div className="item">Nothing matches “{q}”</div>}
        </div>
      </div>
    </div>
  )
}
