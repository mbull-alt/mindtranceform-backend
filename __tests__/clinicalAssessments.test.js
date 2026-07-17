const {
  PHQ9_ITEMS,
  GAD7_ITEMS,
  itemsForInstrument,
  severityBand,
  scoreAssessment,
} = require("../lib/clinicalAssessments");

function allZeros(n) {
  const r = {};
  for (let i = 1; i <= n; i++) r[`q${i}`] = 0;
  return r;
}

describe("itemsForInstrument", () => {
  test("phq9 returns 9 items with exact wording", () => {
    const items = itemsForInstrument("phq9");
    expect(items).toHaveLength(9);
    expect(items.map((i) => i.text)).toEqual(PHQ9_ITEMS);
  });

  test("gad7 returns 7 items with exact wording", () => {
    const items = itemsForInstrument("gad7");
    expect(items).toHaveLength(7);
    expect(items.map((i) => i.text)).toEqual(GAD7_ITEMS);
  });

  test("unknown instrument returns null", () => {
    expect(itemsForInstrument("psqi")).toBeNull();
  });

  test("phq9 item 9 (index 8) is the self-harm screening item", () => {
    expect(itemsForInstrument("phq9")[8].text).toBe(
      "Thoughts that you would be better off dead, or of hurting yourself in some way"
    );
  });
});

describe("severityBand", () => {
  describe("phq9", () => {
    test.each([
      [0, "minimal"], [4, "minimal"],
      [5, "mild"], [9, "mild"],
      [10, "moderate"], [14, "moderate"],
      [15, "moderately severe"], [19, "moderately severe"],
      [20, "severe"], [27, "severe"],
    ])("score %i → %s", (score, band) => {
      expect(severityBand("phq9", score)).toBe(band);
    });
  });

  describe("gad7", () => {
    test.each([
      [0, "minimal"], [4, "minimal"],
      [5, "mild"], [9, "mild"],
      [10, "moderate"], [14, "moderate"],
      [15, "severe"], [21, "severe"],
    ])("score %i → %s", (score, band) => {
      expect(severityBand("gad7", score)).toBe(band);
    });
  });

  test("unknown instrument returns null", () => {
    expect(severityBand("psqi", 5)).toBeNull();
  });
});

describe("scoreAssessment — validation", () => {
  test("unknown instrument returns null", () => {
    expect(scoreAssessment("psqi", allZeros(9))).toBeNull();
  });

  test("missing an item returns null", () => {
    const responses = allZeros(9);
    delete responses.q5;
    expect(scoreAssessment("phq9", responses)).toBeNull();
  });

  test("out-of-range answer (4) returns null", () => {
    expect(scoreAssessment("gad7", { ...allZeros(7), q3: 4 })).toBeNull();
  });

  test("non-integer answer returns null", () => {
    expect(scoreAssessment("phq9", { ...allZeros(9), q1: 1.5 })).toBeNull();
  });

  test("null responses returns null", () => {
    expect(scoreAssessment("phq9", null)).toBeNull();
  });
});

describe("scoreAssessment — item 9 safety flag (PHQ-9)", () => {
  // Spec requirement: any item-9 answer > 0 triggers the safety card
  // regardless of total score. Test specifically with a low total + nonzero
  // item 9, since that's the case most likely to be missed by a total-score gate.
  test("item9 = 0 → item9Flag false, does not depend on total score", () => {
    const result = scoreAssessment("phq9", { ...allZeros(9), q2: 3, q9: 0 });
    expect(result.item9Flag).toBe(false);
  });

  test("item9 = 1 with a low total score (3) still flags true", () => {
    const responses = { ...allZeros(9), q1: 1, q4: 1, q9: 1 };
    const result = scoreAssessment("phq9", responses);
    expect(result.totalScore).toBe(3);
    expect(result.item9Flag).toBe(true);
  });

  test("item9 = 2 flags true", () => {
    expect(scoreAssessment("phq9", { ...allZeros(9), q9: 2 }).item9Flag).toBe(true);
  });

  test("item9 = 3 flags true", () => {
    expect(scoreAssessment("phq9", { ...allZeros(9), q9: 3 }).item9Flag).toBe(true);
  });

  test("gad7 never computes an item9Flag (always null)", () => {
    const result = scoreAssessment("gad7", { ...allZeros(7), q7: 3 });
    expect(result.item9Flag).toBeNull();
  });
});

describe("scoreAssessment — total score + severity band together", () => {
  test("phq9 all zeros → score 0, minimal", () => {
    const result = scoreAssessment("phq9", allZeros(9));
    expect(result).toEqual({ totalScore: 0, severityBand: "minimal", item9Flag: false });
  });

  test("phq9 all max (3s) → score 27, severe", () => {
    const responses = {};
    for (let i = 1; i <= 9; i++) responses[`q${i}`] = 3;
    const result = scoreAssessment("phq9", responses);
    expect(result.totalScore).toBe(27);
    expect(result.severityBand).toBe("severe");
    expect(result.item9Flag).toBe(true);
  });

  test("gad7 all zeros → score 0, minimal", () => {
    expect(scoreAssessment("gad7", allZeros(7))).toEqual({
      totalScore: 0,
      severityBand: "minimal",
      item9Flag: null,
    });
  });

  test("gad7 all max (3s) → score 21, severe", () => {
    const responses = {};
    for (let i = 1; i <= 7; i++) responses[`q${i}`] = 3;
    const result = scoreAssessment("gad7", responses);
    expect(result.totalScore).toBe(21);
    expect(result.severityBand).toBe("severe");
  });
});
