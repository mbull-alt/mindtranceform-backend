-- Migration: tracking, goals, and self-assessment tables
-- Run once against the Supabase project via the SQL editor or CLI.
-- Both new tables ship with RLS enabled and owner-only policies — verify
-- in Supabase Advisor after applying (must show no new warnings).

-- ─── session_checkins ─────────────────────────────────────────────────────────
-- One optional row per session. Rating 1–5; skipping leaves no row.
CREATE TABLE IF NOT EXISTS session_checkins (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id text        NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  user_id    uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  rating     int         NOT NULL CHECK (rating BETWEEN 1 AND 5),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id)  -- one check-in per session; upsert-safe
);

CREATE INDEX IF NOT EXISTS session_checkins_user_idx ON session_checkins(user_id, created_at);

ALTER TABLE session_checkins ENABLE ROW LEVEL SECURITY;
CREATE POLICY session_checkins_owner ON session_checkins
  USING  (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- ─── self_assessments ─────────────────────────────────────────────────────────
-- One row per non-clinical wellness check-in event.
-- assessment_type: 'sleep' | 'anxiety' | 'general'
-- responses: raw per-question answers, e.g. {"q1": 2, "q2": 1, "q3": 3, "q4": 2}
-- score: simple sum of q1–q4 (range 0–12, higher = better)
CREATE TABLE IF NOT EXISTS self_assessments (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  assessment_type text        NOT NULL,
  responses       jsonb       NOT NULL,
  score           int         NOT NULL,
  taken_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS self_assessments_user_idx ON self_assessments(user_id, taken_at);

ALTER TABLE self_assessments ENABLE ROW LEVEL SECURITY;
CREATE POLICY self_assessments_owner ON self_assessments
  USING  (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- ─── user_profiles: goal label ────────────────────────────────────────────────
-- Defaults from program choice on first session; user-editable via PUT /user/goal.
-- Inherits the existing user_profiles RLS policy automatically (table-level RLS,
-- no column-level policies needed).
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS primary_goal_label text;
