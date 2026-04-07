const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const axios = require("axios");

dotenv.config();

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json({ limit: "10mb" }));

const VOICE_MAP = {
  "Female Calm": process.env.ELEVENLABS_VOICE_FEMALE_CALM || "21m00Tcm4TlvDq8ikWAM",
  "Male Calm":   process.env.ELEVENLABS_VOICE_MALE_CALM   || "TxGEqnHWrfWFTfGW9XjX",
  "Male Deep":   process.env.ELEVENLABS_VOICE_MALE_DEEP   || "VR6AewLTigWG4xSOukaG",
};

app.get("/", (_req, res) => {
  res.json({ message: "Mind Tranceform backend is running", status: "ok" });
});

app.post("/generate-session", async (req, res) => {
  const { name, goal, program, voice, background } = req.body;

  if (!name || !goal || !program) {
    return res.status(400).json({ success: false, error: "Name, goal, and program are required." });
  }

  try {
    const prompt = buildPrompt({ name, goal, program, voice, background });

    const aiResponse = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 700,
        temperature: 0.85,
      },
      {
        headers: {
          "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    const script = aiResponse.data.choices[0]?.message?.content?.trim();
    if (!script) throw new Error("No script returned from AI.");

    const voiceId = VOICE_MAP[voice] || VOICE_MAP["Female Calm"];

    const audioResponse = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
      {
        text: script,
        model_id: "eleven_monolingual_v1",
        voice_settings: { stability: 0.6, similarity_boost: 0.8 },
      },
      {
        headers: {
          "xi-api-key": process.env.ELEVENLABS_API_KEY,
          "Content-Type": "application/json",
        },
        responseType: "arraybuffer",
      }
    );

    const audioBase64 = Buffer.from(audioResponse.data).toString("base64");

    return res.json({ success: true, script, audioBase64 });

  } catch (err) {
    const message = err?.response?.data?.error?.message || err.message || "Generation failed.";
    console.error("Error:", message);
    return res.status(500).json({ success: false, error: message });
  }
});

function buildPrompt({ name, goal, program, voice, background }) {
  const endings = {
    "Sleep": "End with suggestions to drift into deep restful sleep. Do NOT include a wake-up.",
    "Stress & Anxiety": "End with a calming positive anchor for the rest of the day.",
    "Abundance": "End with vivid visualization of success and receiving.",
  };
  return `Write a personalized guided ${program} meditation/hypnosis session.
Name: ${name}
Goal: ${goal}
Program: ${program}
Voice style: ${voice || "Female Calm"}
Background: ${background || "432 Hz"}

Rules:
1. Use ${name}'s name at least 4 times.
2. Write in second person.
3. Begin with 3 slow breathing instructions.
4. Include a body scan relaxation.
5. Countdown from 10 to 1 to deepen the state.
6. Weave "${goal}" into vivid positive suggestions.
7. Include 3 personalized affirmations.
8. ${endings[program] || "End positively."}
9. 350-450 words. Use "..." for pauses.
10. Output ONLY the script. No titles or commentary.`;
}

app.listen(PORT, () => {
  console.log(`Mind Tranceform backend running on port ${PORT}`);
});