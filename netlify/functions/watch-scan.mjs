// Scheduled scanner: every 30 minutes, run enabled watches from Supabase,
// score results, alert Discord on NEW items that clear threshold.
// No-ops gracefully if Supabase isn't configured.

import { browseSearch, sb } from './_shared/ebay.mjs'
import { isKnownCollision, isLikelyRealTerm } from './_shared/typoguard.mjs'
import { scoreItem, typoVariants, clearsThreshold, DEFAULT_ECON } from '../../src/lib/scoring.js'

export default async () => {
  const supa = sb()
  if (!supa) {
    console.log('watch-scan: Supabase not configured, skipping')
    return new Response('skipped')
  }

  const watches = await supa.select('watches', 'enabled=eq.true&select=*')
  if (!watches?.length) return new Response('no watches')

  const webhook = process.env.DISCORD_WEBHOOK_URL
  let alerted = 0

  for (const w of watches) {
    const cfg = w.config || {}
    const econ = { ...DEFAULT_ECON, ...(cfg.econ || {}) }
    const typoExclude = cfg.typoExclude || []
    const plan = (cfg.queries || []).map((q) => ({ q, typoOrigin: null, correctBrand: null }))
    if (cfg.typoHunt) {
      for (const brand of cfg.typoBrands || []) {
        for (const v of typoVariants(brand).slice(0, 4)) {
          if (isKnownCollision(v, typoExclude)) continue
          plan.push({ q: v, typoOrigin: v, correctBrand: brand })
        }
      }
    }

    const hits = []
    for (const step of plan.slice(0, 12)) {
      try {
        const items = await browseSearch({
          q: step.q,
          categoryIds: cfg.categoryIds || [],
          conditionIds: cfg.conditionIds || [],
          auctionOnly: !!cfg.auctionOnly,
          maxPrice: cfg.maxPrice || null,
          endingWithinHours: cfg.endingWithinHours || null,
          limit: 25,
          sort: cfg.auctionOnly ? 'endingSoonest' : 'newlyListed',
        })
        const commonTerm = step.typoOrigin ? isLikelyRealTerm(step.typoOrigin, items) : false
        for (const item of items) {
          const scored = scoreItem(item, {
            typoOrigin: step.typoOrigin,
            correctBrand: step.correctBrand,
            commonTerm,
            fixable: !!cfg.fixable,
            expectModelNumbers: cfg.expectModelNumbers !== false,
            compMedian: cfg.comps?.[step.q]?.median || null,
            compN: cfg.comps?.[step.q]?.n || 0,
            econ,
          })
          if (scored.score >= (cfg.minScore || 45) && clearsThreshold(scored, cfg.threshold || {})) {
            hits.push({ item, scored })
          }
        }
      } catch (e) {
        console.log(`watch ${w.id} query "${step.q}" failed: ${e.message}`)
      }
    }

    if (!hits.length) continue

    const ids = hits.map((h) => `"${h.item.itemId}"`).join(',')
    const seenRows = await supa.select('seen_items', `item_id=in.(${ids})&select=item_id`)
    const seenSet = new Set((seenRows || []).map((r) => r.item_id))
    const fresh = hits.filter((h) => !seenSet.has(h.item.itemId))
    if (!fresh.length) continue

    await supa.upsert(
      'seen_items',
      fresh.map((h) => ({
        item_id: h.item.itemId,
        watch_id: w.id,
        score: h.scored.score,
        title: h.item.title,
        seen_at: new Date().toISOString(),
      })),
      'item_id',
    )

    if (webhook) {
      const top = fresh.sort((a, b) => b.scored.score - a.scored.score).slice(0, 5)
      await fetch(webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: `**BLINDSPOT** · ${w.name || 'watch'} · ${fresh.length} new`,
          embeds: top.map(({ item, scored }) => ({
            title: `[${scored.score}] ${item.title}`.slice(0, 256),
            url: item.itemWebUrl,
            description: [
              `$${item.currentBidPrice?.value ?? item.price?.value} · ${item.bidCount ?? 0} bids`,
              item.itemEndDate ? `ends <t:${Math.floor(new Date(item.itemEndDate) / 1000)}:R>` : null,
              scored.margin ? `est net $${scored.margin.estNet} (${scored.margin.marginPct}%)` : null,
              scored.signals.map((s) => s.label).join(' · '),
            ]
              .filter(Boolean)
              .join('\n')
              .slice(0, 2048),
            color: scored.score >= 70 ? 0xffb454 : 0x8fbf7f,
          })),
        }),
      })
      alerted += top.length
    }
  }

  return new Response(`done, alerted ${alerted}`)
}

export const config = {
  schedule: '*/30 * * * *',
}
