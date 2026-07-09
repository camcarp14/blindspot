// Hand-rolled Supabase auth client — GoTrue REST, zero deps, same rule as the
// backend's sb() helper. Password is primary (works with zero SMTP config);
// magic link is offered when the deployment has real email set up.
//
// Session shape: { access_token, refresh_token, expires_at (unix sec), user }.

const SUPA_URL = import.meta.env.VITE_SUPABASE_URL
const ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY
const STORE_KEY = 'blindspot.auth'

export const authConfigured = !!(SUPA_URL && ANON_KEY)

let session = null
const listeners = new Set()
let refreshing = null // single-flight refresh

function loadStored() {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY))
  } catch {
    return null
  }
}

function persist(next) {
  session = next
  if (next) localStorage.setItem(STORE_KEY, JSON.stringify(next))
  else localStorage.removeItem(STORE_KEY)
  for (const fn of listeners) fn(session)
}

async function gotrue(path, opts = {}) {
  const res = await fetch(`${SUPA_URL}/auth/v1${path}`, {
    ...opts,
    headers: {
      apikey: ANON_KEY,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(data.error_description || data.msg || data.message || `auth error ${res.status}`)
  }
  return data
}

function fromTokens(data, fallbackUser) {
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Math.floor(Date.now() / 1000) + (data.expires_in || 3600),
    user: data.user || fallbackUser || null,
  }
}

async function refresh() {
  if (!session?.refresh_token) {
    persist(null)
    return null
  }
  refreshing =
    refreshing ||
    gotrue('/token?grant_type=refresh_token', {
      method: 'POST',
      body: JSON.stringify({ refresh_token: session.refresh_token }),
    })
      .then((data) => {
        persist(fromTokens(data, session?.user))
        return session
      })
      .catch(() => {
        persist(null) // refresh token burned or revoked — clean sign-out
        return null
      })
      .finally(() => {
        refreshing = null
      })
  return refreshing
}

export const auth = {
  // Boot: adopt tokens from a magic-link/confirm redirect (#access_token=…),
  // else restore the stored session. Resolves when auth state is known.
  async init() {
    if (!authConfigured) return null
    const hash = window.location.hash
    if (hash.includes('access_token=')) {
      const params = new URLSearchParams(hash.slice(1))
      const access_token = params.get('access_token')
      const refresh_token = params.get('refresh_token')
      if (access_token) {
        let user = null
        try {
          user = await fetch(`${SUPA_URL}/auth/v1/user`, {
            headers: { apikey: ANON_KEY, Authorization: `Bearer ${access_token}` },
          }).then((r) => (r.ok ? r.json() : null))
        } catch {
          /* keep tokens; /api/me will resolve the user */
        }
        persist({
          access_token,
          refresh_token,
          expires_at: Math.floor(Date.now() / 1000) + Number(params.get('expires_in') || 3600),
          user,
        })
        history.replaceState(null, '', window.location.pathname + window.location.search)
        return session
      }
    }
    session = loadStored()
    if (session) for (const fn of listeners) fn(session)
    return session
  },

  session: () => session,

  subscribe(fn) {
    listeners.add(fn)
    return () => listeners.delete(fn)
  },

  // Valid token or null. Refreshes proactively inside the last 60s of life.
  async getToken() {
    if (!session) return null
    if (session.expires_at - 60 > Date.now() / 1000) return session.access_token
    const next = await refresh()
    return next?.access_token || null
  },

  // Force-refresh path for a server-side 401 on a token we thought was fine.
  forceRefresh: () => refresh(),

  async signIn(email, password) {
    const data = await gotrue('/token?grant_type=password', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    })
    persist(fromTokens(data))
    return session
  },

  async signUp(email, password) {
    const data = await gotrue('/signup', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    })
    if (data.access_token) {
      persist(fromTokens(data)) // email confirmation off → signed in immediately
      return { session }
    }
    return { needsConfirm: true } // confirmation on → they'll arrive via the hash path
  },

  async magicLink(email) {
    await gotrue('/otp', {
      method: 'POST',
      body: JSON.stringify({ email, create_user: true }),
    })
  },

  async signOut() {
    const token = session?.access_token
    persist(null)
    if (token) {
      // Best effort — local state is already gone either way.
      fetch(`${SUPA_URL}/auth/v1/logout`, {
        method: 'POST',
        headers: { apikey: ANON_KEY, Authorization: `Bearer ${token}` },
      }).catch(() => {})
    }
  },
}
