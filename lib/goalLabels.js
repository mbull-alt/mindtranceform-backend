// Maps onboarding program choices to user-facing goal labels and assessment types.
// Friendly phrases describe a personal aim, not a medical outcome — never use
// clinical or diagnostic language here.

const PROGRAM_GOAL_LABELS = {
  "Sleep":              "Sleep better",
  "Anxiety":            "Feel calmer",
  "Stress":             "Feel calmer",
  "Stress & Anxiety":   "Feel calmer",
  "Manifestation":      "Manifest my goals",
  "Confidence":         "Build confidence",
  "Focus":              "Improve focus",
  "Healing":            "Support healing",
  "Motivation":         "Stay motivated",
  "Pain Management":    "Manage discomfort",
  "Phobia":             "Face my fears",
  "Performance":        "Perform at my best",
  "Relationships":      "Improve relationships",
  "Weight Management":  "Build healthy habits",
  "Habit Formation":    "Build healthy habits",
  "Addiction Recovery": "Build healthy habits",
  "Grief":              "Find peace",
  "Self-Esteem":        "Build confidence",
};

// Maps program to assessment type; unknown programs fall back to 'general'.
const PROGRAM_ASSESSMENT_TYPE = {
  "Sleep":            "sleep",
  "Anxiety":          "anxiety",
  "Stress":           "anxiety",
  "Stress & Anxiety": "anxiety",
};

// Non-clinical wellness check-in questions per assessment type.
// Scale: 0 = worst response, 3 = best response. Score = sum of all 4 answers (0–12).
// Internal note: question structure loosely parallels lightweight sleep/anxiety
// self-report concepts used in EAP efficacy reporting — but this is NOT a validated
// clinical instrument and must NEVER be presented as one in user-facing copy.
const ASSESSMENT_QUESTIONS = {
  sleep: [
    { id: "q1", text: "How well did you sleep last night?",        low: "Very poorly",  high: "Very well"   },
    { id: "q2", text: "How long did it take you to fall asleep?",  low: "A long time",  high: "Quickly"     },
    { id: "q3", text: "How rested do you feel today?",             low: "Not at all",   high: "Very rested" },
    { id: "q4", text: "How many nights this week were disrupted?", low: "Most nights",  high: "None"        },
  ],
  anxiety: [
    { id: "q1", text: "How calm have you felt this week?",              low: "Not at all", high: "Very calm"  },
    { id: "q2", text: "How often did worry get in the way of your day?",low: "Most days",  high: "Never"      },
    { id: "q3", text: "How easily were you able to relax?",             low: "Not at all", high: "Easily"     },
    { id: "q4", text: "How would you rate your stress overall?",        low: "Very high",  high: "Very low"   },
  ],
};
// General falls back to anxiety questions (same structure, different program context)
ASSESSMENT_QUESTIONS.general = ASSESSMENT_QUESTIONS.anxiety;

function goalLabelForProgram(program) {
  return PROGRAM_GOAL_LABELS[program] || null;
}

function assessmentTypeForProgram(program) {
  return PROGRAM_ASSESSMENT_TYPE[program] || "general";
}

function questionsForType(assessmentType) {
  return ASSESSMENT_QUESTIONS[assessmentType] || ASSESSMENT_QUESTIONS.general;
}

module.exports = {
  PROGRAM_GOAL_LABELS,
  PROGRAM_ASSESSMENT_TYPE,
  ASSESSMENT_QUESTIONS,
  goalLabelForProgram,
  assessmentTypeForProgram,
  questionsForType,
};
