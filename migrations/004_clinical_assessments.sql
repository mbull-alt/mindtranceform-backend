-- Migration: validated clinical screening instruments (PHQ-9, GAD-7) + safety events.
-- Run once against the Supabase project via the SQL editor or CLI.
-- Both new tables ship with RLS enabled and owner-only policies — verify
-- in Supabase Advisor after applying (must show no new warnings).
--
-- Additive only: does not touch self_assessments, session_checkins, or any
-- existing table/column. The two tracks (non-clinical self_assessments and
-- these validated instruments) run side by side.
--
-- Deviation from the original spec: FKs reference auth.users(id), not
-- user_profiles(id) — user_profiles has no `id` column in this schema (its
-- PK is `user_id`, referencing auth.users(id)). This matches the exact
-- convention already used by session_checkins and self_assessments above.

-- ─── clinical_assessments ──────────────────────────────────────────────────────
-- One row per PHQ-9 or GAD-7 administration.
-- responses: {"q1": 0-3, ..., "q9": 0-3} — 9 items for phq9, 7 for gad7.
-- item9_flag: PHQ-9 only, true if q9 > 0 (self-harm screening item). NULL for gad7 rows.
CREATE TABLE IF NOT EXISTS clinical_assessments (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  instrument     text        NOT NULL CHECK (instrument IN ('phq9', 'gad7')),
  responses      jsonb       NOT NULL,
  total_score    int         NOT NULL,
  severity_band  text        NOT NULL,
  item9_flag     boolean,
  taken_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS clinical_assessments_user_idx ON clinical_assessments(user_id, instrument, taken_at);

ALTER TABLE clinical_assessments ENABLE ROW LEVEL SECURITY;
CREATE POLICY clinical_assessments_owner ON clinical_assessments
  USING  (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- ─── safety_response_events ────────────────────────────────────────────────────
-- Logs every time the PHQ-9 item-9 safety resources card was shown, so Mark can
-- confirm the flow actually fires in production. No automated escalation reads
-- this table — it exists purely for after-the-fact confirmation.
CREATE TABLE IF NOT EXISTS safety_response_events (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  assessment_id  uuid        NOT NULL REFERENCES clinical_assessments(id) ON DELETE CASCADE,
  shown_at       timestamptz NOT NULL DEFAULT now(),
  acknowledged   boolean     NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS safety_response_events_user_idx ON safety_response_events(user_id);

ALTER TABLE safety_response_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY safety_response_events_owner ON safety_response_events
  USING  (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
