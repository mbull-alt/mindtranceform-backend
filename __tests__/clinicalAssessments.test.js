const {
  PHQ9_ITEMS,
  PHQ8_ITEMS,
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

function allMax(n) {
  const r = {};
  for (let i = 1; i <= n; i++) r[`q${i}`] = 3;
  return r;
}

describe("itemsForInstrument", () => {
  test("phq8 returns 8 items with exact wording (PHQ-9 items 1-8, unmodified)", () => {
    const items = itemsForInstrument("phq8");
    expect(items).toHaveLength(8);
    expect(items.map((i) => i.text)).toEqual(PHQ8_ITEMS);
    expect(items.map((i) => i.text)).toEqual(PHQ9_ITEMS.slice(0, 8));
  });

  test("phq8 does not include the old item 9 (self-harm screening item)", () => {
    const items = itemsForInstrument("phq8");
    const text = items.map((i) => i.text).join(" | ");
    expect(text).not.toMatch(/better off dead|hurting yourself/i);
  });

  test("gad7 returns 7 items with exact wording", () => {
    const items = itemsForInstrument("gad7");
    expect(items).toHaveLength(7);
    expect(items.map((i) => i.text)).toEqual(GAD7_ITEMS);
  });

  test("phq9 is no longer offerable — returns null", () => {
    expect(itemsForInstrument("phq9")).toBeNull();
  });

  test("unknown instrument returns null", () => {
    expect(itemsForInstrument("psqi")).toBeNull();
  });
});

describe("severityBand", () => {
  describe("phq8 — boundaries at 4/5, 9/10, 14/15, 19/20", () => {
    test.each([
      [0, "none/minimal"], [4, "none/minimal"],
      [5, "mild"], [9, "mild"],
      [10, "moderate"], [14, "moderate"],
      [15, "moderately severe"], [19, "moderately severe"],
      [20, "severe"], [24, "severe"],
    ])("score %i → %s", (score, band) => {
      expect(severityBand("phq8", score)).toBe(band);
    });
  });

  describe("gad7 (untouched)", () => {
    test.each([
      [0, "minimal"], [4, "minimal"],
      [5, "mild"], [9, "mild"],
      [10, "moderate"], [14, "moderate"],
      [15, "severe"], [21, "severe"],
    ])("score %i → %s", (score, band) => {
      expect(severityBand("gad7", score)).toBe(band);
    });
  });

  test("phq9 is no longer a recognized instrument for fresh band lookups — returns null", () => {
    // Historical phq9 rows keep their originally-stored severity_band column
    // value untouched in the DB; nothing computes a fresh phq9 band anymore.
    expect(severityBand("phq9", 10)).toBeNull();
  });

  test("unknown instrument returns null", () => {
    expect(severityBand("psqi", 5)).toBeNull();
  });
});

describe("scoreAssessment — validation", () => {
  test("unknown instrument returns null", () => {
    expect(scoreAssessment("psqi", allZeros(8))).toBeNull();
  });

  test("phq9 is rejected — new submissions must be phq8", () => {
    expect(scoreAssessment("phq9", allZeros(9))).toBeNull();
  });

  test("missing an item returns null", () => {
    const responses = allZeros(8);
    delete responses.q5;
    expect(scoreAssessment("phq8", responses)).toBeNull();
  });

  test("out-of-range answer (4) returns null", () => {
    expect(scoreAssessment("gad7", { ...allZeros(7), q3: 4 })).toBeNull();
  });

  test("non-integer answer returns null", () => {
    expect(scoreAssessment("phq8", { ...allZeros(8), q1: 1.5 })).toBeNull();
  });

  test("null responses returns null", () => {
    expect(scoreAssessment("phq8", null)).toBeNull();
  });

  test("an extraneous q9 key in the payload is ignored, not scored", () => {
    // phq8's item definition only reads q1-q8; a stray q9 (e.g. from a stale
    // client build) must not affect the total or leak through.
    const result = scoreAssessment("phq8", { ...allZeros(8), q9: 3 });
    expect(result.totalScore).toBe(0);
  });
});

describe("scoreAssessment — item9Flag no longer exists in the result at all", () => {
  // Was previously "always null" — now the key itself is absent, since
  // item9_flag is never written to the DB anymore either (see server.js's
  // POST /clinical-assessments insert and migrations/009_drop_item9_flag_column.sql).
  test("phq8 result has no item9Flag key", () => {
    const result = scoreAssessment("phq8", { ...allZeros(8), q2: 3 });
    expect(result).not.toHaveProperty("item9Flag");
  });

  test("gad7 result has no item9Flag key", () => {
    const result = scoreAssessment("gad7", { ...allZeros(7), q7: 3 });
    expect(result).not.toHaveProperty("item9Flag");
  });
});

describe("scoreAssessment — total score + severity band together", () => {
  test("phq8 all zeros → score 0, none/minimal", () => {
    const result = scoreAssessment("phq8", allZeros(8));
    expect(result).toEqual({ totalScore: 0, severityBand: "none/minimal" });
  });

  test("phq8 all max (3s) → score 24, severe — no code path exceeds 24", () => {
    const result = scoreAssessment("phq8", allMax(8));
    expect(result.totalScore).toBe(24);
    expect(result.severityBand).toBe("severe");
    expect(result).not.toHaveProperty("item9Flag");
  });

  test("gad7 all zeros → score 0, minimal", () => {
    expect(scoreAssessment("gad7", allZeros(7))).toEqual({
      totalScore: 0,
      severityBand: "minimal",
    });
  });

  test("gad7 all max (3s) → score 21, severe", () => {
    const result = scoreAssessment("gad7", allMax(7));
    expect(result.totalScore).toBe(21);
    expect(result.severityBand).toBe("severe");
  });
});

describe("phq8_equivalent_score backfill logic (mirrors migrations/008_phq8_conversion.sql)", () => {
  // The migration backfills via SQL, not this module — but the arithmetic it
  // performs (sum q1-q8, ignore q9) is exactly what scoreAssessment("phq8", ...)
  // does when given the same responses object with q9 stripped out first,
  // which is what this test asserts against a known fixture.
  test("equivalent score for a historical phq9 fixture sums q1-q8, not q1-q9", () => {
    // A historical phq9 row: q1-q8 sum to 10, q9 (self-harm item, since
    // purged from storage) was answered 3 — must NOT be included.
    const historicalPhq9Responses = { q1: 2, q2: 1, q3: 1, q4: 2, q5: 1, q6: 1, q7: 2, q8: 0, q9: 3 };
    const q1to8Sum = [1, 2, 3, 4, 5, 6, 7, 8].reduce((sum, i) => sum + historicalPhq9Responses[`q${i}`], 0);
    const q1to9Sum = q1to8Sum + historicalPhq9Responses.q9;

    expect(q1to8Sum).toBe(10);
    expect(q1to9Sum).toBe(13);

    // The equivalent score the migration computes is q1to8Sum, confirmed by
    // scoring the same 8 answers as a phq8 payload.
    const { q9, ...phq8Shaped } = historicalPhq9Responses;
    const scored = scoreAssessment("phq8", phq8Shaped);
    expect(scored.totalScore).toBe(q1to8Sum);
    expect(scored.totalScore).not.toBe(q1to9Sum);
  });
});
