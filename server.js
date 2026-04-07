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
`;

    // 🔊 ElevenLabs request
    const audioResponse = await axios({
      method: "POST",
      url: "https://api.elevenlabs.io/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM",
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

    // ✅ Convert to base64 (NO FILE SAVING)
    const audioBase64 = Buffer.from(audioResponse.data).toString("base64");

    // ✅ Return clean response
    res.json({
      success: true,
      script,
      audioBase64,
    });
  } catch (error) {
    console.error("🔥 ERROR:", error?.response?.data || error.message);

    res.status(500).json({
      success: false,
      error: error?.response?.data || error.message || "Failed",
    });
  }
});