const { MIN_COHORT, suppressBucket, computeOutcomeStats } = require("../lib/reportingMetrics");

function usersWithScores(count, scoresPerUser) {
  return Array.from({ length: count }, () => [...scoresPerUser]);
}

describe("suppressBucket", () => {
  test("count below MIN_COHORT (9) returns null", () => {
    expect(suppressBucket(9)).toBeNull();
  });

  test("count at exactly MIN_COHORT (10) returns the real count", () => {
    expect(suppressBucket(10)).toBe(10);
  });

  test("count above MIN_COHORT returns the real count", () => {
    expect(suppressBucket(50)).toBe(50);
  });

  test("count of 0 is suppressed", () => {
    expect(suppressBucket(0)).toBeNull();
  });
});

describe("computeOutcomeStats — cohort size gating", () => {
  test("9 eligible users (below MIN_COHORT) → null outcome numbers, real cohort_size", () => {
    const scoresByUser = usersWithScores(9, [15, 5]); // baseline 15, latest 5 — big improvement
    const result = computeOutcomeStats("phq9", scoresByUser);
    expect(result).toEqual({
      cohort_size: 9,
      avg_score_change: null,
      avg_baseline_severity: null,
      avg_latest_severity: null,
    });
  });

  test("exactly 10 eligible users (at MIN_COHORT) → real outcome numbers", () => {
    const scoresByUser = usersWithScores(10, [15, 5]);
    const result = computeOutcomeStats("phq9", scoresByUser);
    expect(result.cohort_size).toBe(10);
    expect(result.avg_score_change).toBe(-10);
    expect(result.avg_baseline_severity).toBe("moderately severe");
    expect(result.avg_latest_severity).toBe("mild");
  });

  test("users with only 1 assessment are excluded from the cohort", () => {
    const eligible = usersWithScores(10, [15, 5]);
    const ineligible = usersWithScores(20, [10]); // only baseline, no follow-up
    const result = computeOutcomeStats("phq9", [...eligible, ...ineligible]);
    expect(result.cohort_size).toBe(10);
  });

  test("uses first and last score, not just first two, for users with >2 assessments", () => {
    const scoresByUser = usersWithScores(10, [20, 12, 4]);
    const result = computeOutcomeStats("phq9", scoresByUser);
    expect(result.avg_score_change).toBe(-16);
  });

  test("gad7 severity bands computed correctly", () => {
    const scoresByUser = usersWithScores(10, [12, 2]);
    const result = computeOutcomeStats("gad7", scoresByUser);
    expect(result.avg_baseline_severity).toBe("moderate");
    expect(result.avg_latest_severity).toBe("minimal");
  });

  test("empty input → cohort_size 0, nulls", () => {
    expect(computeOutcomeStats("phq9", [])).toEqual({
      cohort_size: 0,
      avg_score_change: null,
      avg_baseline_severity: null,
      avg_latest_severity: null,
    });
  });
});

test("MIN_COHORT is 10", () => {
  expect(MIN_COHORT).toBe(10);
});
