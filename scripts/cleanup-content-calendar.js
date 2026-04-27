/**
 * cleanup-content-calendar.js
 *
 * One-time script — run after disabling auto-content cron jobs.
 * Deletes brand-damaging AI-generated drafts from content_calendar.
 * Backfills the `source` column on surviving rows (run AFTER applying
 * migrations/add-source-column.sql in the Supabase SQL editor).
 *
 * Usage:
 *   node scripts/cleanup-content-calendar.js
 */

"use strict";

require("dotenv").config({ path: require("path").join(__dirname, "../.env") });
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function countRows(filters) {
  let q = supabase.from("content_calendar").select("id", { count: "exact", head: true });
  for (const [col, val] of Object.entries(filters)) {
    q = q.eq(col, val);
  }
  const { count, error } = await q;
  if (error) throw new Error(`count error: ${error.message}`);
  return count;
}

async function deleteRows(description, filters) {
  // Count first
  let countQ = supabase.from("content_calendar").select("id", { count: "exact", head: true });
  for (const [col, val] of Object.entries(filters)) countQ = countQ.eq(col, val);
  const { count } = await countQ;

  if (!count) {
    console.log(`  ${description}: 0 rows found — nothing to delete`);
    return 0;
  }

  let delQ = supabase.from("content_calendar").delete();
  for (const [col, val] of Object.entries(filters)) delQ = delQ.eq(col, val);
  const { error } = await delQ;
  if (error) throw new Error(`delete error (${description}): ${error.message}`);

  console.log(`  ${description}: deleted ${count} rows`);
  return count;
}

async function main() {
  console.log("\n=== content_calendar cleanup ===\n");

  // ── Pre-cleanup counts ──────────────────────────────────────────────────────
  console.log("Before:");
  const beforeReddit      = await countRows({ type: "reddit" });
  const beforeRedditReply = await countRows({ type: "reddit_reply" });
  const beforeTwitterDraft= await countRows({ type: "twitter", status: "draft" });
  const beforeTwReplyDraft= await countRows({ type: "twitter_reply", status: "draft" });
  const beforeTiktokDraft = await countRows({ type: "tiktok", status: "draft" });
  const beforeTotal       = await countRows({});
  console.log(`  reddit:        ${beforeReddit}`);
  console.log(`  reddit_reply:  ${beforeRedditReply}`);
  console.log(`  twitter draft: ${beforeTwitterDraft}`);
  console.log(`  tw_reply draft:${beforeTwReplyDraft}`);
  console.log(`  tiktok draft:  ${beforeTiktokDraft}`);
  console.log(`  TOTAL:         ${beforeTotal}\n`);

  // ── Deletions ───────────────────────────────────────────────────────────────
  console.log("Deleting:");
  const d1 = await deleteRows("reddit posts (all statuses)",       { type: "reddit" });
  const d2 = await deleteRows("reddit_reply drafts (outreach bot)",{ type: "reddit_reply", status: "draft" });
  const d3 = await deleteRows("twitter posts (status=draft)",      { type: "twitter", status: "draft" });
  const d4 = await deleteRows("twitter_reply drafts (eng. finder)",{ type: "twitter_reply", status: "draft" });
  const d5 = await deleteRows("tiktok scripts (status=draft)",     { type: "tiktok", status: "draft" });
  const totalDeleted = d1 + d2 + d3 + d4 + d5;

  // ── Post-cleanup counts ─────────────────────────────────────────────────────
  console.log("\nAfter:");
  const afterReddit = await countRows({ type: "reddit" });
  const afterTw     = await countRows({ type: "twitter", status: "draft" });
  const afterTiktok = await countRows({ type: "tiktok", status: "draft" });
  const afterTotal  = await countRows({});
  console.log(`  reddit remaining:        ${afterReddit} (expect 0)`);
  console.log(`  twitter draft remaining: ${afterTw}     (expect 0)`);
  console.log(`  tiktok draft remaining:  ${afterTiktok}  (expect 0)`);
  console.log(`  TOTAL remaining:         ${afterTotal}`);
  console.log(`\n  Rows deleted: ${totalDeleted}`);

  const ok = afterReddit === 0 && afterTw === 0 && afterTiktok === 0;
  console.log(`\n  Verification: ${ok ? "PASS ✓" : "FAIL — re-run or inspect manually"}`);

  // ── Source column backfill ──────────────────────────────────────────────────
  // Run AFTER applying migrations/add-source-column.sql in Supabase SQL editor.
  console.log("\n=== source column backfill ===");
  try {
    const { error: backfillErr } = await supabase
      .from("content_calendar")
      .update({ source: "auto" })
      .is("source", null);

    if (backfillErr) {
      if (backfillErr.message.includes("source")) {
        console.log("  source column not yet added — apply migrations/add-source-column.sql first, then re-run this script");
      } else {
        console.error("  backfill error:", backfillErr.message);
      }
    } else {
      console.log("  source backfill complete — all surviving rows set to 'auto'");
    }
  } catch (err) {
    console.log("  source column not yet added — apply migrations/add-source-column.sql first, then re-run this script");
  }

  console.log("\n=== done ===\n");
}

main().catch(err => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
