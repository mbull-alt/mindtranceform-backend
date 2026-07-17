// PHQ-9 and GAD-7 — validated clinical screening instruments.
// Item text is exact and must never be reworded or abbreviated; validity
// depends on the precise wording below. Public domain for clinical/patient
// care use.
//
// PHQ-9 and GAD-7 developed by Drs. Robert L. Spitzer, Janet B.W. Williams,
// Kurt Kroenke and colleagues, with an educational grant from Pfizer Inc.
// No permission required to reproduce, translate, display, or distribute.

const STEM = "Over the last 2 weeks, how often have you been bothered by any of the following problems?";

const ANSWER_SCALE = [
  { value: 0, label: "Not at all" },
  { value: 1, label: "Several days" },
  { value: 2, label: "More than half the days" },
  { value: 3, label: "Nearly every day" },
];

const ATTRIBUTION =
  "PHQ-9 and GAD-7 developed by Drs. Robert L. Spitzer, Janet B.W. Williams, Kurt Kroenke and colleagues, " +
  "with an educational grant from Pfizer Inc. No permission required to reproduce, translate, display, or distribute.";

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

const GAD7_ITEMS = [
  "Feeling nervous, anxious, or on edge",
  "Not being able to stop or control worrying",
  "Worrying too much about different things",
  "Trouble relaxing",
  "Being so restless that it is hard to sit still",
  "Becoming easily annoyed or irritable",
  "Feeling afraid, as if something awful might happen",
];

// Item index (0-based) of the self-harm screening item within PHQ-9. Item 9 → index 8.
const PHQ9_ITEM9_INDEX = 8;

const INSTRUMENTS = {
  phq9: { items: PHQ9_ITEMS, maxScore: 27, hasItem9: true },
  gad7: { items: GAD7_ITEMS, maxScore: 21, hasItem9: false },
};

function itemsForInstrument(instrument) {
  const def = INSTRUMENTS[instrument];
  if (!def) return null;
  return def.items.map((text, i) => ({ id: `q${i + 1}`, text }));
}

// PHQ-9: 0-4 minimal · 5-9 mild · 10-14 moderate · 15-19 moderately severe · 20-27 severe
// GAD-7: 0-4 minimal · 5-9 mild · 10-14 moderate · 15-21 severe
function severityBand(instrument, totalScore) {
  if (instrument === "phq9") {
    if (totalScore <= 4) return "minimal";
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
// responses: { q1: 0-3, ..., qN: 0-3 } where N = 9 for phq9, 7 for gad7.
// Returns { totalScore, severityBand, item9Flag } or null if the instrument
// is unknown or any answer is missing/out of range. item9Flag is only ever
// computed for phq9 (true if q9 > 0); always null for gad7.
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
  const item9Flag = def.hasItem9 ? answers[PHQ9_ITEM9_INDEX] > 0 : null;

  return { totalScore, severityBand: severityBand(instrument, totalScore), item9Flag };
}

module.exports = {
  STEM,
  ANSWER_SCALE,
  ATTRIBUTION,
  PHQ9_ITEMS,
  GAD7_ITEMS,
  PHQ9_ITEM9_INDEX,
  INSTRUMENTS,
  itemsForInstrument,
  severityBand,
  scoreAssessment,
};
