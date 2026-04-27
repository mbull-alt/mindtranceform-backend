const { PostHog } = require('posthog-node');

const posthog = new PostHog(process.env.POSTHOG_API_KEY, {
  host: 'https://app.posthog.com',
  flushAt: 1,       // send immediately (important for serverless/short-lived processes)
  flushInterval: 0,
});

// Track server-side events (e.g. from Stripe webhooks, Supabase triggers)
async function trackEvent(userId, event, properties = {}) {
  posthog.capture({
    distinctId: userId,
    event,
    properties,
  });
  await posthog.flush();
}

module.exports = { posthog, trackEvent };