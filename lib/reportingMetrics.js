// Pure aggregation/suppression logic for the admin reporting endpoint —
// no I/O, fully unit-testable. Kept separate from server.js so the
// small-cohort suppression rule (the privacy-critical part) can be tested
// in isolation from Supabase.

const { severityBand } = require("./clinicalAssessments");

const MIN_COHORT = 10;

function round2(n) {
  return Math.round(n * 100) / 100;
}

function average(nums) {
  return nums.reduce((sum, v) => sum + v, 0) / nums.length;
}

// Suppresses any count under MIN_COHORT, returning null instead of the real
// (re-identifiable) number. Used for engagement_by_program buckets.
function suppressBucket(count, minSize = MIN_COHORT) {
  return count < minSize ? null : count;
}

// scoresByUser: array of arrays, one per user, each the user's total_score
// values for one instrument within the window, ordered oldest → newest.
// Cohort = users with >=2 assessments in the window. Returns null outcome
// numbers (but a real cohort_size) when the cohort is under MIN_COHORT —
// small-cohort averages can effectively re-identify an individual's score
// change, so this suppression is not optional.
function computeOutcomeStats(instrument, scoresByUser) {
  const eligible = (scoresByUser || []).filter((scores) => scores.length >= 2);
  const cohortSize = eligible.length;

  if (cohortSize < MIN_COHORT) {
    return {
      cohort_size: cohortSize,
      avg_score_change: null,
      avg_baseline_severity: null,
      avg_latest_severity: null,
    };
  }

  const baselineScores = eligible.map((s) => s[0]);
  const latestScores = eligible.map((s) => s[s.length - 1]);
  const avgBaseline = average(baselineScores);
  const avgLatest = average(latestScores);

  return {
    cohort_size: cohortSize,
    avg_score_change: round2(avgLatest - avgBaseline),
    avg_baseline_severity: severityBand(instrument, Math.round(avgBaseline)),
    avg_latest_severity: severityBand(instrument, Math.round(avgLatest)),
  };
}

module.exports = { MIN_COHORT, suppressBucket, computeOutcomeStats };
