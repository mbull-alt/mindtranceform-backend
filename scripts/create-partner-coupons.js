/**
 * create-partner-coupons.js
 *
 * Creates Stripe coupons + customer-facing promotion codes for veteran-org
 * partnership pilots (CVN50 / HEADSTRONG50 / BOULDER50).
 *
 * Each coupon: 50% off, duration=once (first invoice only), per-partner cap.
 * Each promo code: first_time_transaction=true (enforces "new customer only").
 * No applies_to.products restriction — discount applies to whichever tier
 * (Premium $19.99 or Pro $29.99) the customer selects at checkout. Intentional.
 *
 * Usage:
 *   node scripts/create-partner-coupons.js                 # dry-run
 *   node scripts/create-partner-coupons.js --apply         # live run (sk_live_ key required)
 *   node scripts/create-partner-coupons.js --apply --test  # test run (sk_test_ key required)
 *   node scripts/create-partner-coupons.js --dry-run       # explicit dry-run
 *
 * Safety defaults:
 *   - Dry-run if --apply is not passed.
 *   - Dry-run if NODE_ENV !== 'production' and --apply is not explicitly passed.
 *   - Aborts if key mode (live/test) doesn't match --test flag.
 *   - Aborts if STRIPE_SECRET_KEY is missing.
 *   - Aborts if more than 2 active subscription products are found (no-applies_to risk).
 *
 * Idempotent: re-running prints 'exists' for already-created objects.
 * Drift detection: logs if max_redemptions in config differs from live coupon.
 * NOTE: Stripe does not allow updating max_redemptions on an existing coupon.
 *       If a cap needs changing, delete + recreate in Dashboard, then re-run.
 *
 * Caps are written into Discussions/partnerships/{partner}-pitch.md as hard limits.
 * Do not change these numbers without updating those files.
 */

"use strict";

require("dotenv").config({ path: require("path").join(__dirname, "../.env") });
const stripe = require("stripe");

// ── Partner config ─────────────────────────────────────────────────────────────

const PARTNER_COUPONS = [
  {
    partner: "Cohen Veterans Network",
    couponId: "cvn50",
    code: "CVN50",
    maxRedemptions: 250,
    description: "Cohen Veterans Network - 50% once",
  },
  {
    partner: "The Headstrong Project",
    couponId: "headstrong50",
    code: "HEADSTRONG50",
    maxRedemptions: 100,
    description: "Headstrong Project - 50% once",
  },
  {
    partner: "Boulder Crest Foundation",
    couponId: "boulder50",
    code: "BOULDER50",
    maxRedemptions: 150,
    description: "Boulder Crest Foundation - 50% once",
  },
];

// ── Arg parsing ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const flagApply  = args.includes("--apply");
const flagTest   = args.includes("--test");
const flagDryRun = args.includes("--dry-run");

// Dry-run if --apply was not explicitly passed, or if NODE_ENV !== production.
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

// ── Startup banner ─────────────────────────────────────────────────────────────

console.log(`Stripe mode: ${keyMode}`);
console.log(`Run mode:    ${isDryRun ? "DRY-RUN (no API calls)" : "APPLY"}`);
console.log();

// Safety: flag/key mode must agree.
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

// In dry-run, a sk_live_ key without --apply is fine — no calls are made.
// Warn so the user knows they're previewing against the live account's config.
if (isDryRun && keyMode === "LIVE") {
  console.log("NOTE: Dry-run with live key — no changes will be made.\n");
}

const stripeClient = stripe(STRIPE_SECRET_KEY);

// ── Product count guard ────────────────────────────────────────────────────────

async function checkSubscriptionProductCount() {
  const prices = await stripeClient.prices.list({ type: "recurring", active: true, limit: 100 });
  const productIds = [...new Set(prices.data.map((p) => p.product))];
  return productIds.length;
}

// ── Coupon helpers ─────────────────────────────────────────────────────────────

async function ensureCoupon(entry) {
  const payload = {
    id: entry.couponId,
    name: entry.description,
    percent_off: 50,
    duration: "once",
    max_redemptions: entry.maxRedemptions,
    metadata: {
      partner: entry.partner,
      pilot_id: entry.couponId,
      created_by_script: "scripts/create-partner-coupons.js",
      created_at: new Date().toISOString(),
    },
  };

  try {
    const coupon = await stripeClient.coupons.create(payload);
    return { status: "created", coupon };
  } catch (err) {
    if (err.code === "resource_already_exists") {
      const existing = await stripeClient.coupons.retrieve(entry.couponId);
      if (existing.max_redemptions !== entry.maxRedemptions) {
        return {
          status: "drift",
          coupon: existing,
          driftDetail: {
            field: "max_redemptions",
            live: existing.max_redemptions,
            config: entry.maxRedemptions,
          },
        };
      }
      return { status: "exists", coupon: existing };
    }
    throw err;
  }
}

// ── Promotion code helpers ─────────────────────────────────────────────────────

async function ensurePromoCode(entry) {
  // Promotion codes are looked up by code string, not by ID.
  const list = await stripeClient.promotionCodes.list({ code: entry.code, limit: 1 });
  if (list.data.length > 0) {
    return { status: "exists", promoCode: list.data[0] };
  }

  const promoCode = await stripeClient.promotionCodes.create({
    coupon: entry.couponId,
    code: entry.code,
    active: true,
    restrictions: {
      first_time_transaction: true,
    },
    metadata: {
      partner: entry.partner,
    },
  });
  return { status: "created", promoCode };
}

// ── Table formatting ───────────────────────────────────────────────────────────

function padEnd(str, n) {
  return String(str).padEnd(n);
}

function printResultTable(results, isDryRun, keyMode) {
  const modeLabel = isDryRun ? "dry-run" : `${keyMode.toLowerCase()} mode`;
  console.log(`\nStripe partner coupons — RESULT (${modeLabel})`);
  console.log("─".repeat(73));
  console.log(
    `${padEnd("Partner", 30)}${padEnd("Code", 16)}${padEnd("Cap", 7)}${padEnd("Coupon", 10)}PromoCode`
  );
  for (const r of results) {
    console.log(
      `${padEnd(r.partner, 30)}${padEnd(r.code, 16)}${padEnd(r.cap, 7)}${padEnd(r.coupon, 10)}${r.promoCode}`
    );
  }
  console.log("─".repeat(73));
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  // Product count guard (only when making real calls — dry-run skips).
  if (!isDryRun) {
    let productCount;
    try {
      productCount = await checkSubscriptionProductCount();
    } catch (err) {
      console.error(`ERROR checking subscription products: ${err.message}`);
      process.exit(1);
    }

    if (productCount > 2) {
      console.error(`STOP: Found ${productCount} active subscription products (expected ≤ 2).`);
      console.error("These coupons have no applies_to restriction and will discount ALL subscription products.");
      console.error("Either add applies_to restrictions to the coupon payloads, or confirm this is intentional.");
      console.error("Aborting — no coupons were created.");
      process.exit(1);
    }
    console.log(`Active subscription products: ${productCount} — OK\n`);
  }

  const tableRows = [];
  const driftWarnings = [];

  for (const entry of PARTNER_COUPONS) {
    console.log(`  Processing: ${entry.partner} (${entry.code})`);

    if (isDryRun) {
      console.log(`    [DRY-RUN] Would create coupon:     ${entry.couponId} — 50% off, once, cap ${entry.maxRedemptions}`);
      console.log(`    [DRY-RUN] Would create promo code: ${entry.code} — first_time_transaction=true`);
      tableRows.push({ partner: entry.partner, code: entry.code, cap: entry.maxRedemptions, coupon: "dry-run", promoCode: "dry-run" });
      continue;
    }

    let couponStatus, promoStatus;

    // Coupon
    try {
      const couponResult = await ensureCoupon(entry);
      couponStatus = couponResult.status;
      if (couponResult.status === "drift") {
        driftWarnings.push({ ...entry, drift: couponResult.driftDetail });
        console.log(`    DRIFT: coupon ${entry.couponId} exists but max_redemptions differs (live=${couponResult.driftDetail.live}, config=${couponResult.driftDetail.config})`);
      } else {
        console.log(`    Coupon: ${couponResult.status}`);
      }
    } catch (err) {
      console.error(`    ERROR on coupon ${entry.couponId}: ${err.message}`);
      process.exit(1);
    }

    // Promotion code
    try {
      const promoResult = await ensurePromoCode(entry);
      promoStatus = promoResult.status;
      console.log(`    Promo code: ${promoResult.status}`);
    } catch (err) {
      console.error(`    ERROR on promo code ${entry.code}: ${err.message}`);
      process.exit(1);
    }

    tableRows.push({ partner: entry.partner, code: entry.code, cap: entry.maxRedemptions, coupon: couponStatus, promoCode: promoStatus });
  }

  printResultTable(tableRows, isDryRun, keyMode);

  if (driftWarnings.length > 0) {
    console.log("\nDRIFT WARNINGS:");
    console.log("─".repeat(73));
    for (const w of driftWarnings) {
      console.log(`Partner:  ${w.partner}`);
      console.log(`Coupon:   ${w.couponId}`);
      console.log(`Field:    ${w.drift.field}`);
      console.log(`Live:     ${w.drift.live}`);
      console.log(`Config:   ${w.drift.config}`);
      console.log();
      console.log("ACTION REQUIRED: Stripe does not allow updating max_redemptions on an existing coupon.");
      console.log("To fix: Dashboard → Coupons → delete the coupon → re-run this script with --apply.");
      console.log("WARNING: Deleting a coupon invalidates any promotion codes attached to it.");
      console.log("You will need to recreate the promotion code as well (the script does this automatically).");
      console.log("─".repeat(73));
    }
  } else {
    console.log("Drift flagged: none");
  }
}

main().catch((err) => {
  console.error(`Unhandled error: ${err.message}`);
  process.exit(1);
});
