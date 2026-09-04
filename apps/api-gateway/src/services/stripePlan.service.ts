/**
 * Stripe for the unit plan (SINGLE base + $19 units).
 *
 * One Stripe subscription per organization with up to five line items:
 * the base plan and one quantity-priced item per unit. Prices are created on
 * demand from `billing_catalog` and found again by lookup key that embeds
 * the amount, so an admin price change simply produces a new price.
 *
 * Entitlements follow the subscription: on checkout completion, subscription
 * update or deletion the subscription's items are mapped back to
 * `org_entitlements` with source 'stripe'. Nothing here is required for the
 * app to run: without STRIPE_SECRET_KEY the plan page falls back to the
 * manual PATCH flow.
 */
import Stripe from 'stripe';
import { supabase } from '../config/database.js';
import { logger } from '../utils/logger.js';
import { Catalog, Unit, UNITS, includedQuantity, getCatalog, baseEntitlements } from './entitlements.service.js';
import { LineKey, LABELS, lookupKey, lineAmount, entitlementsFromItems } from './stripePlanPricing.js';

export { lookupKey, parseLookupKey, entitlementsFromItems } from './stripePlanPricing.js';

const stripeSecretKey = process.env.STRIPE_SECRET_KEY || '';
let client: Stripe | null = null;

export function stripeEnabled(): boolean {
  return Boolean(stripeSecretKey);
}

function stripe(): Stripe {
  if (!stripeSecretKey) throw new Error('Stripe is not configured (STRIPE_SECRET_KEY missing)');
  if (!client) client = new Stripe(stripeSecretKey, { apiVersion: '2023-10-16' as never });
  return client;
}

function appUrl(): string {
  return (process.env.FRONTEND_URL || 'https://www.SMEsAgent.dev').replace(/\/$/, '');
}

const priceCache = new Map<string, string>();

async function ensurePrice(catalog: Catalog, key: LineKey): Promise<string> {
  const cents = lineAmount(catalog, key);
  const lookup = lookupKey(key, cents);
  const cached = priceCache.get(lookup);
  if (cached) return cached;
  const s = stripe();
  const existing = await s.prices.list({ lookup_keys: [lookup], active: true, limit: 1 });
  if (existing.data[0]) { priceCache.set(lookup, existing.data[0].id); return existing.data[0].id; }
  const products = await s.products.search({ query: `metadata['ecg_line']:'${key}'`, limit: 1 });
  const product = products.data[0] ?? await s.products.create({ name: `SMEsAgent ${LABELS[key]}`, metadata: { ecg_line: key } });
  const price = await s.prices.create({
    product: product.id, currency: catalog.currency.toLowerCase(), unit_amount: cents,
    recurring: { interval: 'month' }, lookup_key: lookup, transfer_lookup_key: true,
    metadata: { ecg_line: key },
  });
  priceCache.set(lookup, price.id);
  return price.id;
}

async function ensureCustomer(orgId: string, email?: string | null): Promise<string> {
  const { data: org } = await supabase.from('organizations').select('id, name, stripe_customer_id').eq('id', orgId).single();
  if (org?.stripe_customer_id) return org.stripe_customer_id;
  const customer = await stripe().customers.create({ name: org?.name ?? undefined, email: email ?? undefined, metadata: { org_id: orgId } });
  await supabase.from('organizations').update({ stripe_customer_id: customer.id }).eq('id', orgId);
  return customer.id;
}

/**
 * A Checkout Session for the wanted quantities. Returns the hosted URL.
 * A new subscription replaces the org's current one on completion.
 */
export async function createPlanCheckout(orgId: string, userId: string, email: string | null, wanted: Record<Unit, number>): Promise<{ url: string; sessionId: string }> {
  const catalog = await getCatalog();
  const customer = await ensureCustomer(orgId, email);
  const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [{ price: await ensurePrice(catalog, 'base'), quantity: 1 }];
  for (const unit of UNITS) {
    const extra = Math.max(0, wanted[unit] - includedQuantity(catalog, unit));
    if (extra > 0) lineItems.push({ price: await ensurePrice(catalog, unit), quantity: extra });
  }
  const back = `${appUrl()}/dashboard/organizations?tab=billing`;
  const session = await stripe().checkout.sessions.create({
    mode: 'subscription',
    customer,
    line_items: lineItems,
    success_url: `${back}&checkout=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${back}&checkout=cancelled`,
    allow_promotion_codes: true,
    client_reference_id: orgId,
    metadata: { org_id: orgId, user_id: userId },
    subscription_data: { metadata: { org_id: orgId } },
  });
  if (!session.url) throw new Error('Stripe did not return a checkout URL');
  return { url: session.url, sessionId: session.id };
}

/** Write a subscription's items into org_entitlements (source 'stripe'). */
export async function applySubscription(sub: Stripe.Subscription): Promise<void> {
  const orgId = sub.metadata?.org_id;
  if (!orgId) { logger.warn('[stripe-plan] subscription without org_id metadata', { subscription: sub.id }); return; }
  const catalog = await getCatalog();
  const items = await stripe().subscriptionItems.list({ subscription: sub.id, limit: 20, expand: ['data.price'] });
  const active = ['active', 'trialing', 'past_due'].includes(sub.status);
  const quantities = active
    ? entitlementsFromItems(catalog, items.data.map((it) => ({ lookup_key: it.price.lookup_key, quantity: it.quantity ?? 1 })))
    : baseEntitlements(orgId, catalog);
  const { error } = await supabase.from('org_entitlements').upsert({
    org_id: orgId, plan_id: catalog.id,
    apps: quantities.apps, users: quantities.users, agents: quantities.agents, databases: quantities.databases,
    source: active ? 'stripe' : 'manual', stripe_subscription_id: active ? sub.id : null, updated_at: new Date().toISOString(),
  });
  if (error) logger.error('[stripe-plan] entitlements upsert failed', { orgId, error: error.message });
  else logger.info('[stripe-plan] entitlements applied from subscription', { orgId, subscription: sub.id, status: sub.status, quantities });
}

/**
 * After the customer returns from Checkout: read the session and, if it
 * produced a subscription, apply it. Works without the webhook so the
 * "thanks" page is truthful either way.
 */
export async function confirmCheckout(sessionId: string, orgId: string): Promise<{ paid: boolean; status: string; subscriptionId: string | null }> {
  const session = await stripe().checkout.sessions.retrieve(sessionId);
  if (session.client_reference_id !== orgId && session.metadata?.org_id !== orgId) throw new Error('Checkout session belongs to another workspace');
  const subId = typeof session.subscription === 'string' ? session.subscription : session.subscription?.id ?? null;
  const paid = session.payment_status === 'paid' || session.status === 'complete';
  if (subId && paid) {
    const sub = await stripe().subscriptions.retrieve(subId);
    await applySubscription(sub);
  }
  return { paid, status: session.status ?? 'open', subscriptionId: subId };
}

export async function createPortalSession(orgId: string): Promise<string> {
  const customer = await ensureCustomer(orgId);
  const portal = await stripe().billingPortal.sessions.create({ customer, return_url: `${appUrl()}/dashboard/organizations?tab=billing` });
  return portal.url;
}

export function constructWebhookEvent(rawBody: Buffer, signature: string): Stripe.Event {
  const secret = process.env.STRIPE_PLAN_WEBHOOK_SECRET || process.env.STRIPE_WEBHOOK_SECRET || '';
  if (!secret) throw new Error('STRIPE_WEBHOOK_SECRET is not configured');
  return stripe().webhooks.constructEvent(rawBody, signature, secret);
}

export async function handleWebhookEvent(event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session;
      const subId = typeof session.subscription === 'string' ? session.subscription : session.subscription?.id;
      if (subId) await applySubscription(await stripe().subscriptions.retrieve(subId));
      return;
    }
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
      await applySubscription(event.data.object as Stripe.Subscription);
      return;
    default:
      return;
  }
}
