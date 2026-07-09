// UI preview without a Supabase project: boots vite with dummy auth env so the
// landing gate and shell render. API calls will fail (by design) — this is for
// looking at the UI, not using the product. Real dev: `npx netlify dev`.
process.env.VITE_SUPABASE_URL ||= 'https://demo-preview.supabase.co'
process.env.VITE_SUPABASE_ANON_KEY ||= 'demo-preview-key'

const port = Number(process.env.PORT) || 5199
const { createServer } = await import('vite')
const { fileURLToPath } = await import('node:url')
const path = await import('node:path')
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url))) // repo root, wherever we're launched from
const server = await createServer({ root, server: { port, strictPort: true } })
await server.listen()
console.log(`preview up on http://localhost:${port} (dummy Supabase env — UI only)`)
