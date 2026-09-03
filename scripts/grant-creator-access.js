#!/usr/bin/env node
// Usage: node scripts/grant-creator-access.js <email> [tier=pro] [cap=5] [days=90] [notes...]
//
// cap accepts the literal string "none" to store NULL (uncapped) — that's
// the right value for org/clinic/pilot/partner grants (Atlanta Rehab, NGHS,
// Cohen, Headstrong, Boulder Crest, the AL/Young pilot): there's no support
// desk behind the device-cap 403, so a locked-out partner is a worse outcome
// than a comped partner sharing a login. Getting "none" requires typing it —
// omitting the argument defaults to a CAPPED grant of 5 (phone, tablet,
// laptop, replacement phone), reserved for influencer/creator accounts where
// sharing credentials is the actual risk. Uncapped is a deliberate choice,
// not the default you get by forgetting the argument.
//
// Examples:
//   node scripts/grant-creator-access.js someone@example.com pro none 365 "Atlanta Rehab pilot — uncapped"
//   node scripts/grant-creator-access.js creator@example.com pro 5 90 "influencer — capped"

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function main() {
  const [,, email, tierArg, capArg, daysArg, ...notesArr] = process.argv;

  if (!email) {
    console.error("Usage: node scripts/grant-creator-access.js <email> [tier=pro] [cap=5] [days=90] [notes...]");
    process.exit(1);
  }

  const tier = tierArg || "pro";
  // "none" (case-insensitive) -> null, uncapped. Omitted -> 5, capped (see
  // header comment for why the safe-by-default direction is capped, not
  // uncapped). Anything else parses as the cap value; garbage falls back to 5.
  let deviceCap;
  if (capArg && capArg.toLowerCase() === "none") {
    deviceCap = null;
  } else if (capArg) {
    const parsedCap = parseInt(capArg, 10);
    deviceCap = (!Number.isNaN(parsedCap) && parsedCap > 0) ? parsedCap : 5;
  } else {
    deviceCap = 5;
  }
  const days = parseInt(daysArg || "90", 10);
  const notes     = notesArr.join(" ")    || null;
  const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
  const grantedAt = new Date().toISOString();

  const { data: profile, error: lookupErr } = await supabase
    .from("user_profiles")
    .select("user_id, email")
    .eq("email", email)
    .single();

  if (lookupErr || !profile) {
    console.error(`No user profile found for ${email}. Has the user signed up?`);
    process.exit(1);
  }

  const { error: updateErr } = await supabase
    .from("user_profiles")
    .update({
      creator_access_tier:       tier,
      creator_access_active:     true,
      creator_access_granted_at: grantedAt,
      creator_access_expires_at: expiresAt,
      creator_access_device_cap: deviceCap,
      creator_access_notes:      notes,
    })
    .eq("email", email);

  if (updateErr) {
    console.error("Failed to grant access:", updateErr.message);
    process.exit(1);
  }

  await supabase.from("audit_log").insert({
    event:          "creator_access_granted",
    actor_email:    process.env.ADMIN_EMAIL || "cli",
    target_user_id: profile.user_id,
    target_email:   email,
    details:        { tier, deviceCap, expiresAt, days, notes },
  });

  console.log(`✓ Granted ${tier} creator access to ${email}`);
  if (deviceCap) {
    console.log(`  Device cap : ${deviceCap} devices`);
    console.log(`               Active creator grants enforce this at /auth/verify — a person signing in`);
    console.log(`               from more than ${deviceCap} device(s) in a 30-day window sees a 403 telling`);
    console.log(`               them to contact support. That warning is here because this exact behaviour`);
    console.log(`               caused the 2026-09-01 App Review 403, and nobody saw it coming.`);
  } else {
    console.log(`  Device cap : none (org/pilot grant)`);
  }
  console.log(`  Expires    : ${expiresAt}`);
  if (notes) console.log(`  Notes      : ${notes}`);
}

main().catch(err => { console.error(err); process.exit(1); });
