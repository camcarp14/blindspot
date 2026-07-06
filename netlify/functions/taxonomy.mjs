import { categorySuggestions } from './_shared/ebay.mjs'

export default async (req) => {
  const q = new URL(req.url).searchParams.get('q')
  if (!q) {
    return new Response(JSON.stringify({ error: 'q required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  try {
    const suggestions = await categorySuggestions(q)
    return new Response(JSON.stringify({ suggestions }), {
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e.message) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
}
