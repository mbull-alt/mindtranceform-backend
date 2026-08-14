#!/usr/bin/env node
// One-time setup: create the private "content-videos" Supabase Storage bucket
// used by the content_posts approval-gate pipeline. Safe to re-run — no-ops
// if the bucket already exists.
// Usage: node scripts/setup-content-posts-bucket.js

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const BUCKET = "content-videos";

async function main() {
  const { data: buckets, error } = await supabase.storage.listBuckets();
  if (error) {
    console.error("listBuckets failed:", error.message);
    process.exit(1);
  }

  if (buckets.some(b => b.name === BUCKET)) {
    console.log(`✓ Bucket "${BUCKET}" already exists — nothing to do.`);
    return;
  }

  const { error: createErr } = await supabase.storage.createBucket(BUCKET, {
    public: false, // signed URLs only — unreleased marketing videos, not for public/indexed access
    fileSizeLimit: "100MB",
    allowedMimeTypes: ["video/mp4"],
  });

  if (createErr) {
    console.error("createBucket failed:", createErr.message);
    process.exit(1);
  }

  console.log(`✓ Created private bucket "${BUCKET}" (100MB limit, video/mp4 only).`);
}

main().catch(err => { console.error(err); process.exit(1); });
