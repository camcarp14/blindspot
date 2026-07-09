// Profile + settings + usage. Everything that was a deployment env var in v1
// and is actually a per-seller fact — fee rate, per-order fee, Discord webhook,
// typo excludes — lives on the profile now and is edited here.

import { sb } from './_shared/ebay.mjs'
import { requireUser, guarded, json } from './_shared/auth.mjs'
import { usageToday, budgetSnapshot } from './_shared/quota.mjs'
import { DEFAULT_ECON } from '../../src/lib/scoring.js'

export default guarded(async (req) => {
  const { user, profile, plan } = await requireUser(req)
  const supa = sb()

  if (req.method === 'GET') {
    const [usage, budget] = await Promise.all([usageToday(supa, user.id), budgetSnapshot(supa)])
    return json({
      profile: {
        id: profile.id,
        email: profile.email,
        plan: plan.id,
        isAdmin: !!profile.is_admin,
        econ: { feeRate: DEFAULT_ECON.feeRate, perOrderFee: DEFAULT_ECON.perOrderFee, ...(profile.econ || {}) },
        discordWebhookUrl: profile.discord_webhook_url || '',
        typoExclude: profile.typo_exclude || [],
      },
      usage: { ...usage, scansLimit: plan.scansPerDay },
      budget,
    })
  }

  if (req.method === 'PUT') {
    let body
    try {
      body = await req.json()
    } catch {
      return json({ error: 'bad json' }, 400)
    }

    // One-shot webhook test — post a hello to the URL they just pasted, from
    // the server (browser CORS makes client-side tests lie).
    if (body.action === 'test_webhook') {
      const hook = String(body.url || profile.discord_webhook_url || '')
      if (!/^https:\/\/(discord|discordapp)\.com\/api\/webhooks\//.test(hook)) {
        return json({ ok: false, error: 'That does not look like a Discord webhook URL' })
      }
      const r = await fetch(hook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: '**BLINDSPOT** · webhook test — alerts will land here.' }),
      })
      return json({ ok: r.ok, error: r.ok ? null : `Discord answered ${r.status}` })
    }

    const patch = {}
    if (body.econ != null) {
      const num = (v) => (v === '' || v == null || Number.isNaN(Number(v)) ? null : Number(v))
      const feeRate = num(body.econ.feeRate)
      const perOrderFee = num(body.econ.perOrderFee)
      patch.econ = {}
      if (feeRate != null && feeRate >= 0 && feeRate < 0.5) patch.econ.feeRate = feeRate
      if (perOrderFee != null && perOrderFee >= 0 && perOrderFee < 20) patch.econ.perOrderFee = perOrderFee
    }
    if ('discordWebhookUrl' in body) {
      const hook = String(body.discordWebhookUrl || '').trim()
      patch.discord_webhook_url =
        hook && /^https:\/\/(discord|discordapp)\.com\/api\/webhooks\//.test(hook) ? hook : null
    }
    if (Array.isArray(body.typoExclude)) {
      patch.typo_exclude = body.typoExclude.map((s) => String(s).toLowerCase().trim()).filter(Boolean).slice(0, 100)
    }
    const rows = await supa.update('profiles', `id=eq.${user.id}`, patch)
    return json({ saved: !!rows?.length })
  }

  return json({ error: 'GET or PUT only' }, 405)
})
