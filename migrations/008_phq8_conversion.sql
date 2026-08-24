-- Migration: PHQ-9 -> PHQ-8 conversion, reporting-continuity backfill, and
-- historical item-9 purge.
-- Run once against the Supabase project via the SQL editor or CLI. Mark runs
-- this himself — it is NOT auto-applied on deploy.
--
-- See Discussions/code-prompts/phq8-conversion-crisis-card-item9-purge.md for
-- full rationale. Summary: PHQ-9 item 9 (the suicidal-ideation item) is
-- removed from the app going forward. New assessment rows use instrument =
-- 'phq8' (PHQ-9 with item 9 omitted, r = 0.998 correlation with PHQ-9 totals
-- per Kroenke et al. 2009). Historical phq9 rows keep their true
-- 'phq9' label, total_score, and severity_band — none of that is rewritten,
-- since doing so would destroy the audit trail of what was actually
-- administered.
--
-- Ordering inside this file is load-bearing and intentional:
--   1. Widen the instrument CHECK constraint to allow 'phq8' (additive; 'phq9'
--      stays valid for the historical rows that keep it).
--   2. Add phq8_equivalent_score and BACK-FILL it for existing phq9 rows by
--      summing q1-q8 from their stored responses. This must happen before
--      step 3, because step 3 is about to delete q9 from those same
--      responses — backfilling after the purge would have nothing left to
--      sum q9 out of, but more importantly nothing to compute q1-q8 from
--      if this were reordered incorrectly. Do the backfill FIRST.
--   3. Purge: strip q9 from responses for phq9 rows, and null out
--      item9_flag everywhere. This is data minimization — the app holds
--      suicide-risk data it has no clinical ability to act on, which is
--      pure downside (raises breach severity, serves no product purpose).
--
-- Explicitly wrapped in a transaction (unlike this project's earlier
-- migrations) because of that ordering dependency: if anything in here
-- fails partway, a half-applied state (e.g. purge without backfill) is
-- worse than the migration simply not having run at all.
--
-- What this migration deliberately does NOT do:
--   - Does NOT drop the item9_flag column. That is a separate follow-up
--     migration, once Mark has confirmed nothing reads it in production.
--     Dropping a column and scrubbing data in the same migration makes the
--     rollback story much worse if something breaks.
--   - Does NOT touch safety_response_events (table or rows) in any way.
--     That table is an audit trail showing the app DID show crisis
--     resources when it detected a positive item-9 response, before item 9
--     existed. Deleting records of safety actions taken is the kind of
--     thing that looks bad in hindsight in a way that keeping them never
--     does. The app's code no longer writes new rows to it (the trigger
--     that wrote to it no longer exists, now that item 9 is gone), but the
--     table and its existing rows stay exactly as they are. If this table
--     should ever be purged too, that's a decision for a lawyer's read,
--     not a code/migration cleanup — see the source doc.

BEGIN;

-- ── 1. Widen instrument CHECK constraint ────────────────────────────────────
-- Additive: 'phq9' stays valid (historical rows are genuinely PHQ-9
-- administrations and must keep that true label). 'phq8' is the new
-- current-state value; server.js only ever inserts 'phq8' or 'gad7' going
-- forward — see lib/clinicalAssessments.js.
ALTER TABLE clinical_assessments DROP CONSTRAINT IF EXISTS clinical_assessments_instrument_check;
ALTER TABLE clinical_assessments ADD CONSTRAINT clinical_assessments_instrument_check
  CHECK (instrument IN ('phq9', 'phq8', 'gad7'));

-- ── 2. phq8_equivalent_score + backfill (BEFORE the purge below) ───────────
-- Lets trend/aggregate reporting compare pre- and post-conversion PHQ scores
-- on the same 0-24 scale without a phantom step change at the switch date.
-- New phq8 rows get this populated at insert time by the app (equal to
-- total_score); this migration only needs to backfill the historical phq9
-- rows, by summing q1-q8 out of their still-intact responses jsonb.
ALTER TABLE clinical_assessments ADD COLUMN IF NOT EXISTS phq8_equivalent_score int;

UPDATE clinical_assessments
   SET phq8_equivalent_score =
         COALESCE((responses->>'q1')::int, 0) + COALESCE((responses->>'q2')::int, 0) +
         COALESCE((responses->>'q3')::int, 0) + COALESCE((responses->>'q4')::int, 0) +
         COALESCE((responses->>'q5')::int, 0) + COALESCE((responses->>'q6')::int, 0) +
         COALESCE((responses->>'q7')::int, 0) + COALESCE((responses->>'q8')::int, 0)
 WHERE instrument = 'phq9'
   AND phq8_equivalent_score IS NULL;

-- Defensive/idempotent only — no phq8 rows should exist before step 1 above
-- ran in this same transaction, but if this migration is ever re-run after
-- new phq8 rows already exist with a null equivalent for some reason, this
-- keeps it a no-op rather than leaving them stale.
UPDATE clinical_assessments
   SET phq8_equivalent_score = total_score
 WHERE instrument = 'phq8'
   AND phq8_equivalent_score IS NULL;

-- ── 3. Historical item-9 purge (AFTER the backfill above) ──────────────────
-- Strip q9 out of stored responses for phq9 rows — the backfill above has
-- already read everything it needs from responses, so this is safe now.
UPDATE clinical_assessments
   SET responses = responses - 'q9'
 WHERE instrument = 'phq9'
   AND responses ? 'q9';

-- Null the flag everywhere (phq9 rows only ever had this set; phq8/gad7 rows
-- already insert it as null, but this covers any pre-existing row cleanly).
UPDATE clinical_assessments
   SET item9_flag = null
 WHERE item9_flag IS NOT NULL;

-- safety_response_events: deliberately untouched. See file header.

COMMIT;
