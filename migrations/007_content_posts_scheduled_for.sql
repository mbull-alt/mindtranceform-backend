-- Migration: add scheduled_for to content_posts.
-- Run once against the Supabase project via the SQL editor or CLI.
--
-- Nullable, default null — null means "post immediately on approval",
-- preserving existing behavior as the default for every row that doesn't
-- set it. When set to a future time, GET /content/approve/:token still
-- requires the click (the approval requirement is unchanged), but actual
-- posting is deferred: YouTube posts immediately with a native
-- status.publishAt (no cron needed for that platform specifically — see
-- NATIVE_SCHEDULE_SUPPORTED in contentPosting.js), everything else waits
-- for the scheduled-posts sweep to pick it up once scheduled_for arrives.

ALTER TABLE content_posts ADD COLUMN IF NOT EXISTS scheduled_for timestamptz;
