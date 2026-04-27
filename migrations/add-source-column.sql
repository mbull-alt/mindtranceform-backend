-- Migration: add source column to content_calendar
-- Run this in the Supabase SQL editor (Dashboard → SQL Editor → New query).
-- After applying, re-run scripts/cleanup-content-calendar.js to backfill.

ALTER TABLE content_calendar
  ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'auto'
  CHECK (source IN ('auto', 'manual'));

-- Backfill any rows that were inserted before the default took effect
UPDATE content_calendar SET source = 'auto' WHERE source IS NULL;
