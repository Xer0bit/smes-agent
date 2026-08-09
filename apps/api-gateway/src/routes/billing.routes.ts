import { Router, Request, Response } from 'express';
import Stripe from 'stripe';
import { supabase } from '../config/database.js';
import { logger } from '../utils/logger.js';

const router = Router();

const stripeSecretKey = process.env.STRIPE_SECRET_KEY || '';
const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET || '';

// Lazy singleton: constructing Stripe with an empty key throws immediately,
// which would crash the whole server at import time when STRIPE_SECRET_KEY
// isn't configured (e.g. local dev). Defer construction to first use.
let stripeClient: Stripe | null = null;
function getStripe(): Stripe | null {
  if (!stripeSecretKey) return null;
  if (!stripeClient) {
    stripeClient = new Stripe(stripeSecretKey, { apiVersion: '2023-10-16' as any });
  }
  return stripeClient;
}

/**
 * POST /api/v1/billing/webhook
 * Receives and processes events from Stripe (e.g. checkout completion, subscription updates/cancellations).
 * Requires raw body for signature verification.
 */
router.post('/webhook', async (req: Request, res: Response) => {
  const sig = req.headers['stripe-signature'];

  if (!sig || typeof sig !== 'string') {
    logger.error('[stripe-webhook] Missing stripe-signature header');
    res.status(400).json({ error: 'Missing stripe-signature header' });
    return;
  }

  if (!stripeWebhookSecret) {
    logger.error('[stripe-webhook] STRIPE_WEBHOOK_SECRET environment variable is not configured');
    res.status(500).json({ error: 'Webhook secret not configured on server' });
    return;
  }

  const stripe = getStripe();
  if (!stripe) {
    logger.error('[stripe-webhook] STRIPE_SECRET_KEY environment variable is not configured');
    res.status(500).json({ error: 'Stripe not configured on server' });
    return;
  }

  let event: Stripe.Event;

  try {
    // Construct event using the raw request body Buffer
    event = stripe.webhooks.constructEvent(req.body, sig, stripeWebhookSecret);
  } catch (err: any) {
    logger.error(`[stripe-webhook] Signature verification failed: ${err.message}`);
    res.status(400).send(`Webhook Error: ${err.message}`);
    return;
  }

  logger.info(`[stripe-webhook] Received verified event: ${event.type} (${event.id})`);

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        const userId = session.client_reference_id || session.metadata?.userId || session.metadata?.user_id;
        const stripeCustomerId = typeof session.customer === 'string' ? session.customer : session.customer?.id;

        logger.info(`[stripe-webhook] Checkout completed for user=${userId}, customer=${stripeCustomerId}`);

        if (userId) {
          const { error } = await supabase
            .from('profiles')
            .update({
              subscription_tier: 'pro',
              stripe_customer_id: stripeCustomerId,
              updated_at: new Date().toISOString(),
            })
            .eq('id', userId);

          if (error) {
            logger.error(`[stripe-webhook] Failed to update profile for user ${userId}: ${error.message}`);
          }
        } else if (stripeCustomerId) {
          const { error } = await supabase
            .from('profiles')
            .update({
              subscription_tier: 'pro',
              updated_at: new Date().toISOString(),
            })
            .eq('stripe_customer_id', stripeCustomerId);

          if (error) {
            logger.error(`[stripe-webhook] Failed to update profile for customer ${stripeCustomerId}: ${error.message}`);
          }
        }
        break;
      }

      case 'customer.subscription.updated': {
        const subscription = event.data.object as Stripe.Subscription;
        const stripeCustomerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id;
        const userId = subscription.metadata?.userId || subscription.metadata?.user_id;
        const status = subscription.status;
        const tier = (status === 'active' || status === 'trialing') ? 'pro' : 'free';

        logger.info(`[stripe-webhook] Subscription updated for customer=${stripeCustomerId}, tier=${tier}`);

        let query = supabase.from('profiles').update({
          subscription_tier: tier,
          updated_at: new Date().toISOString(),
        });

        if (userId) {
          await query.eq('id', userId);
        } else if (stripeCustomerId) {
          await query.eq('stripe_customer_id', stripeCustomerId);
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object as Stripe.Subscription;
        const stripeCustomerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id;
        const userId = subscription.metadata?.userId || subscription.metadata?.user_id;

        logger.info(`[stripe-webhook] Subscription cancelled for customer=${stripeCustomerId}`);

        let query = supabase.from('profiles').update({
          subscription_tier: 'free',
          updated_at: new Date().toISOString(),
        });

        if (userId) {
          await query.eq('id', userId);
        } else if (stripeCustomerId) {
          await query.eq('stripe_customer_id', stripeCustomerId);
        }
        break;
      }

      default:
        logger.info(`[stripe-webhook] Unhandled event type: ${event.type}`);
    }

    res.status(200).json({ received: true });
  } catch (error: any) {
    logger.error(`[stripe-webhook] Error processing event ${event.type}: ${error.message}`);
    // Still return 200 to prevent Stripe infinite retries for application logic errors
    res.status(200).json({ received: true, error: error.message });
  }
});

export default router;
