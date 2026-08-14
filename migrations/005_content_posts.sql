-- Migration: content_posts — approval-gated auto-posting pipeline for videos
-- produced by the trance-ads/ pipeline (see Discussions in that project for
-- the full spec). Run once against the Supabase project via the SQL editor
-- or CLI.
--
-- Service-role-only table: no owner column, nothing here belongs to an
-- end user. RLS is enabled with NO policies for anon/authenticated — the
-- backend only ever talks to this table via the service-role client
-- (supabase = createClient(url, SUPABASE_SERVICE_ROLE_KEY) in server.js),
-- which bypasses RLS by design. With RLS on and zero policies, anon/
-- authenticated roles get zero access. This is the same shape as the
-- service-role-only convention already used elsewhere in this schema.
--
-- approval_token is the auth for the two GET endpoints (/content/approve/:token,
-- /content/reject/:token) — there is no login for those, the token itself is
-- the credential, so it must be unguessable (32 random bytes, hex-encoded)
-- and is treated as effectively single-use because status moves off
-- 'pending' on first successful click.

CREATE TABLE IF NOT EXISTS content_posts (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  video_path         text        NOT NULL,
  script_slot        text        NOT NULL,
  platform_targets   text[]      NOT NULL DEFAULT '{}',
  caption            text        NOT NULL,
  hashtags           text        NOT NULL,
  cta                text        NOT NULL,
  status             text        NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','approved','rejected','posted','failed')),
  approval_token     text        NOT NULL UNIQUE,
  token_expires_at   timestamptz NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  approved_at        timestamptz,
  posted_at          timestamptz,
  platform_post_ids  jsonb,
  error              text
);

CREATE INDEX IF NOT EXISTS content_posts_status_idx ON content_posts (status);
CREATE INDEX IF NOT EXISTS content_posts_token_idx  ON content_posts (approval_token);

ALTER TABLE content_posts ENABLE ROW LEVEL SECURITY;
-- No policies added on purpose — service-role client only. See note above.
