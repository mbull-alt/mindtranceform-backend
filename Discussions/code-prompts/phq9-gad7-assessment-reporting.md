# PHQ-9 / GAD-7 Assessment + Aggregate Reporting — paste to Claude Code

**What this is:** Replaces/extends the lightweight non-clinical self-assessment (`tracking-goals-feature.md`, 2026-07-09) with real, validated PHQ-9 (depression) and GAD-7 (anxiety) instruments, administered at baseline and periodically, plus an admin-only aggregated reporting endpoint that can answer the standard EAP metrics (`Discussions/code-prompts/eap-reporting-metrics-definitions.md`) honestly — including "member health improvement/outcomes" referenced against named validated assessments, which is what Lockton's Shortlister RFI (Q108) specifically asks for.

**Decision context (2026-07-17):** the prior rule — "do NOT name, cite, or reference any specific clinical instrument in user-facing copy" — is explicitly superseded for this feature. Mind Tranceform is deliberately moving from a non-clinical wellness framing to administering real validated screening instruments, to be competitive on EAP RFIs that name PHQ-9/GAD-7 directly. This is a real positioning shift — see "Before this ships" at the end, which is not optional.

**Save location:** `Discussions/code-prompts/phq9-gad7-assessment-reporting.md`

---

## Context Code should know before starting

- This supersedes Section 5 ("Self-assessment") of `tracking-goals-feature.md` and its "no named clinical instrument" rule. **Decided 2026-07-17: keep both.** The existing `self_assessments` table and 4-question non-clinical wellness check-in stay as-is, unchanged, for casual in-app engagement (post-session mood check, dashboard trend). The new `clinical_assessments` (PHQ-9/GAD-7) track below is additive, not a replacement — build it alongside the existing flow, don't touch or remove `self_assessments`.
- Existing tables to build on: `sessions` (`user_id`, `created_at`, `program`), `user_profiles` (`primary_goal_label`, `is_pro`/`is_entitled_to_pro`), `self_assessments` (non-clinical, see above).
- **RLS is a known weak spot in this codebase** (4 existing flagged holes — see PROJECT-STATE). Every new table here ships with RLS enabled and an owner-only policy from the start. This feature stores genuinely sensitive data (depression/anxiety screening scores, including a suicide-risk item) — there is zero tolerance for this shipping without verified RLS. Treat this as a harder requirement than the equivalent line in `tracking-goals-feature.md`.
- **Scope to authenticated users only**, same as the existing self-assessment feature. Not for guest sessions.
- No `employer_id`/`client_id` exists in the schema yet (see `eap-reporting-metrics-definitions.md`, "Schema gap" section). This PR does **not** add multi-tenant client scoping — the aggregate reporting endpoint below is platform-wide only, with a `TODO` marker for per-employer scoping once a real client relationship exists. Don't build speculative multi-tenancy now.

---

## 1. Schema

```sql
-- Validated clinical screening instruments, administered periodically.
CREATE TABLE clinical_assessments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
  instrument text NOT NULL CHECK (instrument IN ('phq9', 'gad7')),
  responses jsonb NOT NULL,        -- {"q1": 2, "q2": 1, ..., "q9": 0} — item count depends on instrument
  total_score int NOT NULL,        -- PHQ-9: 0-27, GAD-7: 0-21
  severity_band text NOT NULL,     -- see scoring tables below
  item9_flag boolean,              -- PHQ-9 only: true if q9 (self-harm item) > 0. NULL for gad7 rows.
  taken_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX clinical_assessments_user_idx ON clinical_assessments(user_id, instrument, taken_at);

ALTER TABLE clinical_assessments ENABLE ROW LEVEL SECURITY;
CREATE POLICY clinical_assessments_owner ON clinical_assessments
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- Log every time the item-9 safety response was shown, for audit purposes. No clinical action is taken
-- by the app itself (it has no clinician) — this table exists so Mark can confirm the safety flow actually
-- fires in production, not to enable any kind of intervention workflow.
CREATE TABLE safety_response_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
  assessment_id uuid NOT NULL REFERENCES clinical_assessments(id) ON DELETE CASCADE,
  shown_at timestamptz NOT NULL DEFAULT now(),
  acknowledged boolean NOT NULL DEFAULT false  -- true once user dismisses/interacts with the resources card
);

CREATE INDEX safety_response_events_user_idx ON safety_response_events(user_id);

ALTER TABLE safety_response_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY safety_response_events_owner ON safety_response_events
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
```

---

## 2. The instruments — exact item text (do not paraphrase)

Both are in the public domain for clinical/patient-care use, developed by Spitzer, Kroenke, Williams et al. with Pfizer support; standard citation line required on any screen displaying them (see below). Do not reword items — validity depends on exact wording.

**Stem for both:** "Over the last 2 weeks, how often have you been bothered by any of the following problems?"
**Answer scale for both:** Not at all (0) / Several days (1) / More than half the days (2) / Nearly every day (3)

### PHQ-9 (9 items, total 0-27)
1. Little interest or pleasure in doing things
2. Feeling down, depressed, or hopeless
3. Trouble falling or staying asleep, or sleeping too much
4. Feeling tired or having little energy
5. Poor appetite or overeating
6. Feeling bad about yourself — or that you are a failure, or have let yourself or your family down
7. Trouble concentrating on things, such as reading the newspaper or watching television
8. Moving or speaking so slowly that other people could have noticed — or the opposite, being so fidgety or restless that you have been moving around a lot more than usual
9. Thoughts that you would be better off dead, or of hurting yourself in some way

**Severity bands:** 0-4 minimal · 5-9 mild · 10-14 moderate · 15-19 moderately severe · 20-27 severe

### GAD-7 (7 items, total 0-21)
1. Feeling nervous, anxious, or on edge
2. Not being able to stop or control worrying
3. Worrying too much about different things
4. Trouble relaxing
5. Being so restless that it is hard to sit still
6. Becoming easily annoyed or irritable
7. Feeling afraid, as if something awful might happen

**Severity bands:** 0-4 minimal · 5-9 mild · 10-14 moderate · 15-21 severe

**Required attribution line, visible on the assessment screen (footer, small text is fine):**
"PHQ-9 and GAD-7 developed by Drs. Robert L. Spitzer, Janet B.W. Williams, Kurt Kroenke and colleagues, with an educational grant from Pfizer Inc. No permission required to reproduce, translate, display, or distribute."

---

## 3. Item 9 safety response — mandatory, non-negotiable, build first

PHQ-9 item 9 is a validated suicidal-ideation screening item. Mind Tranceform has **no clinician, no crisis-response staff, and no human in the loop** — administering this item without a real safety response is not acceptable and should block the rest of this feature until it's built and tested.

**Requirement:** any answer to item 9 greater than 0 ("Several days" or worse) must immediately, before the user can proceed past the assessment screen, show a **non-dismissible-by-accident** (require an explicit tap to close, not tap-outside) resources card:

```
We noticed your answer to the last question. If you're having thoughts of harming
yourself, you don't have to go through it alone.

988 Suicide & Crisis Lifeline — call or text 988, available 24/7
Crisis Text Line — text HOME to 741741

Mind Tranceform is a self-guided wellness tool, not a crisis service or a substitute
for professional care. If you're in immediate danger, please call 911 or go to your
nearest emergency room.

[ I understand ]
```

- This card is shown **regardless of overall PHQ-9 total score** — a low total with a nonzero item 9 still triggers it. Do not gate on total score.
- Write a `safety_response_events` row when the card is shown; set `acknowledged = true` when the user taps "I understand."
- The card must not block the user from otherwise using the app afterward — this is a safety resource, not a lockout. Don't add a cooldown, don't prevent future sessions.
- **Do not** attempt to build any kind of automated escalation, notification to Mark, welfare check, or intervention workflow — the app has no clinical staff to receive or act on such an alert responsibly, and a notification with no one qualified to respond is worse than no notification. The `safety_response_events` table is for Mark's own confirmation that the flow fires correctly in production (e.g., "did this ever trigger, and did the card actually render"), not an alerting system.
- Test this path explicitly (see Section 6) — this is the single most important test in this entire feature.

---

## 4. Individual assessment flow

- **Baseline:** offered once, at the same point the existing self-assessment currently offers its baseline (post-onboarding, first session generated) — both PHQ-9 and GAD-7 back-to-back, framed honestly: "This app uses two standard, validated wellness questionnaires (PHQ-9 and GAD-7) so you can track how you're doing over time. Takes about 2 minutes. You can skip this." Skippable, same as the existing self-assessment — do not make this mandatory.
- **Re-administration cadence:** every 14 days, same cadence as the existing self-assessment re-offer, via a dismissible banner on the dashboard. Do not administer more frequently than that — over-administering validated instruments degrades their meaning and annoys users.
- **Individual trend view:** on the user's own `/progress` dashboard, show a simple line/sparkline of `total_score` over time per instrument, labeled with the severity band, framed supportively ("Your GAD-7 score has trended down over the last 6 weeks" rather than clinical/diagnostic language). Do **not** auto-generate any interpretive claim beyond the standard severity band names above — no "you are improving because of X," no causal claims tied to app usage.
- Store raw item responses (`responses` jsonb) and `total_score` — both needed for the aggregate reporting endpoint below.

---

## 5. Admin-only aggregate reporting endpoint

New route, e.g. `GET /admin/reporting/metrics?start=&end=`, gated behind the existing `requireAdmin` middleware (same one used for the creator-access admin scripts — do not build a new auth mechanism). **Never expose this via the anon key or any user-facing route.**

Given the known RLS gaps already flagged in this codebase (PROJECT-STATE, 4 tables), this endpoint is an extra-sensitive surface — confirm `requireAdmin` is actually enforced server-side (not just hidden client-side) before considering this done.

Response shape, computed over the `start`/`end` window:

```json
{
  "total_identified": 0,           // total registered accounts in the window — see note below
  "total_participation": 0,        // accounts with >=1 session in the window
  "declined_participation": 0,     // accounts registered but zero sessions in the window
  "engagement_by_program": {       // "counseling/coaching" + "presenting issues" combined —
    "sleep": 0,                    // session counts per program, doubles as presenting-issue proxy
    "stress_anxiety": 0,
    "focus": 0
  },
  "outcomes": {
    "phq9": {
      "cohort_size": 0,            // number of users with >=2 phq9 assessments in the window
      "avg_score_change": null,    // avg(latest_score - baseline_score) across cohort_size; null if cohort_size < 10
      "avg_baseline_severity": null,
      "avg_latest_severity": null
    },
    "gad7": { "...": "same shape as phq9" }
  }
}
```

**Minimum cohort size = 10.** If fewer than 10 users have 2+ assessments of a given instrument in the window, return `null` for that instrument's outcome numbers rather than a real (re-identifiable) average. This is not optional — small-cohort averages can effectively expose an individual's score change. Same principle applies to `engagement_by_program` if you want to be extra safe, though session-count aggregates are lower-risk than score deltas; use judgment but default to suppressing any bucket under 10.

Note in the response or docs: `total_identified` is platform-wide, not employer-scoped, because there's no `employer_id` in the schema yet (see `eap-reporting-metrics-definitions.md`). Leave a `// TODO: scope by employer_id once multi-tenant client model exists` comment at the query site so this isn't forgotten.

---

## 6. Tests

Minimum required, in addition to anything carried over from `tracking-goals-feature.md`:

1. Submitting a PHQ-9 with item 9 = 0 does **not** trigger the safety card; `item9_flag` stored as `false`.
2. Submitting a PHQ-9 with item 9 = 1, 2, or 3 **does** trigger the safety card, regardless of total score (test specifically with a low total score + nonzero item 9, e.g., total 3 but item 9 = 1 — this must still fire). `item9_flag` stored as `true`, and a `safety_response_events` row is written.
3. Tapping "I understand" sets `acknowledged = true` on the safety event; the card cannot be dismissed by tapping outside it or backgrounding the app without acknowledgment (test that re-opening the app re-shows the card if not acknowledged).
4. `total_score` and `severity_band` computed correctly for both instruments across at least one case per severity band.
5. Aggregate endpoint: cohort of 9 users returns `null` outcome numbers; cohort of 10+ returns real numbers. Off-by-one test at exactly 10.
6. Aggregate endpoint rejects requests without valid admin auth (403/401, not just hidden data).
7. RLS: a user cannot read another user's `clinical_assessments` or `safety_response_events` rows.
8. None of this renders or is reachable for guest-mode sessions.
9. Re-administration banner appears at 14+ days since last assessment of a given instrument, not before.

---

## 7. RLS verification (mandatory)

Same as `tracking-goals-feature.md` Section 7 — confirm in the Supabase dashboard that both new tables show RLS enabled with an owner-only policy, screenshot the Advisor view, attach to the PR. This applies with extra weight here given the sensitivity of what's stored (depression/anxiety screening data including suicide-risk flags).

---

## Things NOT to do

- **Do NOT build any automated escalation, alerting, or notification** based on item 9 responses. No email to Mark, no admin dashboard flag on individual users, no "at-risk user" list. There is no one on the Mind Tranceform side qualified to receive or act on that safely — a broken promise of monitoring is worse than no monitoring. The resources card shown to the user IS the safety response; nothing further.
- **Do NOT reword or abbreviate the PHQ-9/GAD-7 item text.** Validity depends on exact wording; even minor rewording invalidates the instrument and the "validated assessment" claim becomes false.
- **Do NOT skip or soften the item 9 safety card** to reduce friction, "improve completion rates," or any other product-metric reason. This is the one place in the entire codebase where a product-metrics argument does not win.
- **Do NOT expose per-user assessment scores or item 9 flags through any endpoint reachable by the anon key or a non-admin authenticated user**, including indirectly (e.g., don't let the aggregate endpoint accept a filter narrow enough to isolate one user, like `user_id=X` — it should only ever return cohort aggregates).
- **Do NOT build employer/client scoping (`employer_id`) in this PR.** Flagged as a future gap, not built speculatively.
- **Do NOT increase assessment frequency beyond 14 days** to get more reporting data faster — this degrades instrument validity and user trust.

---

## Before this ships (product/legal, not code — flag to Mark, don't silently decide)

- This is a real shift from "non-clinical wellness app" to "app administering validated clinical screening instruments and reporting outcomes." The existing clinical disclaimer, ToS, and privacy policy (Termly-generated, per PROJECT-STATE) were written before this decision — they should be reviewed against what this feature actually does before it's live for real users, not just before it's demoed to Lockton.
- Consider whether administering PHQ-9 (with its suicide-risk item) to a general consumer population with zero clinical staff is something Mark wants a lawyer or telehealth-compliance read on before shipping, especially if actively marketed as a clinical-outcomes product to EAP buyers. Not this PR's job to resolve — just flagged clearly so it doesn't ship silently.
- The efficacy language already used in EAP term sheets (`Discussions/partnerships/eap-b2b-outreach.md`) references PHQ-9/GAD-7/PCL-5 as a conceptual efficacy framework — this feature is the first time the app would actually *administer* PHQ-9/GAD-7 rather than just cite them. Worth a pass over those term sheets once this ships, since the claim moves from "we measure against instruments like these" to "we use these specific instruments" — a stronger, more literal claim that should only be made once it's true in production.

## Report back with

- Migration file path + new tables
- Where the item-9 safety card component lives + confirmation of the non-dismissible-without-acknowledgment behavior
- Assessment screen route(s) + where the 14-day re-offer check lives
- Admin reporting endpoint path + confirmation `requireAdmin` is server-enforced
- Test file path + count of tests added, with explicit confirmation tests 1-3 (item 9 safety path) pass
- Confirmation RLS is enabled and policy-tested on both new tables, with Advisor screenshot
- Confirmation the existing `self_assessments` table/flow was left untouched and both tracks now run alongside each other on the dashboard
- Any place you had to deviate from this spec and why
