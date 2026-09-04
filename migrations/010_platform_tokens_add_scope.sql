-- Migration: add scope column to platform_tokens.
-- Run once against the Supabase project via the SQL editor or CLI. Mark runs
-- this himself — it is NOT auto-applied on deploy. See
-- migrations/006_platform_tokens.sql for the base table.
--
-- Why: /content/tiktok-status needs to report which scopes are actually
-- attached to the stored token (never the token itself) so "reconnect with
-- video.upload" can be diagnosed without decoding a token by hand.

ALTER TABLE platform_tokens ADD COLUMN IF NOT EXISTS scope text;
