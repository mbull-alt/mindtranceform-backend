#!/usr/bin/env node
// Usage: node scripts/grant-creator-access.js <email> [tier=pro] [cap=2] [days=90] [notes...]
// Example: node scripts/grant-creator-access.js dwayne@example.com pro 2 90 "Dwayne Jackson 7k TikTok"

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
    console.error("Usage: node scripts/grant-creator-access.js <email> [tier=pro] [cap=2] [days=90] [notes...]");
    process.exit(1);
  }

  const tier      = tierArg               || "pro";
  const deviceCap = parseInt(capArg  || "2",  10);
  const days      = parseInt(daysArg || "90", 10);
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
  console.log(`  Device cap : ${deviceCap}`);
  console.log(`  Expires    : ${expiresAt}`);
  if (notes) console.log(`  Notes      : ${notes}`);
}

main().catch(err => { console.error(err); process.exit(1); });
