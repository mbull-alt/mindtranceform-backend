import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import axios from "axios";
import fs from "fs";

import { OpenAI } from "openai";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json());

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ✅ Test route
app.get("/", (_req, res) => {
  res.json({ message: "Mind Tranceform backend is running" });
});

// 🔥 MAIN ROUTE (UPDATED)
app.post("/generate-session", async (req, res) => {
  try {
    const { name, goal, program, voice } = req.body;

    // 🧠 STEP 1 — Generate script with OpenAI
    const prompt = `
Create a calming, personalized hypnosis session.

User Name: ${name}
Goal: ${goal}
Program Type: ${program}

Make it relaxing, second-person, and about 2 minutes long.
Include breathing guidance and emotional reassurance.
`;

    const aiResponse = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
    });

    const script = aiResponse.choices[0].message.content;

    // 🔊 STEP 2 — Convert to voice (ElevenLabs)
    const voiceId = "21m00Tcm4TlvDq8ikWAM";

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
      },
      responseType: "arraybuffer",
    });

    // 💾 Save audio
    const filePath = "audio.mp3";
    fs.writeFileSync(filePath, audioResponse.data);

    // 🌐 Return response
    res.json({
      success: true,
      script,
      audioUrl: "https://mindtranceform-backend.onrender.com/audio.mp3"
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, error: "Failed to generate session" });
  }
});

// Serve audio file
app.use(express.static("."));

app.listen(PORT, () => {
  console.log(`Mind Tranceform backend running on port ${PORT}`);
});