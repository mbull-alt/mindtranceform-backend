/**
 * create-annual-prices.js
 *
 * Creates the two annual subscription Prices ($149.99/yr Premium, $299.99/yr Pro)
 * on the EXISTING Premium/Pro products, as a second billing interval alongside the
 * monthly prices — not new products, not new SKUs.
 *
 * NOTE: as of 2026-07-09 these two Prices already exist in the live Stripe account,
 * created directly via the Stripe MCP connector rather than this script:
 *   Premium annual: price_1Trjhu20DZybuAfdynOedTqC (product prod_UIKPw9Hat4HItE)
 *   Pro annual:      price_1Trji020DZybuAfd9zBo0xk1 (product prod_UIKPcA0IKBDjVy)
 * Running this script against that same account should print "exists" for both —
 * it's kept for reproducibility (a fresh Stripe account / test mode / disaster
 * recovery), not because it needs to run again here. See
 * Discussions/code-prompts/annual-pricing-stripe-live.md.
 *
 * Usage:
 *   node scripts/create-annual-prices.js                 # dry-run
 *   node scripts/create-annual-prices.js --apply         # live run (sk_live_ key required)
 *   node scripts/create-annual-prices.js --apply --test  # test run (sk_test_ key required)
 *   node scripts/create-annual-prices.js --dry-run       # explicit dry-run
 *
 * Safety defaults (same pattern as create-partner-coupons.js):
 *   - Dry-run if --apply is not passed.
 *   - Dry-run if NODE_ENV !== 'production' and --apply is not explicitly passed.
 *   - Aborts if key mode (live/test) doesn't match --test flag.
 *   - Aborts if STRIPE_SECRET_KEY is missing.
 *
 * Product resolution: looks up each existing product by name (case-insensitive
 * match on "Premium" / "Pro") rather than a hardcoded product ID — if zero or
 * more than one product matches a name, aborts and asks for a name/ID instead of
 * guessing which product is which.
 *
 * Idempotency: Prices are immutable once created (amount can't be edited), so this
 * never "updates" a price. Before creating, lists existing recurring/year prices on
 * the resolved product:
 *   - A price with the same unit_amount already exists -> status 'exists', skip.
 *   - A DIFFERENT annual price already exists on the product -> status 'drift',
 *     flagged and NOT auto-resolved (a product should have exactly one active
 *     annual price at a time — deciding which one wins is a product call, not a
 *     script call).
 *   - Otherwise -> create.
 */

"use strict";

require("dotenv").config({ path: require("path").join(__dirname, "../.env") });
const stripe = require("stripe");

// ── Config ──────────────────────────────────────────────────────────────────────

const ANNUAL_PRICES = [
  {
    tier: "Premium",
    productLookup: "Premium",
    unitAmount: 14999, // $149.99 in cents
    currency: "usd",
    interval: "year",
    nickname: "Premium — Annual (limited time)",
  },
  {
    tier: "Pro",
    productLookup: "Pro",
    unitAmount: 29999, // $299.99 in cents
    currency: "usd",
    interval: "year",
    nickname: "Pro — Annual (limited time)",
  },
];

// ── Arg parsing ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const flagApply  = args.includes("--apply");
const flagTest   = args.includes("--test");
const flagDryRun = args.includes("--dry-run");

const isDryRun = flagDryRun || !flagApply || process.env.NODE_ENV !== "production";

// ── Key validation ─────────────────────────────────────────────────────────────

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;

if (!STRIPE_SECRET_KEY) {
  console.error("ERROR: STRIPE_SECRET_KEY is not set.");
  console.error("Set it in .env or export it in your shell before running.");
  process.exit(1);
}

let keyMode;
if (STRIPE_SECRET_KEY.startsWith("sk_live_")) {
  keyMode = "LIVE";
} else if (STRIPE_SECRET_KEY.startsWith("sk_test_")) {
  keyMode = "TEST";
} else {
  console.error("ERROR: STRIPE_SECRET_KEY does not start with sk_live_ or sk_test_.");
  console.error("Cannot determine mode. Check the key.");
  process.exit(1);
}

console.log(`Stripe mode: ${keyMode}`);
console.log(`Run mode:    ${isDryRun ? "DRY-RUN (no API calls)" : "APPLY"}`);
console.log();

if (keyMode === "LIVE" && flagTest) {
  console.error("ERROR: Key is sk_live_ but --test flag was passed.");
  console.error("Remove --test, or switch to a sk_test_ key.");
  process.exit(1);
}
if (keyMode === "TEST" && !flagTest) {
  console.error("ERROR: Key is sk_test_ but --test was not passed.");
  console.error("Add --test to confirm test-mode intent, or switch to a sk_live_ key.");
  process.exit(1);
}

if (isDryRun && keyMode === "LIVE") {
  console.log("NOTE: Dry-run with live key — no changes will be made, but product lookups below reflect the real live account.\n");
}

const stripeClient = stripe(STRIPE_SECRET_KEY);

// ── Product resolution ─────────────────────────────────────────────────────────

async function resolveProduct(nameQuery) {
  const products = await stripeClient.products.list({ active: true, limit: 100 });
  const matches = products.data.filter(
    (p) => p.name.trim().toLowerCase() === nameQuery.trim().toLowerCase()
  );
  if (matches.length === 0) {
    throw new Error(`No active product found with name "${nameQuery}". Stop and confirm the product name/ID with Mark rather than guessing.`);
  }
  if (matches.length > 1) {
    throw new Error(`Found ${matches.length} active products named "${nameQuery}" (ids: ${matches.map((p) => p.id).join(", ")}). Ambiguous — stop and confirm which one.`);
  }
  return matches[0];
}

// ── Price ensure (idempotent + drift-checked) ──────────────────────────────────

async function ensureAnnualPrice(entry, productId) {
  const existing = await stripeClient.prices.list({ product: productId, active: true, limit: 100 });
  const annualPrices = existing.data.filter((p) => p.recurring?.interval === entry.interval);

  const match = annualPrices.find((p) => p.unit_amount === entry.unitAmount);
  if (match) return { status: "exists", price: match };

  const drift = annualPrices.find((p) => p.unit_amount !== entry.unitAmount);
  if (drift) {
    return {
      status: "drift",
      price: drift,
      driftDetail: { field: "unit_amount", live: drift.unit_amount, config: entry.unitAmount },
    };
  }

  const price = await stripeClient.prices.create({
    product: productId,
    unit_amount: entry.unitAmount,
    currency: entry.currency,
    recurring: { interval: entry.interval },
    nickname: entry.nickname,
    metadata: {
      tier: entry.tier,
      billing: "annual",
      decided_date: "2026-06-19",
      created_by_script: "scripts/create-annual-prices.js",
    },
  });
  return { status: "created", price };
}

// ── Table formatting ───────────────────────────────────────────────────────────

function padEnd(str, n) {
  return String(str).padEnd(n);
}

function printResultTable(results) {
  console.log("\nAnnual prices — RESULT");
  console.log("─".repeat(90));
  console.log(`${padEnd("Tier", 10)}${padEnd("Product", 24)}${padEnd("Status", 10)}Price ID`);
  for (const r of results) {
    console.log(`${padEnd(r.tier, 10)}${padEnd(r.productId, 24)}${padEnd(r.status, 10)}${r.priceId}`);
  }
  console.log("─".repeat(90));
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  const results = [];
  const driftWarnings = [];

  for (const entry of ANNUAL_PRICES) {
    console.log(`  Processing: ${entry.tier} ($${(entry.unitAmount / 100).toFixed(2)}/${entry.interval})`);

    let product;
    try {
      product = await resolveProduct(entry.productLookup);
      console.log(`    Product resolved: ${product.name} (${product.id})`);
    } catch (err) {
      console.error(`    ERROR: ${err.message}`);
      process.exit(1);
    }

    if (isDryRun) {
      console.log(`    [DRY-RUN] Would ensure annual price on ${product.id}: $${(entry.unitAmount / 100).toFixed(2)}/${entry.interval}`);
      results.push({ tier: entry.tier, productId: product.id, status: "dry-run", priceId: "dry-run" });
      continue;
    }

    try {
      const result = await ensureAnnualPrice(entry, product.id);
      if (result.status === "drift") {
        driftWarnings.push({ ...entry, productId: product.id, drift: result.driftDetail, existingPriceId: result.price.id });
        console.log(`    DRIFT: a different annual price (${result.price.id}) already exists on ${product.id} — live=$${(result.driftDetail.live / 100).toFixed(2)}, config=$${(result.driftDetail.config / 100).toFixed(2)}`);
      } else {
        console.log(`    Price: ${result.status} — ${result.price.id}`);
      }
      results.push({ tier: entry.tier, productId: product.id, status: result.status, priceId: result.price.id });
    } catch (err) {
      console.error(`    ERROR ensuring price: ${err.message}`);
      process.exit(1);
    }
  }

  printResultTable(results);

  if (driftWarnings.length > 0) {
    console.log("\nDRIFT WARNINGS:");
    console.log("─".repeat(90));
    for (const w of driftWarnings) {
      console.log(`Tier:      ${w.tier}`);
      console.log(`Product:   ${w.productId}`);
      console.log(`Existing:  ${w.existingPriceId} ($${(w.drift.live / 100).toFixed(2)}/${w.interval})`);
      console.log(`Config:    $${(w.drift.config / 100).toFixed(2)}/${w.interval}`);
      console.log();
      console.log("ACTION REQUIRED: a product should have exactly one active annual price.");
      console.log("Decide which one is correct, archive the other in the Stripe Dashboard, and re-run.");
      console.log("Do NOT create a second annual price on the same product.");
      console.log("─".repeat(90));
    }
  } else if (!isDryRun) {
    console.log("Drift flagged: none");
  }
}

main().catch((err) => {
  console.error(`Unhandled error: ${err.message}`);
  process.exit(1);
});
