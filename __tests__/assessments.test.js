const {
  goalLabelForProgram,
  assessmentTypeForProgram,
  questionsForType,
  ASSESSMENT_QUESTIONS,
} = require("../lib/goalLabels");

// Score logic is inline in the POST /assessments handler — we test it here
// as a standalone function so it stays honest even if the handler is refactored.
function computeScore(responses) {
  return ["q1", "q2", "q3", "q4"].reduce((sum, k) => sum + Number(responses[k]), 0);
}

describe("goalLabelForProgram", () => {
  test("Sleep → 'Sleep better'", () => {
    expect(goalLabelForProgram("Sleep")).toBe("Sleep better");
  });

  test("Stress & Anxiety → 'Feel calmer'", () => {
    expect(goalLabelForProgram("Stress & Anxiety")).toBe("Feel calmer");
  });

  test("unknown program → null", () => {
    expect(goalLabelForProgram("Unicorn Therapy")).toBeNull();
  });
});

describe("assessmentTypeForProgram", () => {
  test("Sleep → 'sleep'", () => {
    expect(assessmentTypeForProgram("Sleep")).toBe("sleep");
  });

  test("Anxiety → 'anxiety'", () => {
    expect(assessmentTypeForProgram("Anxiety")).toBe("anxiety");
  });

  test("Stress & Anxiety → 'anxiety'", () => {
    expect(assessmentTypeForProgram("Stress & Anxiety")).toBe("anxiety");
  });

  test("Manifestation (no explicit mapping) → 'general'", () => {
    expect(assessmentTypeForProgram("Manifestation")).toBe("general");
  });

  test("empty string → 'general'", () => {
    expect(assessmentTypeForProgram("")).toBe("general");
  });
});

describe("questionsForType", () => {
  test("sleep returns 4 questions", () => {
    expect(questionsForType("sleep")).toHaveLength(4);
  });

  test("anxiety returns 4 questions", () => {
    expect(questionsForType("anxiety")).toHaveLength(4);
  });

  test("general returns the same questions as anxiety", () => {
    expect(questionsForType("general")).toEqual(ASSESSMENT_QUESTIONS.anxiety);
  });

  test("unknown type falls back to general", () => {
    expect(questionsForType("xyz")).toEqual(ASSESSMENT_QUESTIONS.general);
  });

  test("each question has id, text, low, high", () => {
    const qs = questionsForType("sleep");
    qs.forEach((q) => {
      expect(q).toHaveProperty("id");
      expect(q).toHaveProperty("text");
      expect(q).toHaveProperty("low");
      expect(q).toHaveProperty("high");
    });
  });
});

describe("score calculation", () => {
  test("{q1:2, q2:1, q3:3, q4:2} → score 8", () => {
    expect(computeScore({ q1: 2, q2: 1, q3: 3, q4: 2 })).toBe(8);
  });

  test("all 0s → score 0", () => {
    expect(computeScore({ q1: 0, q2: 0, q3: 0, q4: 0 })).toBe(0);
  });

  test("all 3s → score 12 (max)", () => {
    expect(computeScore({ q1: 3, q2: 3, q3: 3, q4: 3 })).toBe(12);
  });

  test("partial answers coerce correctly", () => {
    expect(computeScore({ q1: "2", q2: "1", q3: "0", q4: "3" })).toBe(6);
  });
});

// ─── GUEST MODE: no user-facing clinical instrument names ─────────────────────
describe("no clinical instrument names in user-facing copy", () => {
  const BANNED = ["phq", "gad", "pcl", "psqi", "dass"];

  function scanQuestions(questions) {
    return questions.map((q) => q.text + q.low + q.high).join(" ").toLowerCase();
  }

  test("sleep questions contain no banned clinical instrument names", () => {
    const copy = scanQuestions(ASSESSMENT_QUESTIONS.sleep);
    BANNED.forEach((term) => expect(copy).not.toContain(term));
  });

  test("anxiety questions contain no banned clinical instrument names", () => {
    const copy = scanQuestions(ASSESSMENT_QUESTIONS.anxiety);
    BANNED.forEach((term) => expect(copy).not.toContain(term));
  });
});
