import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import axios from "axios";
import { OpenAI } from "openai";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json({ limit: "10mb" }));

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

app.get("/", (_req, res) => {
  res.json({ message: "Mind Tranceform backend is running" });
});

app.post("/generate-session", async (req, res) => {
  try {
    const { name, goal, program, voice } = req.body;

    const prompt = `
Create a calming, personalized hypnosis session.

User Name: ${name}
Goal: ${goal}
Program Type: ${program}
Preferred Voice Style: ${voice}

Make it relaxing, second-person, and about 2 minutes long.
Include breathing guidance and emotional reassurance.
`;

    const aiResponse = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
    });

    const script = aiResponse.choices[0].message.content;

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

    const audioBase64 = Buffer.from(audioResponse.data).toString("base64");

    res.json({
      success: true,
      script,
      audioBase64,
      mimeType: "audio/mpeg",
    });
  } catch (error) {
    console.error("Generation error:", error?.response?.data || error.message || error);
    res.status(500).json({
      success: false,
      error: error?.response?.data || error.message || "Failed to generate session",
    });
  }
});

app.listen(PORT, () => {
  console.log(`Mind Tranceform backend running on port ${PORT}`);
});