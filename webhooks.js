const express = require('express');
const router = express.Router();
const { trackEvent } = require('./posthog');

// ── Resend webhook ────────────────────────────────────────────────
// Add this URL in Resend dashboard > Webhooks:
//   https://your-backend-url.com/webhooks/resend
router.post('/resend', express.json(), async (req, res) => {
  const { type, data } = req.body;

  try {
    switch (type) {
      case 'email.bounced':
        console.log('[Resend] Bounced:', data.to);
        // TODO: mark email as invalid in Supabase
        // await supabase.from('users').update({ email_bounced: true }).eq('email', data.to)
        break;

      case 'email.complained':
        console.log('[Resend] Spam complaint:', data.to);
        // TODO: unsubscribe from marketing in Supabase
        // await supabase.from('users').update({ unsubscribed: true }).eq('email', data.to)
        break;

      case 'email.delivered':
        // Optional logging
        break;
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('[Resend webhook] Error:', err);
    res.status(500).json({ error: 'Webhook handler failed' });
  }
});

// ── Stripe webhook ────────────────────────────────────────────────
// Add this URL in Stripe dashboard > Webhooks:
//   https://your-backend-url.com/webhooks/stripe
// Subscribe to: checkout.session.completed
router.post('/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  const sig = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('[Stripe webhook] Invalid signature:', err.message);
    return res.status(400).json({ error: 'Invalid signature' });
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const userId = session.client_reference_id || session.customer_email || 'unknown';

    await trackEvent(userId, 'upgrade_completed', {
      plan: session.metadata?.plan || 'unknown',
      price: (session.amount_total || 0) / 100,
      currency: session.currency,
      source: 'stripe_webhook',
    });

    console.log('[Stripe] Upgrade tracked for:', userId);
  }

  res.json({ ok: true });
});

module.exports = router;