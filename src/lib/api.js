async function post(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`${path} → ${res.status}`)
  return res.json()
}

export const api = {
  health: () => fetch('/api/scan').then((r) => r.json()),
  scan: (cfg) => post('/api/scan', cfg),
  comps: (keywords, categoryId) => post('/api/comps', { keywords, categoryId }),
  taxonomy: (q) => fetch(`/api/taxonomy?q=${encodeURIComponent(q)}`).then((r) => r.json()),
}
