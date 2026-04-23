const HARD_BLOCK = [
  // Suicidality / self-harm
  /\b(suicid|kill myself|end my life|self.?harm|cutting|overdos)\b/i,
  // Psychosis / dissociation
  /\b(psychosis|psychotic|hallucinating|hearing voices|losing my mind)\b/i,
  // Eating disorders
  /\b(anorex|bulimi|binge.?purg|restrict.?eat|starvation diet)\b/i,
  // Severe PTSD / trauma processing
  /\b(trauma processing|flashback|re-experiencing|PTSD treatment)\b/i,
  // Substance dependency (clinical framing)
  /\b(detox|withdrawal|alcohol.?depend|opioid|heroin|meth|cocaine)\b/i,
];

const STEER = [
  { pattern: /\b(quit.{0,15}drink|stop.{0,15}drink|sobriety|alcohol|drinking habit)\b/i,
    steerTo: "building healthy habits and finding calm without relying on external substances" },
  { pattern: /\b(depress|feeling low|hopeless|sad all the time|no motivation)\b/i,
    steerTo: "lifting mood, cultivating self-compassion, and building emotional resilience" },
  { pattern: /\b(anxiety|anxious|panic attack|overwhelm|constant worry)\b/i,
    steerTo: "deep relaxation, nervous system regulation, and finding inner calm" },
  { pattern: /\b(grief|grieving|loss of|lost my|mourning)\b/i,
    steerTo: "gentle healing, self-compassion, and finding peace after loss" },
  { pattern: /\b(trauma|abuse|assault|childhood wound)\b/i,
    steerTo: "safety, grounding, and cultivating a sense of inner peace" },
  { pattern: /\b(insomnia|can.?t sleep|sleep.?less|racing mind at night)\b/i,
    steerTo: "deep sleep preparation, quieting the mind, and restful relaxation" },
];

function classifyPrompt(userGoal, sessionNotes = '') {
  const text = `${userGoal} ${sessionNotes}`.trim();

  for (const pattern of HARD_BLOCK) {
    if (pattern.test(text)) {
      return { action: 'block', reason: pattern.source };
    }
  }

  for (const { pattern, steerTo } of STEER) {
    if (pattern.test(text)) {
      return { action: 'steer', originalText: text, steerTo };
    }
  }

  return { action: 'allow' };
}

module.exports = { classifyPrompt };
