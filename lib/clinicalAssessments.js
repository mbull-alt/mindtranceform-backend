// PHQ-8 and GAD-7 — validated clinical screening instruments.
// Item text is exact and must never be reworded or abbreviated; validity
// depends on the precise wording below. Public domain for clinical/patient
// care use.
//
// PHQ-8 is the PHQ-9 with item 9 (the suicidal-ideation item) omitted —
// removed 2026-08-21, see
// Discussions/code-prompts/phq8-conversion-crisis-card-item9-purge.md.
// Administering a validated suicidal-ideation screener in a consumer app
// with no clinician, no crisis staff, and no human in the loop was
// exposure with no corresponding benefit: the app cannot act on a positive
// response, and a positive response is exactly the case where acting
// matters. PHQ-8 and PHQ-9 total scores correlate at r = 0.998 (Kroenke,
// Strine, Spitzer, Williams, Berry & Mokdad, Journal of Affective
// Disorders, 2009) — the "we administer validated depression and anxiety
// screening" claim survives essentially intact.
//
// PHQ-9/PHQ-8 and GAD-7 developed by Drs. Robert L. Spitzer, Janet B.W.
// Williams, Kurt Kroenke and colleagues, with an educational grant from
// Pfizer Inc. No permission required to reproduce, translate, display, or
// distribute.

const STEM = "Over the last 2 weeks, how often have you been bothered by any of the following problems?";

const ANSWER_SCALE = [
  { value: 0, label: "Not at all" },
  { value: 1, label: "Several days" },
  { value: 2, label: "More than half the days" },
  { value: 3, label: "Nearly every day" },
];

const ATTRIBUTION =
  "PHQ-8/PHQ-9 and GAD-7 developed by Drs. Robert L. Spitzer, Janet B.W. Williams, Kurt Kroenke and colleagues, " +
  "with an educational grant from Pfizer Inc. No permission required to reproduce, translate, display, or distribute.";

// Full historical PHQ-9 item set, kept verbatim (including item 9) purely as
// a documentation/audit record of exactly what earlier phq9 rows in
// clinical_assessments administered — NOT offered to users and NOT used to
// score anything going forward. PHQ8_ITEMS below (items 1-8, unmodified) is
// the only set actually presented to new users.
const PHQ9_ITEMS = [
  "Little interest or pleasure in doing things",
  "Feeling down, depressed, or hopeless",
  "Trouble falling or staying asleep, or sleeping too much",
  "Feeling tired or having little energy",
  "Poor appetite or overeating",
  "Feeling bad about yourself — or that you are a failure, or have let yourself or your family down",
  "Trouble concentrating on things, such as reading the newspaper or watching television",
  "Moving or speaking so slowly that other people could have noticed — or the opposite, being so fidgety or " +
    "restless that you have been moving around a lot more than usual",
  "Thoughts that you would be better off dead, or of hurting yourself in some way",
];

// PHQ-8: PHQ-9 with item 9 deleted. Items 1-8, exact wording, unchanged.
const PHQ8_ITEMS = PHQ9_ITEMS.slice(0, 8);

const GAD7_ITEMS = [
  "Feeling nervous, anxious, or on edge",
  "Not being able to stop or control worrying",
  "Worrying too much about different things",
  "Trouble relaxing",
  "Being so restless that it is hard to sit still",
  "Becoming easily annoyed or irritable",
  "Feeling afraid, as if something awful might happen",
];

const INSTRUMENTS = {
  phq8: { items: PHQ8_ITEMS, maxScore: 24 },
  gad7: { items: GAD7_ITEMS, maxScore: 21 },
};

function itemsForInstrument(instrument) {
  const def = INSTRUMENTS[instrument];
  if (!def) return null;
  return def.items.map((text, i) => ({ id: `q${i + 1}`, text }));
}

// PHQ-8: 0-4 none/minimal · 5-9 mild · 10-14 moderate · 15-19 moderately severe · 20-24 severe
// (same cutoffs as PHQ-9; only the top band's ceiling is lower, 24 vs 27 — the
// classification logic below doesn't check an upper bound so this needs no
// special-casing.)
// GAD-7: 0-4 minimal · 5-9 mild · 10-14 moderate · 15-21 severe
function severityBand(instrument, totalScore) {
  if (instrument === "phq8") {
    if (totalScore <= 4) return "none/minimal";
    if (totalScore <= 9) return "mild";
    if (totalScore <= 14) return "moderate";
    if (totalScore <= 19) return "moderately severe";
    return "severe";
  }
  if (instrument === "gad7") {
    if (totalScore <= 4) return "minimal";
    if (totalScore <= 9) return "mild";
    if (totalScore <= 14) return "moderate";
    return "severe";
  }
  return null;
}

// Validates and scores a submitted response set for one instrument.
// responses: { q1: 0-3, ..., qN: 0-3 } where N = 8 for phq8, 7 for gad7.
// Returns { totalScore, severityBand } or null if the instrument is unknown
// or any answer is missing/out of range. There is no item9Flag anymore —
// item 9 no longer exists in either instrument this function scores, and
// the item9_flag DB column it used to feed is dropped in
// migrations/009_drop_item9_flag_column.sql.
function scoreAssessment(instrument, responses) {
  const def = INSTRUMENTS[instrument];
  if (!def || !responses || typeof responses !== "object" || Array.isArray(responses)) return null;

  const answers = [];
  for (let i = 1; i <= def.items.length; i++) {
    const v = Number(responses[`q${i}`]);
    if (!Number.isInteger(v) || v < 0 || v > 3) return null;
    answers.push(v);
  }

  const totalScore = answers.reduce((sum, v) => sum + v, 0);

  return { totalScore, severityBand: severityBand(instrument, totalScore) };
}

module.exports = {
  STEM,
  ANSWER_SCALE,
  ATTRIBUTION,
  PHQ9_ITEMS,
  PHQ8_ITEMS,
  GAD7_ITEMS,
  INSTRUMENTS,
  itemsForInstrument,
  severityBand,
  scoreAssessment,
};
