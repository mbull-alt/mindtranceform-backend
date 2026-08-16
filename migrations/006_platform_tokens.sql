-- Migration: platform_tokens — durable storage for rotating OAuth tokens
-- (Instagram, TikTok) used by the content_posts posting pipeline.
-- Run once against the Supabase project via the SQL editor or CLI.
--
-- Why this exists: Render env vars are static config — the running app
-- can't update them, so refreshed tokens need somewhere durable to live or
-- they're lost on the next deploy/restart. This table is that somewhere.
-- Seeded once from the IG_ACCESS_TOKEN / TIKTOK_ACCESS_TOKEN / etc. env vars
-- on first use, then self-maintains from there — see tokenStore.js.
--
-- Service-role-only, same convention as content_posts: RLS enabled, no
-- policies for anon/authenticated. These are live posting credentials,
-- must never be client-readable.

CREATE TABLE IF NOT EXISTS platform_tokens (
  platform                 text        PRIMARY KEY,
  access_token             text        NOT NULL,
  refresh_token            text,
  access_token_expires_at  timestamptz NOT NULL,
  refresh_token_expires_at timestamptz,
  updated_at                timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE platform_tokens ENABLE ROW LEVEL SECURITY;
-- No policies added on purpose — service-role client only. See note above.
