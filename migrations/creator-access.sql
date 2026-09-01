-- Creator Access Migration
-- Run in Supabase SQL editor.

-- ─── user_profiles: creator access columns ───────────────────────────────────
ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS creator_access_tier       TEXT,
  ADD COLUMN IF NOT EXISTS creator_access_active     BOOLEAN     DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS creator_access_granted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS creator_access_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS creator_access_device_cap INTEGER     DEFAULT 2,
  ADD COLUMN IF NOT EXISTS creator_access_notes      TEXT;

-- ─── user_devices: active device tracking for creator accounts ───────────────
CREATE TABLE IF NOT EXISTS user_devices (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  fingerprint  TEXT        NOT NULL,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ DEFAULT NOW(),
  revoked_at   TIMESTAMPTZ,
  UNIQUE(user_id, fingerprint)
);

CREATE INDEX IF NOT EXISTS user_devices_user_id_idx   ON user_devices(user_id);
CREATE INDEX IF NOT EXISTS user_devices_last_seen_idx ON user_devices(last_seen_at);

-- ─── audit_log: grant / revoke event history ─────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_log (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  event          TEXT        NOT NULL,
  actor_email    TEXT,
  target_user_id UUID,
  target_email   TEXT,
  details        JSONB       DEFAULT '{}',
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS audit_log_target_user_idx ON audit_log(target_user_id);
CREATE INDEX IF NOT EXISTS audit_log_created_at_idx  ON audit_log(created_at DESC);
