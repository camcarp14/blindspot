// Stripe webhook — the ONLY writer of plan state. Everything else reads
// profiles.plan and trusts it. Signature verification is hand-rolled HMAC
// (node:crypto), same zero-dep rule as the rest of the backend.

import { createHmac, timingSafeEqual } from 'node:crypto'
import { sb } from './_shared/ebay.mjs'

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

// Stripe-Signature: t=<ts>,v1=<hmac>,... — HMAC-SHA256 of `${t}.${rawBody}`.
// Exported so the smoke test can prove it against a self-signed fixture.
export function verifySignature(rawBody, header, secret, toleranceSec = 300) {
  if (!header || !secret) return false
  const parts = Object.fromEntries(
    header.split(',').map((p) => {
      const i = p.indexOf('=')
      return [p.slice(0, i).trim(), p.slice(i + 1)]
    }),
  )
  const t = Number(parts.t)
  if (!t || Math.abs(Date.now() / 1000 - t) > toleranceSec) return false
  const expected = createHmac('sha256', secret).update(`${parts.t}.${rawBody}`).digest('hex')
  const given = Buffer.from(parts.v1 || '', 'utf8')
  const want = Buffer.from(expected, 'utf8')
  return given.length === want.length && timingSafeEqual(given, want)
}

function planFromPriceId(priceId) {
  if (priceId && priceId === process.env.STRIPE_PRICE_OPERATOR) return 'operator'
  if (priceId && priceId === process.env.STRIPE_PRICE_PICKER) return 'picker'
  return null
}

async function stripeGet(path) {
  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` },
  })
  if (!res.ok) throw new Error(`STRIPE_GET_${res.status}`)
  return res.json()
}

// Active/trialing on a known price → that plan. Anything else → scout.
async function syncSubscription(supa, sub, userIdHint) {
  const userId =
    sub.metadata?.user_id ||
    userIdHint ||
    (await lookupByCustomer(supa, sub.customer))
  if (!userId) {
    console.error(`stripe-webhook: no user for subscription ${sub.id}`)
    return
  }
  const priceId = sub.items?.data?.[0]?.price?.id
  const paidPlan = planFromPriceId(priceId)
  const active = ['active', 'trialing'].includes(sub.status)
  const plan = active && paidPlan ? paidPlan : 'scout'

  await supa.upsert(
    'subscriptions',
    [
      {
        id: sub.id,
        user_id: userId,
        plan: paidPlan || 'scout',
        status: sub.status,
        current_period_end: sub.current_period_end
          ? new Date(sub.current_period_end * 1000).toISOString()
          : null,
        updated_at: new Date().toISOString(),
      },
    ],
    'id',
  )
  await supa.update('profiles', `id=eq.${userId}`, {
    plan,
    stripe_customer_id: typeof sub.customer === 'string' ? sub.customer : sub.customer?.id,
  })
}

async function lookupByCustomer(supa, customer) {
  const id = typeof customer === 'string' ? customer : customer?.id
  if (!id) return null
  const rows = await supa.select('profiles', `stripe_customer_id=eq.${id}&select=id`)
  return rows?.[0]?.id || null
}

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405)
  const raw = await req.text() // raw body — signature covers the exact bytes
  const sig = req.headers.get('stripe-signature')
  if (!verifySignature(raw, sig, process.env.STRIPE_WEBHOOK_SECRET)) {
    return json({ error: 'bad signature' }, 400)
  }

  const supa = sb()
  if (!supa) return json({ error: 'supabase not configured' }, 500)

  let event
  try {
    event = JSON.parse(raw)
  } catch {
    return json({ error: 'bad json' }, 400)
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object
        if (session.mode === 'subscription' && session.subscription) {
          const sub = await stripeGet(`/subscriptions/${session.subscription}`)
          await syncSubscription(supa, sub, session.client_reference_id)
        }
        break
      }
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        await syncSubscription(supa, event.data.object, null)
        break
      }
      default:
        break // acknowledge everything else; Stripe retries on non-2xx
    }
  } catch (e) {
    console.error('stripe-webhook:', e)
    return json({ error: 'handler failed' }, 500) // 500 → Stripe retries
  }

  return json({ received: true })
}
