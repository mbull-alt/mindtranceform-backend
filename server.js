const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const axios = require("axios");
const OpenAI = require("openai").default;

dotenv.config();

const app = express();
const PORT = process.env.PORT || 8080;

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: "10mb" }));

// ─── OPENAI CLIENT ────────────────────────────────────────────────────────────
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ─── VOICE MAP (ElevenLabs voice IDs) ────────────────────────────────────────
// Replace these IDs with real ones from your ElevenLabs account:
// https://elevenlabs.io/voice-library
const VOICE_MAP = {
  "Female Calm":     process.env.ELEVENLABS_VOICE_FEMALE_CALM  || "21m00Tcm4TlvDq8ikWAM",
  "Male Calm":       process.env.ELEVENLABS_VOICE_MALE_CALM    || "TxGEqnHWrfWFTfGW9XjX",
  "Male Deep":       process.env.ELEVENLABS_VOICE_MALE_DEEP    || "VR6AewLTigWG4xSOukaG",
};

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────
app.get("/", (_req, res) => {
  res.json({ message: "Mind Tranceform backend is running", status: "ok" });
});

// ─── MAIN GENERATION ROUTE ────────────────────────────────────────────────────
app.post("/generate-session", async (req, res) => {
  const { name, goal, program, voice, background } = req.body;

  // Validate required fields
  if (!name || !goal || !program) {
    return res.status(400).json({ success: false, error: "Name, goal, and program are required." });
  }

  try {
    // ── STEP 1: Generate personalized script with OpenAI ──────────────────
    const prompt = buildPrompt({ name, goal, program, voice, background });

    const aiResponse = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 700,
      temperature: 0.85,
    });

    const script = aiResponse.choices[0]?.message?.content?.trim();
    if (!script) throw new Error("AI did not return a script. Please try again.");

    // ── STEP 2: Convert script to audio with ElevenLabs ──────────────────
    const voiceId = VOICE_MAP[voice] || VOICE_MAP["Female Calm"];

    const audioResponse = await axios({
      method: "POST",
      url: `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
      headers: {
        "xi-api-key": process.env.ELEVENLABS_API_KEY,
        "Content-Type": "application/json",
      },
      data: {
        text: script,
        model_id: "eleven_monolingual_v1",
        voice_settings: {
          stability: 0.6,
          similarity_boost: 0.8,
          style: 0.2,
          use_speaker_boost: true,
        },
      },
      responseType: "arraybuffer",
    });

    // ── STEP 3: Return script + audio as base64 ───────────────────────────
    const audioBase64 = Buffer.from(audioResponse.data).toString("base64");

    return res.json({ success: true, script, audioBase64 });

  } catch (err) {
    const errData = err?.response?.data;
    let message = err.message || "Session generation failed.";

    // Decode ElevenLabs buffer errors
    if (errData && Buffer.isBuffer(errData)) {
      try { message = JSON.parse(errData.toString())?.detail?.message || message; } catch {}
    }

    console.error("Generation error:", message);
    return res.status(500).json({ success: false, error: message });
  }
});

// ─── SCRIPT BUILDER ──────────────────────────────────────────────────────────
function buildPrompt({ name, goal, program, voice, background }) {
  const programInstructions = {
    "Sleep":
      "End with suggestions to drift into deep, restful sleep. Do NOT include a count-up or wake instructions at the end.",
    "Stress & Anxiety":
      "Focus on releasing tension, calming the nervous system, and finding inner stillness. End with a positive anchor for the rest of the day.",
    "Abundance":
      "Focus on expanding belief in possibility, wealth consciousness, and confidence. Use vivid visualizations of success and receiving.",
  };

  return `Write a personalized guided ${program} meditation/hypnosis session.

Details:
- Name: ${name}
- Goal: ${goal}
- Program: ${program}
- Voice style: ${voice || "Female Calm"}
- Background: ${background || "432 Hz"} frequency

Rules:
1. Speak directly to ${name} — use their name at least 4 times throughout.
2. Write in second person ("you", "your").
3. Begin with a slow breathing induction: 3 deep breaths with full guidance.
4. Include a relaxation body scan (head to toe).
5. Include a countdown from 10 to 1 to deepen the trance state.
6. Weave in "${goal}" as vivid, positive suggestions and a visualization scene.
7. Include 3–4 personalized affirmations tied directly to their goal.
8. ${programInstructions[program] || "End with positivity."}
9. Total length: 350–450 words. Natural paragraph breaks. Use "..." for pause moments.
10. Output ONLY the script. No meta-commentary, no titles, no stage directions.`;
}

// ─── START ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Mind Tranceform backend running on port ${PORT}`);
});