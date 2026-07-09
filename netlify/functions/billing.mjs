// Stripe billing — checkout + customer portal. Zero-dep on purpose: Stripe's
// REST API is form-encoded HTTP, and the sb() helper set the precedent that we
// talk to services directly. The webhook (stripe-webhook.mjs) is the only
// writer of plan state; this file just opens Stripe-hosted pages.

import { sb } from './_shared/ebay.mjs'
import { requireUser, guarded, json, HttpError } from './_shared/auth.mjs'
import { PLANS } from '../../src/lib/plans.js'

const STRIPE = 'https://api.stripe.com/v1'

function priceIdFor(planId) {
  if (planId === 'picker') return process.env.STRIPE_PRICE_PICKER
  if (planId === 'operator') return process.env.STRIPE_PRICE_OPERATOR
  return null
}

async function stripe(path, params) {
  const key = process.env.STRIPE_SECRET_KEY
  if (!key) throw new HttpError(503, 'BILLING_OFF', 'Billing is not configured on this deployment')
  const body = new URLSearchParams()
  const add = (k, v) => {
    if (v == null) return
    if (typeof v === 'object') {
      for (const [k2, v2] of Object.entries(v)) add(`${k}[${k2}]`, v2)
    } else {
      body.append(k, String(v))
    }
  }
  for (const [k, v] of Object.entries(params || {})) add(k, v)
  const res = await fetch(`${STRIPE}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  })
  const data = await res.json()
  if (!res.ok) {
    throw new HttpError(502, 'STRIPE_ERROR', data.error?.message || `Stripe ${res.status}`)
  }
  return data
}

// Netlify sets URL to the site's canonical address; APP_URL overrides for
// custom domains that haven't been made primary yet.
const siteUrl = () => process.env.APP_URL || process.env.URL || 'http://localhost:8888'

export default guarded(async (req) => {
  const { user, profile, plan } = await requireUser(req)
  const supa = sb()

  if (req.method === 'GET') {
    const subs = await supa.select(
      'subscriptions',
      `user_id=eq.${user.id}&select=*&order=updated_at.desc&limit=1`,
    )
    return json({
      configured: !!process.env.STRIPE_SECRET_KEY,
      plan: plan.id,
      subscription: subs?.[0] || null,
    })
  }

  if (req.method !== 'POST') return json({ error: 'GET or POST only' }, 405)

  let body
  try {
    body = await req.json()
  } catch {
    return json({ error: 'bad json' }, 400)
  }

  // Reuse the Stripe customer across plan changes — one customer per profile.
  async function ensureCustomer() {
    if (profile.stripe_customer_id) return profile.stripe_customer_id
    const customer = await stripe('/customers', {
      email: user.email,
      metadata: { user_id: user.id },
    })
    await supa.update('profiles', `id=eq.${user.id}`, { stripe_customer_id: customer.id })
    return customer.id
  }

  if (body.action === 'checkout') {
    const target = PLANS[body.plan]
    const price = priceIdFor(body.plan)
    if (!target || !price) {
      throw new HttpError(400, 'BAD_PLAN', `No such plan (configured: picker=${!!priceIdFor('picker')}, operator=${!!priceIdFor('operator')})`)
    }
    const customer = await ensureCustomer()
    const session = await stripe('/checkout/sessions', {
      mode: 'subscription',
      customer,
      client_reference_id: user.id,
      'line_items[0][price]': price,
      'line_items[0][quantity]': 1,
      success_url: `${siteUrl()}/?billing=success`,
      cancel_url: `${siteUrl()}/?billing=cancelled`,
      'subscription_data[metadata][user_id]': user.id,
      allow_promotion_codes: true,
    })
    return json({ url: session.url })
  }

  if (body.action === 'portal') {
    if (!profile.stripe_customer_id) {
      throw new HttpError(400, 'NO_CUSTOMER', 'No billing history yet — upgrade first')
    }
    const session = await stripe('/billing_portal/sessions', {
      customer: profile.stripe_customer_id,
      return_url: `${siteUrl()}/`,
    })
    return json({ url: session.url })
  }

  return json({ error: 'unknown action' }, 400)
})
