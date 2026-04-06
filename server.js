import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json());

app.get("/", (_req, res) => {
  res.json({ message: "Mind Tranceform backend is running" });
});

app.post("/generate-session", async (req, res) => {
  try {
    const { name, goal, program, voice } = req.body;

    const script = `
Hello ${name || "friend"}.

This is your personalized ${program || "meditation"} session.

Today we are focusing on ${goal || "calm, clarity, and peace"}.

Take a deep breath in.
And slowly exhale.

Allow your body to relax.
Allow your mind to slow down.
You are safe.
You are supported.
You are moving toward the life you want.

This session was created for you with the voice style ${voice || "Female Calm"}.
`;

    res.json({
      success: true,
      script,
      audioUrl: "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3"
    });
  } catch (error) {
    res.status(500).json({ success: false, error: "Failed to generate session" });
  }
});

app.listen(PORT, () => {
  console.log(`Mind Tranceform backend running on port ${PORT}`);
});