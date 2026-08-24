# PHQ-8 conversion + always-on crisis resources card + item-9 purge — paste to Claude Code

**What this is:** Removes PHQ-9 item 9 (the suicidal-ideation item) from Mind Tranceform entirely, replacing the instrument with the PHQ-8; replaces the triggered item-9 safety card with an always-available crisis resources page; and scrubs historical item-9 data the app has no clinical use for.

**Save location:** `Discussions/code-prompts/phq8-conversion-crisis-card-item9-purge.md`

**Supersedes:** Section 3 ("Item 9 safety response") of `Discussions/code-prompts/phq9-gad7-assessment-reporting.md`. That section was correct for a product that administers item 9. This one removes the item, so the triggered card it mandated no longer has a trigger. Everything else in that file — GAD-7, the 14-day re-offer, the aggregate reporting endpoint, the admin auth rules, the RLS requirements — stays in force unchanged.

**Decision context (2026-08-21):** PHQ-9 was added because EAP/broker buyers on Shortlister ask about validated instruments by name. Item 9 was never specifically requested by anyone. Administering a validated suicidal-ideation screener in a consumer app with no clinician, no crisis staff, and no human in the loop is exposure with no corresponding benefit — the app cannot act on a positive response, and a positive response is exactly the case where acting matters.

The PHQ-8 is the PHQ-9 with item 9 omitted. It is a real, published, validated instrument (Kroenke, Strine, Spitzer, Williams, Berry & Mokdad, *Journal of Affective Disorders*, 2009), used in general-population research specifically because researchers frequently cannot intervene with participants who disclose suicidal ideation. PHQ-8 and PHQ-9 total scores correlate at r = 0.998. The same ≥10 cutoff for probable major depression applies. So the RFI claim ("we administer validated depression and anxiety screening") survives essentially intact, and the liability goes away.

## Context Code should know before starting

- Repos: `mbull-alt/mindtranceform-app` (React/Vite frontend), `mbull-alt/mindtranceform-backend` (Node `server.js`). There are three divergent local clones of the backend — the one in sync with `origin/main` is `C:\Users\brahm\OneDrive\Desktop\mindtranceform-backend`. Confirm sync state before editing anything.
- Migrations are not auto-applied on deploy. They are run by hand in the Supabase SQL editor. Write the migration file following the existing numbered convention in `migrations/`, but do not assume it has run. Mark runs it himself.
- Existing schema (from `phq9-gad7-assessment-reporting.md`):
  ```sql
  clinical_assessments (
    id, user_id,
    instrument text CHECK (instrument IN ('phq9','gad7')),
    responses jsonb,        -- {"q1": 2, ..., "q9": 0}
    total_score int,
    severity_band text,
    item9_flag boolean,     -- PHQ-9 only
    taken_at timestamptz
  )
  safety_response_events (id, user_id, ..., acknowledged, ...)
  ```
  Note `responses` stores per-item values including `q9` — so scrubbing `item9_flag` alone does not remove the item-9 data. See Section 4.
- There is a documented history in this project of a feature being reported "fully live" when its migration had never actually been applied (the `clinical_assessments` table itself, July 2026). Verify database state empirically; do not trust code-reading or prior notes.

## 0. Verify current production state FIRST — do not skip, do not change code yet

Before touching anything, establish what is actually live. The right fix differs depending on the answer, and this is cheap.

In Supabase, run:
```sql
   select to_regclass('public.clinical_assessments'),
          to_regclass('public.safety_response_events');

   select count(*) as total,
          count(*) filter (where instrument = 'phq9') as phq9_rows,
          count(*) filter (where item9_flag is true)  as item9_positive
   from clinical_assessments;

   select count(*) as safety_events,
          count(*) filter (where acknowledged) as acknowledged
   from safety_response_events;
```
Read the frontend assessment component and confirm whether the item-9 safety card is actually wired and rendering, or whether it was specified but never built.

Report these numbers back before making changes. Specifically flag if `item9_positive > 0` while `safety_events = 0` — that would mean users disclosed suicidal ideation and were shown nothing, which changes the urgency of everything below and needs to be surfaced to Mark immediately rather than quietly fixed.

## 1. Instrument conversion: PHQ-9 → PHQ-8

Item text: do not reword, reorder, or abbreviate the eight remaining items. Instrument validity depends on exact wording; any rewrite makes the "validated instrument" claim false. The only change is that item 9 is deleted.

- Remove item 9 from the PHQ item array and from the assessment UI.
- Add `'phq8'` to the instrument CHECK constraint. Do not remove `'phq9'` — historical rows are genuinely PHQ-9 and must keep their true label. New rows are `'phq8'`.
- Scoring: sum of the 8 items, range 0–24 (PHQ-9 was 0–27).
- Severity bands (PHQ-8, same cutoffs as PHQ-9 except the top band is truncated by the shorter range):

  | Score | Band |
  |---|---|
  | 0–4 | none/minimal |
  | 5–9 | mild |
  | 10–14 | moderate |
  | 15–19 | moderately severe |
  | 20–24 | severe |

  ≥10 remains the threshold for probable major depression. Any place in the code or reporting that hardcodes `27` as the PHQ maximum must be found and updated — grep for `27` near assessment logic.
- `item9_flag` is never written for new rows. Leave the column in place for now (Section 4 handles it).
- GAD-7 is untouched. It has no equivalent item.
- Keep the 14-day re-offer logic exactly as-is.

**Reporting continuity — real problem, handle it deliberately.** Historical PHQ-9 totals (0–27) and new PHQ-8 totals (0–24) are not directly comparable, so any trend chart or aggregate endpoint spanning the switch date will show a phantom step change.

Because `responses` stores per-item values, this is fixable: backfill a comparable PHQ-8 score for historical PHQ-9 rows by summing q1–q8, and have all trend/aggregate reporting use that comparable score rather than raw `total_score`. Add a `phq8_equivalent_score int` column, populate it for existing `phq9` rows in the same migration, and populate it equal to `total_score` for new `phq8` rows.

⚠️ Ordering matters: this backfill reads `responses`, so it must run before the Section 4 purge scrubs anything. Do both in one migration, backfill first.

## 2. Always-on crisis resources page

Replace the triggered card with a persistent, always-reachable resources page. Rationale: the trigger is gone, but users in distress still use a sleep-and-anxiety app, and a findable resource costs nothing.

Requirements:
- A dedicated route (e.g. `/crisis-resources` or `/support`), linked from a persistent, visible place — app footer and/or the settings/help menu. Not buried.
- Reachable in guest mode and without logging in. The old triggered card was authenticated-users-only because the assessment was; this page must not be. This is the single most important difference from the old implementation.
- Not a modal, not blocking, no interstitial. It is a page the user chooses to open.
- Content:
  ```
  If you're struggling, you don't have to go through it alone.

  988 Suicide & Crisis Lifeline — call or text 988, available 24/7
  Veterans Crisis Line — call 988 then press 1, or text 838255
  Crisis Text Line — text HOME to 741741

  Mind Tranceform is a self-guided wellness tool. It is not a crisis service,
  it is not a substitute for professional care, and no one at Mind Tranceform
  monitors your activity or responses in the app.

  If you're in immediate danger, call 911 or go to your nearest emergency room.
  ```
  The "no one monitors your activity" sentence is deliberate and must not be softened — it is the honest disclosure that the app has no human in the loop.
- Include the Veterans Crisis Line line as written. Given the veteran/Guard audience, it is the most relevant route for a meaningful share of users, and "988-then-press-1" is the real mechanism.
- Accessibility: real semantic `<a>`/`<button>` elements, keyboard reachable, meets the WCAG 2.0 AA bar established by the Section 508 remediation pass (`section-508-accessibility-fix.patch`). Phone numbers as `tel:` links, SMS as `sms:` links where supported.
- No auth calls, no network dependency, no data collection on this page. It must render even if the backend is down.

## 3. Copy and claims audit

Grep the entire frontend, backend, and any static marketing pages for `PHQ-9`, `PHQ9`, `phq9`, `PHQ_9` and update to `PHQ-8` wherever it describes what the app currently does. Historical/internal references to past PHQ-9 administration stay accurate as-is.

Do not anywhere state or imply that the app screens for suicide risk, assesses self-harm, or performs risk stratification. It does not, and after this change it especially does not. Flag any existing copy that does.

## 4. Historical item-9 purge — with one deliberate exception

The app holds suicide-risk data it has no clinical ability to act on. Holding it is pure downside: it raises the severity of any breach and serves no product purpose.

Purge (straightforward data minimization):
- After the Section 1 backfill has run, strip `q9` from stored responses:
  ```sql
  update clinical_assessments
     set responses = responses - 'q9'
   where instrument = 'phq9'
     and responses ? 'q9';
  ```
- Null the flag: `update clinical_assessments set item9_flag = null where item9_flag is not null;`
- In a separate follow-up migration (not this one), drop the `item9_flag` column once Mark has confirmed nothing reads it. Do not drop a column and scrub data in the same migration — if something breaks, the rollback story is much worse.
- Grep for and remove any code path that reads or writes `item9_flag` or `q9`.

**Do NOT purge `safety_response_events`** — leave that table and its rows intact.

This is a deliberate exception and Code should not "tidy it up." That table is an audit trail showing the app did show crisis resources when it detected a positive response. Deleting records of safety actions you took is the kind of thing that looks bad in hindsight in a way that keeping them never does. Stop writing new rows to it, leave the existing rows and the table in place, and add a comment in the migration explaining why it was deliberately retained.

If Mark wants that table purged as well, that is a decision to make after a lawyer's read, not a code cleanup.

## 5. Tests

- A PHQ-8 submission stores `instrument = 'phq8'`, 8 items in `responses`, no `q9` key, `item9_flag` null.
- Scoring: all-zeros → 0 / none-minimal. All-threes → 24 / severe. Verify band boundaries at 4/5, 9/10, 14/15, 19/20.
- No code path can produce a PHQ total above 24 for a `phq8` row.
- `phq8_equivalent_score` is correctly backfilled for a historical `phq9` row (construct a fixture with known q1–q9 values; assert the equivalent equals the q1–q8 sum, not the q1–q9 sum).
- After the purge migration, no `clinical_assessments` row has a `q9` key in `responses` and no row has a non-null `item9_flag`.
- The crisis resources page renders for an unauthenticated/guest visitor.
- The crisis resources page renders with the backend unavailable (mock a failed API layer).
- Crisis page is keyboard-navigable and all links have accessible names.
- GAD-7 flow is entirely unaffected — existing GAD-7 tests still pass.
- The existing `self_assessments` (non-clinical) flow is untouched.
- RLS still enabled with owner-only policies on `clinical_assessments` and `safety_response_events` after the migration.

## Things NOT to do

- Do NOT reword the eight remaining PHQ items. Validity depends on exact wording.
- Do NOT delete or rewrite historical `phq9` rows' instrument label or total_score. They were genuinely PHQ-9 administrations. Rewriting history to look tidy destroys the audit trail.
- Do NOT purge `safety_response_events`. See Section 4.
- Do NOT build any escalation, alerting, or "at-risk user" flagging. This was prohibited in the original spec and remains prohibited. The app has no one qualified to receive such an alert.
- Do NOT gate the crisis resources page behind login, a paywall, or a completed assessment.
- Do NOT add a "how are you feeling?" style free-text field to the crisis page or anywhere near it. Collecting unstructured distress disclosures that nobody reads is the same problem this change is fixing.
- Do NOT run the purge before the backfill. Ordering is load-bearing.
- Do NOT drop the `item9_flag` column in this migration. Follow-up only.

## What to report back

- The Section 0 numbers, before any changes — especially `item9_positive` vs `safety_events`.
- Whether the item-9 safety card was actually wired in production, or specified but never built.
- Migration file path, and explicit confirmation it has not been run (Mark runs it).
- Crisis resources route path + confirmation it renders unauthenticated and offline.
- Every file where `27` or `phq9` was updated.
- Test file paths and count, with explicit confirmation tests 4, 5, and 6 pass.
- Confirmation `safety_response_events` was left intact.
- Anything found in Section 3's copy audit that claimed suicide-risk screening.

## Before this ships — not optional, not Code's job to resolve

- The Termly-generated ToS, privacy policy, and clinical disclaimer predate the assessment feature entirely. The original spec flagged this and it is still outstanding. They need to be reviewed against what the app actually does now.
- The FTC Health Breach Notification Rule applies to Mind Tranceform today, independent of this change — it expressly covers consumer health apps not subject to HIPAA, and PHQ/GAD scores are health data. Obligations include breach notification within 60 days, simultaneous FTC notice for incidents affecting 500+ people, and annual FTC reporting for smaller ones. Confirm no third-party data sharing of assessment data (analytics SDKs included — check what Sentry and PostHog actually capture on the assessment screens).
- This change reduces risk; it does not make the app a clinical product or remove the need for a professional read — particularly if Mind Tranceform continues to be marketed to EAP/broker buyers on the strength of validated outcome measurement. The original spec already recommended a lawyer or telehealth-compliance review. That recommendation stands and is now overdue.
