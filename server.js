const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const axios = require("axios");
const stripe = require("stripe");
const { createClient } = require("@supabase/supabase-js");
dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

function getResendClient() {
  if (!process.env.RESEND_API_KEY) return null;
  const { Resend } = require("resend");
  return new Resend(process.env.RESEND_API_KEY);
}

const FROM = process.env.RESEND_FROM_EMAIL || "Mind Tranceform <onboarding@resend.dev>";
const APP_URL = process.env.APP_URL || "https://app.mindtranceform.com";

const app = express();
const PORT = process.env.PORT || 8080;
const stripeClient = stripe(process.env.STRIPE_SECRET_KEY);

app.use(cors());
// Stripe webhooks require the raw body — all other routes get JSON parsing
app.use((req, res, next) => {
  if (req.path === "/webhook/stripe") {
    express.raw({ type: "application/json" })(req, res, next);
  } else {
    express.json({ limit: "10mb" })(req, res, next);
  }
});

// ─── AUTH MIDDLEWARE ──────────────────────────────────────────────────────────
async function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) return res.status(401).json({ success: false, error: "Unauthorized" });
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return res.status(401).json({ success: false, error: "Unauthorized" });
  req.user = user;
  next();
}

// ─── VOICE MAP ───────────────────────────────────────────────────────────────
const VOICE_MAP = {
  "Female Calm":   process.env.ELEVENLABS_VOICE_FEMALE_CALM   || "21m00Tcm4TlvDq8ikWAM",
  "Female Warm":   process.env.ELEVENLABS_VOICE_FEMALE_WARM   || "EXAVITQu4vr4xnSDxMaL",
  "Male Calm":     process.env.ELEVENLABS_VOICE_MALE_CALM     || "TxGEqnHWrfWFTfGW9XjX",
  "Male Deep":     process.env.ELEVENLABS_VOICE_MALE_DEEP     || "VR6AewLTigWG4xSOukaG",
  "Male Smooth":   process.env.ELEVENLABS_VOICE_MALE_SMOOTH   || "pNInz6obpgDQGcFmaJgB",
  "Male Resonant": process.env.ELEVENLABS_VOICE_MALE_RESONANT || "yoZ06aMxZJJ28mfd3POQ",
};

// ─── EMAIL HELPERS ────────────────────────────────────────────────────────────
function emailWrap(body) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#07091a;font-family:system-ui,sans-serif;color:#e8e6f0;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#07091a;padding:40px 0;">
<tr><td align="center"><table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">
<tr><td style="padding:0 24px;">
  <div style="text-align:center;padding:32px 0 24px;">
    <h1 style="font-size:26px;font-weight:300;letter-spacing:0.12em;color:#e8e6f0;margin:0;">
      Mind <em style="color:#d4b896;font-style:italic;">Tranceform</em>
    </h1>
    <p style="font-size:11px;letter-spacing:0.22em;text-transform:uppercase;color:#8a879e;margin:6px 0 0;">Personalized Meditation &amp; Hypnosis</p>
  </div>
  <div style="background:rgba(255,255,255,0.04);border:0.5px solid rgba(255,255,255,0.1);border-radius:16px;padding:32px;">
    ${body}
  </div>
  <div style="text-align:center;padding:24px 0 0;font-size:11px;color:#8a879e;line-height:1.8;">
    <a href="${APP_URL}" style="color:#a8d8c8;text-decoration:none;">Open App</a> &nbsp;·&nbsp;
    You're receiving this because you signed up for Mind Tranceform.
  </div>
</td></tr>
</table></td></tr>
</table></body></html>`;
}

function cta(text, url) {
  return `<a href="${url}" style="display:block;text-align:center;background:linear-gradient(135deg,rgba(168,216,200,0.2),rgba(201,168,216,0.2));border:0.5px solid #a8d8c8;border-radius:10px;padding:14px 24px;color:#a8d8c8;text-decoration:none;font-size:15px;letter-spacing:0.04em;margin-top:24px;">${text}</a>`;
}

function p(text) {
  return `<p style="color:#c8c5d8;font-size:15px;line-height:1.75;margin:0 0 16px;">${text}</p>`;
}

function h(text) {
  return `<h2 style="color:#e8e6f0;font-size:20px;font-weight:300;margin:0 0 20px;">${text}</h2>`;
}

async function logEmail(userId, email, type) {
  await supabase.from("email_log").insert({ user_id: userId, email, type });
}

async function hasEmailBeenSent(userId, type) {
  const { data } = await supabase
    .from("email_log")
    .select("id")
    .eq("user_id", userId)
    .eq("type", type)
    .limit(1);
  return data?.length > 0;
}

// ─── EMAIL SENDERS ────────────────────────────────────────────────────────────
async function sendWelcomeEmail(userId, email) {
  if (await hasEmailBeenSent(userId, "seq_day0")) return;
  const resend = getResendClient();
  if (!resend) { console.warn("Resend not configured — skipping welcome email"); return; }
  await resend.emails.send({
    from: FROM,
    to: email,
    subject: "Your free session is ready — create it now",
    html: emailWrap(
      h("Welcome to Mind Tranceform") +
      p("Your personalized meditation and hypnosis session is ready to create — it takes less than 2 minutes.") +
      p("Tell us your name and goal. We'll write a script just for you, voice it with AI, and layer it with healing frequencies. It's entirely yours.") +
      cta("Create My Session ✦", APP_URL)
    ),
  });
  await logEmail(userId, email, "seq_day0");
}

async function sendSessionDeliveryEmail(email, { name, program, voice, script }) {
  const resend = getResendClient();
  if (!resend) { console.warn("Resend not configured — skipping session delivery email"); return; }
  const previewScript = script.slice(0, 600) + (script.length > 600 ? "..." : "");
  await resend.emails.send({
    from: FROM,
    to: email,
    subject: `Your ${program} session is ready, ${name}`,
    html: emailWrap(
      h(`Your session is ready, ${name}`) +
      p(`Your personalized <strong style="color:#e8e6f0;">${program}</strong> session has been created with a <strong style="color:#e8e6f0;">${voice}</strong> voice. Open the app to listen, or read your script below.`) +
      `<div style="background:rgba(255,255,255,0.06);border:0.5px solid rgba(255,255,255,0.1);border-radius:10px;padding:20px;font-size:14px;line-height:1.8;color:#c8c5d8;white-space:pre-wrap;margin-bottom:8px;">${previewScript}</div>` +
      cta("Listen in App ✦", APP_URL)
    ),
  });
}

async function sendSequenceEmail(userId, email, day) {
  const type = `seq_day${day}`;
  if (await hasEmailBeenSent(userId, type)) return false;

  const emails = {
    1: {
      subject: "Did you try your session yet?",
      html: emailWrap(
        h("How does it actually feel?") +
        p("People describe their first Mind Tranceform session as something they didn't expect:") +
        `<div style="border-left:2px solid #a8d8c8;padding:12px 20px;margin:0 0 16px;color:#c8c5d8;font-size:14px;font-style:italic;line-height:1.75;">
          "Like someone finally wrote something just for me. Not a generic script — my name, my goal, my voice. I listened twice."
        </div>` +
        p("It's not a generic guided meditation. It uses your name, your specific goal, and the voice tone you choose. The AI writes it, speaks it, and saves it so you can come back anytime.") +
        cta("Try It Now ✦", APP_URL)
      ),
    },
    3: {
      subject: "Your personalized session is waiting (2 min to create)",
      html: emailWrap(
        h("Still thinking about it?") +
        p("Here's exactly what happens when you click Generate:") +
        `<ul style="color:#c8c5d8;font-size:15px;line-height:2;padding-left:20px;margin:0 0 16px;">
          <li>AI writes a script using your name and your exact goal</li>
          <li>ElevenLabs voices it in the tone you chose</li>
          <li>Your complete session is ready in under 60 seconds</li>
          <li>It's saved to your account — listen anytime</li>
        </ul>` +
        p("Two minutes. Your name. Your goal. Your voice.") +
        cta("Generate My Session ✦", APP_URL)
      ),
    },
    7: {
      subject: "Last reminder — your free session",
      html: emailWrap(
        h("This is our last reminder") +
        p("Your free session is still waiting. After today we'll stop nudging you — but it'll be there whenever you're ready.") +
        p("One session. Two minutes. Completely personalized to you.") +
        `<div style="background:rgba(168,216,200,0.06);border:0.5px solid rgba(168,216,200,0.2);border-radius:10px;padding:16px 20px;margin:0 0 8px;font-size:13px;color:#8a879e;line-height:1.7;">
          ✦ &nbsp;Sleep · Stress &amp; Anxiety · Abundance<br>
          Choose your program, your voice, your background sound.
        </div>` +
        cta("Create It Now ✦", APP_URL)
      ),
    },
    14: {
      subject: "We made something new for you",
      html: emailWrap(
        h("Something worth coming back for") +
        p("Since you signed up, we've improved our Sleep, Stress &amp; Anxiety, and Abundance sessions — deeper personalization, better voice quality, richer audio layering.") +
        p("This isn't a reminder. It's a new version of something we think you'll actually want to try.") +
        p("Come see what's changed.") +
        cta("Try the New Sessions ✦", APP_URL)
      ),
    },
  };

  const emailData = emails[day];
  if (!emailData) return false;

  const resend = getResendClient();
  if (!resend) { console.warn("Resend not configured — skipping sequence email day", day); return false; }
  await resend.emails.send({ from: FROM, to: email, ...emailData });
  await logEmail(userId, email, type);
  return true;
}

// ─── ROUTES ───────────────────────────────────────────────────────────────────
app.get("/", (_req, res) => {
  res.json({ message: "Mind Tranceform backend is running", status: "ok" });
});

// Register user profile + send welcome email
app.post("/user/register", requireAuth, async (req, res) => {
  const { id: userId, email } = req.user;
  try {
    const { data: existing } = await supabase
      .from("user_profiles")
      .select("user_id")
      .eq("user_id", userId)
      .single();

    if (!existing) {
      await supabase.from("user_profiles").insert({ user_id: userId, email });
      // Fire-and-forget — don't block the response
      sendWelcomeEmail(userId, email).catch(console.error);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Mark user as subscriber (called after successful Stripe payment)
app.post("/user/subscribe", requireAuth, async (req, res) => {
  await supabase.from("user_profiles").upsert({ user_id: req.user.id, email: req.user.email, is_subscriber: true });
  res.json({ success: true });
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
      success_url: `${APP_URL}?payment=success&plan=${plan}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${APP_URL}?payment=cancelled`,
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

app.post("/generate-session", requireAuth, async (req, res) => {
  const { name, goal, program, voice, background, length, style, personalization, fears, motivation, idealLife, affirmationStyle, backgroundIntensity } = req.body;
  if (!name || !goal || !program) return res.status(400).json({ success: false, error: "Name, goal, and program are required." });
  const mins = parseInt(length) || 5;
  const wordTarget = { 5: 450, 10: 900, 15: 1350, 20: 1800, 30: 2700 }[mins] || 450;
  const maxTokens = Math.ceil(wordTarget * 1.5);
  try {
    const prompt = buildPrompt({ name, goal, program, voice, background, style, personalization, fears, motivation, idealLife, affirmationStyle, backgroundIntensity, wordTarget });
    const aiResponse = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      { model: "gpt-4o-mini", messages: [{ role: "user", content: prompt }], max_tokens: maxTokens, temperature: 0.85 },
      { headers: { "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" } }
    );
    const script = aiResponse.data.choices[0]?.message?.content?.trim();
    if (!script) throw new Error("No script returned from AI.");

    const voiceId = VOICE_MAP[voice] || VOICE_MAP["Female Calm"];
    let audioBase64 = null;
    let audioUnavailable = false;
    try {
      const audioResponse = await axios.post(
        `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
        { text: script, model_id: "eleven_turbo_v2_5", voice_settings: { stability: 0.6, similarity_boost: 0.8 } },
        { headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY, "Content-Type": "application/json" }, responseType: "arraybuffer" }
      );
      audioBase64 = Buffer.from(audioResponse.data).toString("base64");
    } catch (audioErr) {
      console.error("ElevenLabs error:", audioErr?.response?.status || audioErr.message);
      audioUnavailable = true;
    }

    await supabase.from("sessions").insert({
      id: Date.now().toString(),
      user_id: req.user.id,
      email: req.user.email,
      title: `${program} — ${style || "Gentle Meditation"} — ${mins} min`,
      program, voice, background, script,
      audio_base64: audioBase64,
    });

    const { data: old } = await supabase
      .from("sessions").select("id")
      .eq("user_id", req.user.id)
      .order("created_at", { ascending: false })
      .range(10, 1000);
    if (old?.length) await supabase.from("sessions").delete().in("id", old.map((s) => s.id));

    // Send session delivery email (fire-and-forget)
    sendSessionDeliveryEmail(req.user.email, { name, program, voice, script }).catch(console.error);

    return res.json({ success: true, script, audioBase64, audioUnavailable });
  } catch (err) {
    const message = err?.response?.data?.error?.message || err.message || "Generation failed.";
    console.error("Generation error:", message);
    return res.status(500).json({ success: false, error: message });
  }
});

// Daily cron — process sequence emails for non-subscribers
// Secure with CRON_SECRET env var. Call daily from cron-job.org or similar.
app.post("/cron/email-sequences", async (req, res) => {
  if (req.headers["x-cron-secret"] !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  try {
    const { data: profiles } = await supabase
      .from("user_profiles")
      .select("user_id, email, created_at")
      .eq("is_subscriber", false);

    if (!profiles?.length) return res.json({ success: true, processed: 0 });

    const now = Date.now();
    let sent = 0;
    const SEQUENCE = [
      { day: 1,  ms: 1  * 24 * 60 * 60 * 1000 },
      { day: 3,  ms: 3  * 24 * 60 * 60 * 1000 },
      { day: 7,  ms: 7  * 24 * 60 * 60 * 1000 },
      { day: 14, ms: 14 * 24 * 60 * 60 * 1000 },
    ];

    for (const profile of profiles) {
      const signedUpAt = new Date(profile.created_at).getTime();
      const elapsed = now - signedUpAt;
      for (const { day, ms } of SEQUENCE) {
        if (elapsed >= ms) {
          const didSend = await sendSequenceEmail(profile.user_id, profile.email, day);
          if (didSend) sent++;
        }
      }
    }

    res.json({ success: true, processed: profiles.length, sent });
  } catch (err) {
    console.error("Cron error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/preview-voice/:voiceName", async (req, res) => {
  const voiceId = VOICE_MAP[req.params.voiceName];
  if (!voiceId) return res.status(400).json({ error: "Unknown voice" });
  try {
    const r = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
      {
        text: "Take a deep breath... and relax. This is what your personalized session will sound like.",
        model_id: "eleven_turbo_v2_5",
        voice_settings: { stability: 0.6, similarity_boost: 0.8 },
      },
      { headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY, "Content-Type": "application/json" }, responseType: "arraybuffer" }
    );
    res.set("Content-Type", "audio/mpeg");
    res.set("Cache-Control", "public, max-age=86400");
    res.send(Buffer.from(r.data));
  } catch (err) {
    const status = err?.response?.status || 500;
    res.status(status).json({ error: "Preview unavailable" });
  }
});

app.get("/test-elevenlabs", async (_req, res) => {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) return res.json({ ok: false, error: "ELEVENLABS_API_KEY is not set" });
  try {
    const r = await axios.post(
      "https://api.elevenlabs.io/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM",
      { text: "Test.", model_id: "eleven_turbo_v2_5", voice_settings: { stability: 0.6, similarity_boost: 0.8 } },
      { headers: { "xi-api-key": key, "Content-Type": "application/json" }, responseType: "arraybuffer" }
    );
    res.json({ ok: true, keyPrefix: key.slice(0, 10) + "...", bytesReceived: r.data.byteLength });
  } catch (err) {
    const status = err?.response?.status;
    const body = err?.response?.data ? Buffer.from(err.response.data).toString("utf8") : err.message;
    res.json({ ok: false, keyPrefix: key.slice(0, 10) + "...", status, error: body });
  }
});

app.get("/sessions", requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from("sessions")
    .select("id, title, program, voice, background, created_at")
    .eq("user_id", req.user.id)
    .order("created_at", { ascending: false })
    .limit(10);
  if (error) return res.status(500).json({ success: false, error: error.message });
  res.json({ success: true, sessions: data || [] });
});

app.get("/sessions/:id", requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from("sessions")
    .select("*")
    .eq("user_id", req.user.id)
    .eq("id", req.params.id)
    .single();
  if (error || !data) return res.status(404).json({ success: false, error: "Session not found." });
  const { audio_base64, ...rest } = data;
  res.json({ success: true, session: { ...rest, audioBase64: audio_base64 } });
});

// ─── PROMPT ───────────────────────────────────────────────────────────────────
function buildPrompt({ name, goal, program, voice, background, style, personalization, fears, motivation, idealLife, affirmationStyle, backgroundIntensity, wordTarget = 450 }) {
  const endings = {
    "Sleep":                "End with suggestions to drift into deep restful sleep. Do NOT include a wake-up.",
    "Stress & Anxiety":     "End with a calming positive anchor for the rest of the day.",
    "Abundance":            "End with vivid visualization of success and receiving.",
    "Confidence":           "End with a powerful surge of inner certainty — the felt sense that they are capable, worthy, and unstoppable.",
    "Focus & Productivity": "End with a clear, energized mental anchor state of sharp focus they can return to instantly at any time.",
    "Quit Smoking":         "End with a vivid feeling of freedom, clean lungs, and deep pride in choosing to be free. No mention of cravings.",
    "Weight Loss Mindset":  "End with a positive body image visualization and the full feeling of living energetically in a healthy body.",
    "Relationship Healing": "End with an open heart, inner peace, and genuine readiness to give and receive love freely.",
    "Abundance & Wealth":   "End with a vivid felt experience of financial freedom and deep certainty that wealth flows naturally to them.",
  };
  const styleGuides = {
    "Gentle Meditation": "Use a soft, nurturing tone. Keep pacing gentle and reassuring throughout.",
    "Deep Hypnosis":     "Use a slow, authoritative hypnotic tone. Include progressive deepening language and trance-induction techniques.",
    "Affirmations Only": "Structure the session primarily around powerful affirmations, repeated and varied for emphasis. Minimize narrative.",
    "Visualization":     "Lead through a detailed, vivid mental journey. Engage all five senses in every scene.",
    "Sleep Induction":   "Use an extremely slow, drowsy pace. Progressively increase suggestions of heaviness, warmth, and sleep.",
    "Confidence Boost":  "Use an empowering, uplifting tone. Build momentum and inner strength throughout the session.",
  };
  const affirmGuides = {
    "I am":          'Write affirmations in first person: "I am..." format.',
    "You are":       'Write affirmations in second person: "You are..." format.',
    "Present tense": "Write affirmations as present-tense truths, as if already fully achieved.",
    "Future tense":  "Write affirmations as future certainties, planting seeds of what is coming.",
  };
  const intensityGuides = {
    "Subtle":    "Mention the background sound lightly at the start only. Keep the focus entirely on the voice.",
    "Balanced":  "Reference the background sound occasionally throughout to anchor the listener.",
    "Immersive": "Weave the background sound throughout as an integral, living part of the experience.",
  };

  const deepContext = personalization === "deep" && (fears || motivation || idealLife)
    ? `\nDeep personalization:\n${fears ? `- Fear / what to release: ${fears}` : ""}\n${motivation ? `- Core motivation: ${motivation}` : ""}\n${idealLife ? `- Ideal life vision: ${idealLife}` : ""}`.trim()
    : "";

  return `Write a personalized guided ${program} meditation/hypnosis session.
Name: ${name}
Goal: ${goal}
Program: ${program}
Voice style: ${voice || "Female Calm"}
Background sound: ${background || "432 Hz"}
Session style: ${style || "Gentle Meditation"}${deepContext}

Rules:
1. Use ${name}'s name at least 4 times throughout.
2. Write in second person.
3. Begin with 3 slow breathing instructions.
4. Include a body scan relaxation from head to toe.
5. Countdown from 10 to 1 to deepen the state.
6. Weave "${goal}" into vivid positive suggestions and visualization.${deepContext ? "\n7. Incorporate the deep personalization details naturally into the script." : ""}
${deepContext ? "8" : "7"}. Include 3 personalized affirmations tied directly to their goal. ${affirmGuides[affirmationStyle] || affirmGuides["I am"]}
${deepContext ? "9" : "8"}. ${endings[program] || "End positively."}
${deepContext ? "10" : "9"}. Style: ${styleGuides[style] || styleGuides["Gentle Meditation"]}
${deepContext ? "11" : "10"}. Background: ${intensityGuides[backgroundIntensity] || intensityGuides["Balanced"]}
${deepContext ? "12" : "11"}. ${wordTarget - 50}–${wordTarget + 50} words. Use "..." for natural pauses.
${deepContext ? "13" : "12"}. Output ONLY the script. No titles, labels, or commentary.`;
}

// ─── STRIPE WEBHOOK ──────────────────────────────────────────────────────────
app.post("/webhook/stripe", async (req, res) => {
  const sig = req.headers["stripe-signature"];
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return res.status(500).json({ error: "Webhook secret not configured" });

  let event;
  try {
    event = stripeClient.webhooks.constructEvent(req.body, sig, secret);
  } catch (err) {
    console.error("Webhook signature error:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;
        const email = session.customer_email || session.metadata?.email;
        const plan  = session.metadata?.plan;
        if (email && plan) {
          await supabase.from("user_profiles").upsert({
            email,
            is_subscriber: true,
            plan,
            stripe_customer_id:      session.customer      || null,
            stripe_subscription_id:  session.subscription  || null,
            subscription_status:     "active",
          }, { onConflict: "email" });
        }
        break;
      }

      case "customer.subscription.deleted": {
        const sub = event.data.object;
        await supabase.from("user_profiles")
          .update({ plan: null, is_subscriber: false, subscription_status: "cancelled", stripe_subscription_id: null })
          .eq("stripe_customer_id", sub.customer);
        break;
      }

      case "customer.subscription.updated": {
        const sub = event.data.object;
        const priceId = sub.items?.data[0]?.price?.id;
        const priceMap = {
          [process.env.STRIPE_PRICE_SINGLE]:  "single",
          [process.env.STRIPE_PRICE_PREMIUM]: "premium",
          [process.env.STRIPE_PRICE_PRO]:     "pro",
        };
        const newPlan = priceMap[priceId];
        const periodEnd = sub.current_period_end
          ? new Date(sub.current_period_end * 1000).toISOString()
          : null;
        await supabase.from("user_profiles")
          .update({
            ...(newPlan ? { plan: newPlan } : {}),
            subscription_status: sub.status,
            current_period_end:  periodEnd,
          })
          .eq("stripe_subscription_id", sub.id);
        break;
      }

      case "invoice.payment_failed": {
        const invoice = event.data.object;
        const { data: profile } = await supabase.from("user_profiles")
          .select("email")
          .eq("stripe_customer_id", invoice.customer)
          .single();
        if (profile?.email) {
          await supabase.from("user_profiles")
            .update({ subscription_status: "past_due" })
            .eq("stripe_customer_id", invoice.customer);
          const resend = getResendClient();
          if (resend) {
            resend.emails.send({
              from: FROM,
              to: profile.email,
              subject: "Your Mind Tranceform payment failed",
              html: emailWrap(
                h("Payment failed") +
                p("We weren't able to process your Mind Tranceform payment. Please update your payment method to keep access to your sessions.") +
                cta("Update Payment Method →", APP_URL)
              ),
            }).catch(console.error);
          }
        }
        break;
      }
    }
  } catch (err) {
    console.error("Webhook handler error:", err.message);
  }

  res.json({ received: true });
});

// ─── CANCEL SUBSCRIPTION ─────────────────────────────────────────────────────
app.post("/cancel-subscription", requireAuth, async (req, res) => {
  try {
    const { data: profile } = await supabase.from("user_profiles")
      .select("stripe_subscription_id")
      .eq("user_id", req.user.id)
      .single();
    if (!profile?.stripe_subscription_id) {
      return res.status(400).json({ success: false, error: "No active subscription found." });
    }
    await stripeClient.subscriptions.update(profile.stripe_subscription_id, {
      cancel_at_period_end: true,
    });
    await supabase.from("user_profiles")
      .update({ subscription_status: "cancelling" })
      .eq("user_id", req.user.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── SUBSCRIPTION STATUS ──────────────────────────────────────────────────────
app.get("/subscription-status", requireAuth, async (req, res) => {
  try {
    const { data: profile } = await supabase.from("user_profiles")
      .select("plan, subscription_status, current_period_end, stripe_subscription_id, email")
      .eq("user_id", req.user.id)
      .single();
    if (!profile) return res.json({ success: true, plan: null, status: "free", nextBillingDate: null });

    let nextBillingDate = profile.current_period_end || null;
    if (profile.stripe_subscription_id) {
      try {
        const sub = await stripeClient.subscriptions.retrieve(profile.stripe_subscription_id);
        nextBillingDate = new Date(sub.current_period_end * 1000).toISOString();
        await supabase.from("user_profiles")
          .update({ subscription_status: sub.status, current_period_end: nextBillingDate })
          .eq("user_id", req.user.id);
      } catch {}
    }

    res.json({
      success: true,
      plan:           profile.plan || null,
      status:         profile.subscription_status || "active",
      nextBillingDate,
      email:          profile.email || req.user.email,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Mind Tranceform backend running on port ${PORT}`);
  console.log(`ElevenLabs key loaded: ${process.env.ELEVENLABS_API_KEY ? "YES" : "MISSING"}`);
  console.log(`Resend key loaded: ${process.env.RESEND_API_KEY ? "YES" : "MISSING"}`);
});
