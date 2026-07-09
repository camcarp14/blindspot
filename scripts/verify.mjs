// The verification gate — run before EVERY deploy: npm run verify
// 1. esbuild-bundles every Netlify function EXACTLY as the platform does
//    (catches unresolvable imports that node --check and vite build miss)
// 2. runs the smoke test (planted problems in the scoring/quota/webhook logic)
// 3. runs the production frontend build
import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
let failed = false

// ── 1. bundle sweep ─────────────────────────────────────────────────
const fnDir = path.join(root, 'netlify', 'functions')
const entries = readdirSync(fnDir).filter((f) => f.endsWith('.mjs'))
for (const f of entries) {
  try {
    await build({
      entryPoints: [path.join(fnDir, f)],
      bundle: true,
      platform: 'node',
      format: 'esm',
      write: false,
      logLevel: 'silent',
    })
    console.log(`ok: bundle ${f}`)
  } catch (e) {
    failed = true
    console.error(`BUNDLE FAIL: ${f}`)
    for (const err of e.errors || []) console.error(`  ${err.text} (${err.location?.file}:${err.location?.line})`)
  }
}

// ── 2. smoke ────────────────────────────────────────────────────────
const smoke = spawnSync(process.execPath, [path.join(root, 'scripts', 'smoke.mjs')], { stdio: 'inherit' })
if (smoke.status !== 0) failed = true

// ── 3. frontend build ───────────────────────────────────────────────
const vite = spawnSync(
  process.execPath,
  [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), 'build'],
  { stdio: 'inherit', cwd: root },
)
if (vite.status !== 0) failed = true

console.log(failed ? '\nGATE FAILED — do not deploy' : '\nGATE CLEAN — safe to deploy')
process.exit(failed ? 1 : 0)
