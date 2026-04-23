const axios = require('axios');

async function llmIntentCheck(userGoal, sessionNotes = '') {
  const prompt = `You are a content safety classifier for a meditation and hypnosis app.

Classify the following session request. Respond ONLY with valid JSON.

Session goal: "${userGoal}"
Additional notes: "${sessionNotes}"

Return JSON with this exact shape:
{
  "category": "safe",
  "reason": "one sentence explanation",
  "steerTo": null
}

Where "category" is one of: "safe", "steer", or "block".

Classification rules:
- "block": Request involves active suicidal ideation, self-harm instructions, clinical eating disorder treatment, psychosis, substance detox/withdrawal, or requests the session act as therapy or a medical treatment.
- "steer": Request involves general depression, grief, alcohol reduction, anxiety, sleep issues, low self-worth, relationship pain — reframe toward wellness/relaxation.
- "safe": General personal development, focus, confidence, sleep preparation, motivation, creativity, stress relief.

Be conservative. When uncertain between steer and block, choose steer. Never generate a refusal that shames the user.
If category is "steer", populate "steerTo" with an alternative wellness framing. Otherwise "steerTo" is null.`;

  try {
    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o-mini',
        max_tokens: 150,
        temperature: 0,
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: 8000,
      }
    );
    const text = response.data.choices[0]?.message?.content?.trim() || '{}';
    const parsed = JSON.parse(text);
    if (!['safe', 'steer', 'block'].includes(parsed.category)) {
      return { category: 'safe', reason: 'unexpected category — defaulting to allow', steerTo: null };
    }
    return parsed;
  } catch (err) {
    console.error('[intentClassifier] error:', err.message);
    return { category: 'safe', reason: 'classifier error — defaulting to allow', steerTo: null };
  }
}

module.exports = { llmIntentCheck };
