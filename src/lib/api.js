import { auth } from './supabase.js'

// Typed errors so the UI can tell "upgrade" (402) from "budget gone" (429)
// from "signed out" (401) without string-matching.
export class ApiError extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

async function request(path, opts = {}) {
  const token = await auth.getToken()
  const doFetch = (tok) =>
    fetch(path, {
      ...opts,
      headers: {
        'Content-Type': 'application/json',
        ...(tok ? { Authorization: `Bearer ${tok}` } : {}),
        ...(opts.headers || {}),
      },
    })

  let res = await doFetch(token)
  if (res.status === 401 && token) {
    // Server disagreed about token freshness — one forced refresh, one retry.
    const next = await auth.forceRefresh()
    if (next?.access_token) res = await doFetch(next.access_token)
  }
  const text = await res.text()
  let data = null
  try {
    data = text ? JSON.parse(text) : {}
  } catch {
    data = null // HTML from an SPA fallback or error page — NOT a success
  }
  if (!res.ok) {
    throw new ApiError(res.status, data?.code || 'ERROR', data?.error || `${path} → ${res.status}`)
  }
  if (data === null) {
    throw new ApiError(502, 'BAD_RESPONSE', `${path} returned non-JSON — is the functions server running?`)
  }
  return data
}

const get = (path) => request(path)
const post = (path, body) => request(path, { method: 'POST', body: JSON.stringify(body) })
const put = (path, body) => request(path, { method: 'PUT', body: JSON.stringify(body) })
const del = (path) => request(path, { method: 'DELETE' })

export const api = {
  health: () => fetch('/api/scan').then((r) => r.json()), // unauthenticated on purpose

  scan: (cfg) => post('/api/scan', cfg),
  comps: (keywords, categoryId) => post('/api/comps', { keywords, categoryId }),
  taxonomy: (q) => get(`/api/taxonomy?q=${encodeURIComponent(q)}`),

  me: () => get('/api/me'),
  saveSettings: (patch) => put('/api/me', patch),
  testWebhook: (url) => put('/api/me', { action: 'test_webhook', url }),

  deals: () => get('/api/deals'),
  saveDeal: (deal) => post('/api/deals', deal),
  updateDeal: (id, patch) => put(`/api/deals?id=${id}`, patch),
  deleteDeal: (id) => del(`/api/deals?id=${id}`),

  watches: () => get('/api/watches'),
  createWatch: (watch) => post('/api/watches', watch),
  updateWatch: (id, patch) => put(`/api/watches?id=${id}`, patch),
  deleteWatch: (id) => del(`/api/watches?id=${id}`),

  billing: () => get('/api/billing'),
  checkout: (plan) => post('/api/billing', { action: 'checkout', plan }),
  portal: () => post('/api/billing', { action: 'portal' }),

  admin: () => get('/api/admin'),
  deleteCollision: (term) => del(`/api/admin?collision=${encodeURIComponent(term)}`),
}
