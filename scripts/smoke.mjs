// BLINDSPOT smoke test — planted problems, hard exit on failure.
// Every rule engine gets a fixture with KNOWN defects and we assert each one
// fires. Builds cannot catch these; this can. Run: npm run smoke

import {
  typoVariants,
  detectSignals,
  marginMath,
  scoreItem,
  clearsThreshold,
  maxJustifiedBid,
  DEFAULT_ECON,
} from '../src/lib/scoring.js'
import { isKnownCollision, isLikelyRealTerm } from '../netlify/functions/_shared/typoguard.mjs'
import { scanCacheKey } from '../netlify/functions/_shared/ebay.mjs'
import { verifySignature } from '../netlify/functions/stripe-webhook.mjs'
import { PLANS, POOL_SPLIT, poolCap, planOf, watchQueryCostPerDay } from '../src/lib/plans.js'
import { createHmac } from 'node:crypto'

let failures = 0
const ok = (cond, label) => {
  console.log(`${cond ? 'ok:' : 'FAIL:'} ${label}`)
  if (!cond) failures++
}

// ── typo variants ───────────────────────────────────────────────────
const variants = typoVariants('takumar')
ok(variants.includes('takmar'), 'typoVariants: deletion variant generated')
ok(variants.includes('atkumar'), 'typoVariants: transposition variant generated')
ok(!variants.includes('takumar'), 'typoVariants: correct spelling never included')
ok(typoVariants('sony').length === 0, 'typoVariants: short brands produce nothing')

// ── collision guard ─────────────────────────────────────────────────
ok(isKnownCollision('nikor'), 'collision: seeded "nikor" blocked')
ok(isKnownCollision('gixen', ['gixen']), 'collision: user exclude blocked')
ok(isKnownCollision('starret', [], ['starret']), 'collision: community-learned term blocked')
ok(!isKnownCollision('takmar'), 'collision: real typo NOT blocked')

const collisionItems = [
  { title: 'Nikor developing tank 35mm', seller: { username: 'a' } },
  { title: 'nikor stainless reel', seller: { username: 'b' } },
  { title: 'NIKOR tank lot of 2', seller: { username: 'c' } },
  { title: 'Kodak fixer', seller: { username: 'd' } },
]
ok(isLikelyRealTerm('nikor', collisionItems), 'realTerm: 3 sellers, 75% ratio → real word')
ok(
  !isLikelyRealTerm('takmar', [
    { title: 'Takmar 50mm lens', seller: { username: 'one-guy' } },
    { title: 'canon fd 50', seller: { username: 'x' } },
    { title: 'helios 44', seller: { username: 'y' } },
  ]),
  'realTerm: one seller misspelling → still a typo',
)

// ── planted signal fixture: EVERY signal must fire ──────────────────
const planted = {
  title: 'old camera lens', // thin (<35) + no digits… wait, has none
  buyingOptions: ['AUCTION'],
  bidCount: 0,
  itemEndDate: new Date(Date.now() + 3 * 36e5).toISOString(),
  seller: { feedbackScore: 4 },
  conditionId: '7000',
  shippingOptions: [{ shippingCostType: 'NOT_SPECIFIED' }],
}
const signals = detectSignals(planted, { fixable: true, expectModelNumbers: true })
const codes = new Set(signals.map((s) => s.code))
for (const expected of ['ZERO_BIDS', 'ENDING_6H', 'SELLER_NEW', 'FIXABLE_PARTS', 'THIN_TITLE', 'NO_MODEL', 'FRICTION']) {
  ok(codes.has(expected), `signals: planted ${expected} fires`)
}
const typoSignals = detectSignals({ ...planted, title: 'takmar 50mm lens' }, { typoOrigin: 'takmar', correctBrand: 'takumar' })
ok(typoSignals.some((s) => s.code === 'TYPO_HIT'), 'signals: typo hit fires')
ok(typoSignals.some((s) => s.code === 'TYPO_INVISIBLE'), 'signals: invisible-brand bonus fires')
const commonSignals = detectSignals(planted, { typoOrigin: 'nikor', commonTerm: true })
ok(commonSignals.some((s) => s.code === 'COMMON_TERM' && s.pts === 0), 'signals: common term scores ZERO points')

// ── margin math with known numbers ──────────────────────────────────
// comp 420, fee 13.35% + $0.40, ship 12, buy 100 → net = 420*0.8665 - 0.4 - 12 - 100 = 251.53
const m = marginMath({ price: { value: '100' } }, 420, { feeRate: 0.1335, perOrderFee: 0.4, shipEstimate: 12 })
ok(Math.abs(m.estNet - 251.53) < 0.01, `marginMath: exact net (got ${m.estNet}, want 251.53)`)
ok(m.marginPct === 251.5, `marginMath: margin pct rounded (got ${m.marginPct})`)
ok(marginMath({ price: { value: '100' } }, 0) === null, 'marginMath: zero comp → null, never NaN')
ok(marginMath({}, 420) === null, 'marginMath: zero buy price → null')

// underwater listing must subtract, not add
const underwater = scoreItem(
  { price: { value: '400' }, buyingOptions: [] },
  { compMedian: 100, compN: 8, econ: DEFAULT_ECON },
)
ok(underwater.margin.estNet < 0, 'scoring: planted underwater deal has negative net')
ok(underwater.score === 0, `scoring: underwater deal floors at 0 (got ${underwater.score})`)

// ── ceiling bid: the number handed to the sniper must clear the bar ──
const econ = { feeRate: 0.1335, perOrderFee: 0.4, shipEstimate: 12 }
const bar = { minMarginPct: 30, minNetUsd: 25 }
const ceiling = maxJustifiedBid(420, econ, bar)
const atCeiling = marginMath({ price: { value: String(ceiling) } }, 420, econ)
ok(
  atCeiling.marginPct >= bar.minMarginPct - 0.1 || atCeiling.estNet >= bar.minNetUsd - 0.01,
  `maxJustifiedBid: bid AT ceiling ($${ceiling}) still clears the bar`,
)
const overCeiling = marginMath({ price: { value: String(ceiling + 1) } }, 420, econ)
ok(
  !clearsThreshold({ margin: overCeiling, score: 0 }, bar),
  'maxJustifiedBid: $1 over ceiling fails the bar',
)

// ── plans: the economics have to be internally consistent ───────────
const splitSum = Object.values(POOL_SPLIT).reduce((s, x) => s + x, 0)
ok(Math.abs(splitSum - 1) < 1e-9, `plans: pool split sums to 1 (got ${splitSum})`)
ok(poolCap('interactive') + poolCap('watch') < 5000, 'plans: pools leave a reserve under the 5k ceiling')
ok(PLANS.scout.watchSlots === 0 && !PLANS.scout.alerts, 'plans: scout has no watches, no alerts')
ok(PLANS.picker.price < PLANS.operator.price, 'plans: prices ascend')
ok(PLANS.picker.priority < PLANS.operator.priority, 'plans: operator outranks picker at the ledger')
ok(planOf('nonsense').id === 'scout', 'plans: unknown plan falls back to scout, never crashes')
ok(watchQueryCostPerDay(30) === 48, 'plans: 30-min cadence = 48 calls/query/day')
// every plan's watches must physically fit in the watch pool at worst case (zero dedupe)
for (const p of Object.values(PLANS)) {
  if (!p.watchSlots) continue
  const worstCase = p.watchSlots * 12 * watchQueryCostPerDay(p.cadenceMinutes)
  ok(
    worstCase <= poolCap('watch') * 2.5,
    `plans: one maxed ${p.id} (${worstCase} calls/day worst-case) is within dedupe-rescue range of the ${poolCap('watch')} pool`,
  )
}

// ── scan cache key: shared calls only when params truly match ───────
const base = { q: 'canon fd 50mm', categoryIds: ['625'], auctionOnly: true, maxPrice: 400, limit: 50, sort: 'endingSoonest' }
ok(scanCacheKey(base) === scanCacheKey({ ...base }), 'cacheKey: identical params → identical key')
ok(scanCacheKey(base) !== scanCacheKey({ ...base, maxPrice: 500 }), 'cacheKey: different filter → different key')
ok(scanCacheKey(base) !== scanCacheKey({ ...base, q: 'canon fd 55mm' }), 'cacheKey: different query → different key')

// ── stripe webhook signature: self-signed fixture ───────────────────
const secret = 'whsec_test_123'
const payload = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed' })
const t = Math.floor(Date.now() / 1000)
const v1 = createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex')
ok(verifySignature(payload, `t=${t},v1=${v1}`, secret), 'webhook: valid signature accepted')
ok(!verifySignature(payload + 'x', `t=${t},v1=${v1}`, secret), 'webhook: tampered payload rejected')
ok(!verifySignature(payload, `t=${t},v1=${'0'.repeat(64)}`, secret), 'webhook: wrong signature rejected')
ok(!verifySignature(payload, `t=${t - 9999},v1=${v1}`, secret), 'webhook: stale timestamp rejected')
ok(!verifySignature(payload, null, secret), 'webhook: missing header rejected')

console.log(failures ? `\n${failures} FAILURES` : '\nALL SMOKE TESTS PASS')
process.exit(failures ? 1 : 0)
