const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const axios = require("axios");
const stripe = require("stripe");

dotenv.config();

const app = express();
const PORT = process.env.PORT || 8080;
const stripeClient = stripe(process.env.STRIPE_SECRET_KEY);

app.use(cors());
app.use(express.json({ limit: "10mb" }));

const sessionStore = {};

const VOICE_MAP = {
  "Female Calm": process.env.ELEVENLABS_VOICE_FEMALE_CALM || "21m00Tcm4TlvDq8ikWAM",
  "Male Calm":   process.env.ELEVENLABS_VOICE_MALE_CALM   || "TxGEqnHWrfWFTfGW9XjX",
  "Male Deep":   process.env.ELEVENLABS_VOICE_MALE_DEEP   || "VR6AewLTigWG4xSOukaG",
};

app.get("/", (_req, res) => {
  res.json({ message: "Mind Tranceform backend is running", status: "ok" });
});

app.post("/create-checkout", async (req, res) => {
  const { plan, email } = req.body;
  const priceMap = {
    "single":  process.env.STRIPE_PRICE_SINGLE,
    "premium": process.env.STRIPE_PRICE_PREMIUM,
    "pro":     process.env.STRIPE_PRICE_PRO,
  };
  const priceId = priceMap[plan];
  if (!priceId) return res.status(400).json({ success: false, error: "Invalid plan." });
  const isSubscription = plan === "premium" || plan === "pro";
  try {
    const session = await stripeClient.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: isSubscription ? "subscription" : "payment",
      customer_email: email || undefined,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${process.env.APP_URL}?payment=success&plan=${plan}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${process.env.APP_URL}?payment=cancelled`,
      metadata: { plan, email: email || "" },
    });
    res.json({ success: true, checkoutUrl: session.url, sessionId: session.id });
  } catch (err) {
    console.error("Stripe error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/verify-payment", async (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ success: false, error: "Session ID required." });
  try {
    const session = await stripeClient.checkout.sessions.retrieve(sessionId);
    const paid = session.payment_status === "paid" || session.status === "complete";
    res.json({ success: true, paid, plan: session.metadata?.plan || "single", email: session.customer_email || session.metadata?.email || "" });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/generate-session", async (req, res) => {
  const { name, goal, program, voice, background, email } = req.body;
  if (!name || !goal || !program) return res.status(400).json({ success: false, error: "Name, goal, and program are required." });
  try {
    const prompt = buildPrompt({ name, goal, program, voice, background });
    const aiResponse = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      { model: "gpt-4o-mini", messages: [{ role: "user", content: prompt }], max_tokens: 700, temperature: 0.85 },
      { headers: { "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" } }
    );
    const script = aiResponse.data.choices[0]?.message?.content?.trim();
    if (!script) throw new Error("No script returned from AI.");
    const voiceId = VOICE_MAP[voice] || VOICE_MAP["Female Calm"];
    const audioResponse = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
      { text: script, model_id: "eleven_monolingual_v1", voice_settings: { stability: 0.6, similarity_boost: 0.8 } },
      { headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY, "Content-Type": "application/json" }, responseType: "arraybuffer" }
    );
    const audioBase64 = Buffer.from(audioResponse.data).toString("base64");
    if (email) {
      if (!sessionStore[email]) sessionStore[email] = [];
      sessionStore[email].unshift({ id: Date.now().toString(), title: `${program} — ${new Date().toLocaleDateString()}`, program, voice, background, script, audioBase64, createdAt: new Date().toISOString() });
      if (sessionStore[email].length > 10) sessionStore[email] = sessionStore[email].slice(0, 10);
    }
    return res.json({ success: true, script, audioBase64 });
  } catch (err) {
    const message = err?.response?.data?.error?.message || err.message || "Generation failed.";
    console.error("Generation error:", message);
    return res.status(500).json({ success: false, error: message });
  }
});

app.get("/sessions/:email", (req, res) => {
  const email = decodeURIComponent(req.params.email);
  const sessions = (sessionStore[email] || []).map(({ audioBase64, ...rest }) => rest);
  res.json({ success: true, sessions });
});

app.get("/sessions/:email/:id", (req, res) => {
  const email = decodeURIComponent(req.params.email);
  const sessions = sessionStore[email] || [];
  const session = sessions.find((s) => s.id === req.params.id);
  if (!session) return res.status(404).json({ success: false, error: "Session not found." });
  res.json({ success: true, session });
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
1. Use ${name}'s name at least 4 times throughout.
2. Write in second person.
3. Begin with 3 slow breathing instructions.
4. Include a body scan relaxation head to toe.
5. Countdown from 10 to 1 to deepen the state.
6. Weave "${goal}" into vivid positive suggestions and visualization.
7. Include 3 personalized affirmations tied directly to their goal.
8. ${endings[program] || "End positively."}
9. 350-450 words. Use "..." for pauses.
10. Output ONLY the script. No titles or commentary.`;
}

app.listen(PORT, () => console.log(`Mind Tranceform backend running on port ${PORT}`));