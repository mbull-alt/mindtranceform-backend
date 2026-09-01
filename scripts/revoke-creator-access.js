#!/usr/bin/env node
// Usage: node scripts/revoke-creator-access.js <email>

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function main() {
  const [,, email] = process.argv;

  if (!email) {
    console.error("Usage: node scripts/revoke-creator-access.js <email>");
    process.exit(1);
  }

  const { data: profile, error: lookupErr } = await supabase
    .from("user_profiles")
    .select("user_id, email, creator_access_active")
    .eq("email", email)
    .single();

  if (lookupErr || !profile) {
    console.error(`No user profile found for ${email}.`);
    process.exit(1);
  }

  if (!profile.creator_access_active) {
    console.warn(`${email} does not have active creator access. Nothing to revoke.`);
    process.exit(0);
  }

  const { error: updateErr } = await supabase
    .from("user_profiles")
    .update({ creator_access_active: false })
    .eq("email", email);

  if (updateErr) {
    console.error("Failed to revoke access:", updateErr.message);
    process.exit(1);
  }

  // Mark all active devices as revoked so the cap resets cleanly
  await supabase
    .from("user_devices")
    .update({ revoked_at: new Date().toISOString() })
    .eq("user_id", profile.user_id)
    .is("revoked_at", null);

  await supabase.from("audit_log").insert({
    event:          "creator_access_revoked",
    actor_email:    process.env.ADMIN_EMAIL || "cli",
    target_user_id: profile.user_id,
    target_email:   email,
    details:        {},
  });

  console.log(`✓ Revoked creator access for ${email}`);
  console.log("  All active devices cleared.");
}

main().catch(err => { console.error(err); process.exit(1); });
