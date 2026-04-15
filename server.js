const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const axios = require("axios");
const stripe = require("stripe");
const { createClient } = require("@supabase/supabase-js");
const { exec } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
dotenv.config();

const { runDailyContentGeneration, runDailyOutreach, runWeeklyContentGeneration } = require("./contentEngine");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

function getResendClient() {
  if (!process.env.RESEND_API_KEY) return null;
  const { Resend } = require("resend");
  return new Resend(process.env.RESEND_API_KEY);
}

const FROM = "Mind Tranceform <noreply@mindtranceformapp.com>";
const APP_URL = process.env.APP_URL || "https://app.mindtranceformapp.com";

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

function requireAdmin(req, res, next) {
  const key = process.env.ADMIN_KEY;
  if (!key || req.headers["x-admin-key"] !== key) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// ─── VOICE MAP ───────────────────────────────────────────────────────────────
// Default IDs are well-known ElevenLabs library voices.
// Override any slot via the corresponding environment variable in Render.
const VOICE_MAP = {
  "Female Calm":        process.env.ELEVENLABS_VOICE_FEMALE_CALM    || "21m00Tcm4TlvDq8ikWAM", // Rachel
  "Female Warm":        process.env.ELEVENLABS_VOICE_FEMALE_WARM    || "EXAVITQu4vr4xnSDxMaL", // Bella
  "Female Whisper":     process.env.ELEVENLABS_VOICE_FEMALE_WHISPER || "ThT5KcBeYPX3keUQqHPh", // Dorothy
  "Female British":     process.env.ELEVENLABS_VOICE_FEMALE_BRITISH || "XB0fDUnXU5powFXDhCwa", // Charlotte
  "Male Calm":          process.env.ELEVENLABS_VOICE_MALE_CALM      || "GBv7mTt0atIp3Br8iCZE", // Thomas
  "Male Deep Hypnosis": process.env.ELEVENLABS_VOICE_MALE_DEEP      || "VR6AewLTigWG4xSOukaG", // Arnold
  "Male Warm":          process.env.ELEVENLABS_VOICE_MALE_WARM      || "pNInz6obpgDQGcFmaJgB", // Adam
  "Male British":       process.env.ELEVENLABS_VOICE_MALE_BRITISH   || "N2lVS1w4EtoT3dr4eOWO", // Callum
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

// In-memory lock: prevents duplicate sends when /user/register fires concurrently
const _emailInProgress = new Set();

// ─── EMAIL SENDERS ────────────────────────────────────────────────────────────
async function sendWelcomeEmail(userId, email) {
  const lockKey = `${userId}:seq_day0`;
  if (_emailInProgress.has(lockKey)) {
    console.log(`[email] welcome send already in progress for ${email} — skipping`);
    return;
  }
  _emailInProgress.add(lockKey);
  try {
    console.log(`[email] sendWelcomeEmail → userId=${userId} to=${email} from=${FROM}`);
    if (await hasEmailBeenSent(userId, "seq_day0")) {
      console.log(`[email] welcome already logged for ${email} — skipping`);
      return;
    }
    const resend = getResendClient();
    if (!resend) {
      console.warn("[email] RESEND_API_KEY not set — skipping welcome email");
      return;
    }
    // Log BEFORE sending — prevents a second concurrent call from passing the DB check
    await logEmail(userId, email, "seq_day0");
    const result = await resend.emails.send({
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
    console.log(`[email] welcome sent ✓ to=${email} id=${result?.data?.id ?? JSON.stringify(result)}`);
  } catch (err) {
    console.error(`[email] welcome FAILED to=${email} — ${err?.message}`, err?.response?.data ?? err);
  } finally {
    _emailInProgress.delete(lockKey);
  }
}

async function sendSessionDeliveryEmail(email, { name, program, voice, script }) {
  if (!email) {
    console.warn("[email] sendSessionDeliveryEmail — no email address (guest user?), skipping");
    return;
  }
  console.log(`[email] sendSessionDeliveryEmail → to=${email} program=${program} from=${FROM}`);
  const resend = getResendClient();
  if (!resend) {
    console.warn("[email] RESEND_API_KEY not set — skipping session delivery email");
    return;
  }
  const previewScript = script.slice(0, 600) + (script.length > 600 ? "..." : "");
  try {
    const result = await resend.emails.send({
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
    console.log(`[email] session delivery sent ✓ to=${email} id=${result?.data?.id ?? JSON.stringify(result)}`);
  } catch (err) {
    console.error(`[email] session delivery FAILED to=${email} — ${err?.message}`, err?.response?.data ?? err);
  }
}

async function sendSequenceEmail(userId, email, day, name = "") {
  const type = `seq_day${day}`;
  if (await hasEmailBeenSent(userId, type)) return false;

  const hi   = name ? `, ${name}` : "";
  const hey  = name ? `${name}, ` : "";

  const emails = {
    1: {
      subject: `How did your session feel${hi}?`,
      html: emailWrap(
        h("How does it actually feel?") +
        p("People describe their first Mind Tranceform session as something they didn't expect:") +
        `<div style="border-left:2px solid #a8d8c8;padding:12px 20px;margin:0 0 16px;color:#c8c5d8;font-size:14px;font-style:italic;line-height:1.75;">
          "Like someone finally wrote something just for me. Not a generic script — my name, my goal, my voice. I listened twice."
        </div>` +
        p("It's not a generic guided meditation. It uses your name, your specific goal, and the voice tone you choose. The AI writes it, speaks it, and saves it so you can come back anytime.") +
        cta("Open My Session ✦", APP_URL)
      ),
    },
    3: {
      subject: `${hey}your mind responds to what is personal`,
      html: emailWrap(
        h("Generic advice doesn't reach you. Personal does.") +
        p("There's a reason most meditation apps don't stick. They speak to everyone — which means they speak to no one.") +
        p("Mind Tranceform is different. Here's exactly what happens when you click Generate:") +
        `<ul style="color:#c8c5d8;font-size:15px;line-height:2;padding-left:20px;margin:0 0 16px;">
          <li>AI writes a script using <em>your</em> name and <em>your</em> exact goal</li>
          <li>ElevenLabs voices it in the tone you chose</li>
          <li>Your session is ready in under 60 seconds</li>
          <li>It's saved — listen anytime, anywhere</li>
        </ul>` +
        p("Two minutes. Your name. Your goal. Your voice.") +
        cta("Generate My Session ✦", APP_URL)
      ),
    },
    7: {
      subject: `One week ago you started something${hi}`,
      html: emailWrap(
        h("Seven days ago, you took a step.") +
        p("You signed up because something in you knew you needed a change — more sleep, less anxiety, a clearer mind, or something you're working toward.") +
        p("That goal is still there. And so is your free session.") +
        `<div style="background:rgba(168,216,200,0.06);border:0.5px solid rgba(168,216,200,0.2);border-radius:10px;padding:16px 20px;margin:0 0 16px;font-size:13px;color:#8a879e;line-height:1.7;">
          People who listen to their personalized session consistently report results within 7–14 days. Not from one listen — from returning to something that was made for them.
        </div>` +
        p("Upgrade to Premium and unlock unlimited sessions, every program, and longer session lengths. Your first month is the hardest. After that, it becomes a habit.") +
        cta("Unlock Premium ✦", `${APP_URL}?upgrade=1`)
      ),
    },
    14: {
      subject: `We made something new for you${hi}`,
      html: emailWrap(
        h("Something worth coming back for") +
        p("Since you signed up, we've deepened the personalization engine — sessions now respond to more of what makes you, you.") +
        p("New programs. Better voice quality. Richer audio layering. Deeper hypnotic suggestion patterns.") +
        p("This isn't a reminder. It's a new version of something we think you'll genuinely want to experience.") +
        cta("Try the New Sessions ✦", APP_URL)
      ),
    },
    30: {
      subject: `Still thinking about you${hi}`,
      html: emailWrap(
        h("We don't do many of these.") +
        p("This is the last email we'll send for a while. Not because we're giving up on you — but because we respect that timing is personal.") +
        p("If life got busy, we get it. If the moment didn't feel right, we get that too.") +
        p("Whenever you're ready — your free session is still there. It takes two minutes. It uses your name, your goal, your voice. Nothing has changed except the day.") +
        `<div style="background:rgba(168,216,200,0.06);border:0.5px solid rgba(168,216,200,0.2);border-radius:10px;padding:16px 20px;margin:0 0 16px;text-align:center;font-size:14px;color:#c8c5d8;line-height:1.8;">
          ✦ &nbsp;Your session is personalized to you.<br>No one else has one like it.
        </div>` +
        cta("Create My Session ✦", APP_URL)
      ),
    },
  };

  const emailData = emails[day];
  if (!emailData) return false;

  const resend = getResendClient();
  if (!resend) { console.warn(`[email] RESEND_API_KEY not set — skipping sequence day ${day}`); return false; }
  console.log(`[email] sendSequenceEmail day=${day} → to=${email} from=${FROM}`);
  try {
    const result = await resend.emails.send({ from: FROM, to: email, ...emailData });
    const resendId = result?.data?.id || null;
    console.log(`[email] sequence day=${day} sent ✓ to=${email} id=${resendId}`);
    await logEmail(userId, email, type);
    // Track in email_events for webhook matching
    supabase.from("email_events").insert({ user_id: userId, email, email_type: type, event_type: "sent", resend_email_id: resendId }).catch(() => {});
    return true;
  } catch (err) {
    console.error(`[email] sequence day=${day} FAILED to=${email} — ${err?.message}`, err?.response?.data ?? err);
    return false;
  }
}

// ─── SCRIPT CLEANING ─────────────────────────────────────────────────────────
// Strip any stage directions the AI may have included before sending to ElevenLabs.
// ElevenLabs reads parenthetical text aloud — we want none of it.
function cleanScriptForTTS(script) {
  return script
    .replace(/\(pause\)/gi, "  ")
    .replace(/\(breathe\)/gi, "  ")
    .replace(/\(slow breath\)/gi, "  ")
    .replace(/\(exhale\)/gi, "  ")
    .replace(/\(inhale\)/gi, "  ")
    // Generic catch-all: remove any remaining (stage direction) patterns
    .replace(/\([^)]{1,40}\)/g, "  ")
    // Collapse runs of 3+ spaces down to two (ElevenLabs treats 2 spaces as a brief pause)
    .replace(/ {3,}/g, "  ")
    // Remove lines that are now blank or only whitespace after stripping
    .replace(/^\s*[\r\n]/gm, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ─── AUDIO TEMPO ─────────────────────────────────────────────────────────────
// Slow the ElevenLabs audio buffer to `tempo` (0.75 = 75% speed) using
// ffmpeg's atempo filter, which preserves pitch. Falls back to the original
// buffer if ffmpeg is unavailable or fails.
function slowDownAudio(inputBuffer, tempo = 0.75) {
  return new Promise((resolve) => {
    const tag = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const inputPath  = path.join(os.tmpdir(), `tts_in_${tag}.mp3`);
    const outputPath = path.join(os.tmpdir(), `tts_out_${tag}.mp3`);

    const cleanup = () => {
      try { fs.unlinkSync(inputPath);  } catch {}
      try { fs.unlinkSync(outputPath); } catch {}
    };

    try {
      fs.writeFileSync(inputPath, inputBuffer);
    } catch (err) {
      console.warn("[audio] could not write temp file for ffmpeg:", err.message);
      return resolve(inputBuffer);
    }

    exec(
      `ffmpeg -i "${inputPath}" -filter:a "atempo=${tempo}" -y "${outputPath}"`,
      { timeout: 60000 },
      (err) => {
        if (err) {
          console.warn("[audio] ffmpeg atempo failed — returning original audio:", err.message);
          cleanup();
          return resolve(inputBuffer);
        }
        try {
          const slowed = fs.readFileSync(outputPath);
          cleanup();
          console.log(`[audio] ffmpeg atempo=${tempo} applied — ${inputBuffer.length} → ${slowed.length} bytes`);
          resolve(slowed);
        } catch (readErr) {
          console.warn("[audio] could not read ffmpeg output:", readErr.message);
          cleanup();
          resolve(inputBuffer);
        }
      }
    );
  });
}

// ─── ROUTES ───────────────────────────────────────────────────────────────────
app.get("/", (_req, res) => {
  res.json({ message: "Mind Tranceform backend is running", status: "ok" });
});

// Register user profile + send welcome email
app.post("/user/register", requireAuth, async (req, res) => {
  const { id: userId, email } = req.user;
  // Anonymous/guest users have no email — skip profile creation
  if (!email) return res.json({ success: true, guest: true });
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
  const { name, goal, program, voice, background, length, style, personalization, fears, motivation, idealLife, affirmationStyle, backgroundIntensity, white_label_id } = req.body;
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
    const rawScript = aiResponse.data.choices[0]?.message?.content?.trim();
    if (!rawScript) throw new Error("No script returned from AI.");
    // Strip any stage directions the AI may have written before sending to ElevenLabs
    const script = cleanScriptForTTS(rawScript);

    const voiceId = VOICE_MAP[voice] || VOICE_MAP["Female Calm"];
    let audioBase64 = null;
    let audioUnavailable = false;
    try {
      const audioResponse = await axios.post(
        `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
        {
          text: script,
          model_id: "eleven_multilingual_v2",
          voice_settings: { stability: 0.90, similarity_boost: 0.75, style: 0.10, use_speaker_boost: false },
        },
        { headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY, "Content-Type": "application/json" }, responseType: "arraybuffer" }
      );
      // Slow to 75% of original speed via ffmpeg atempo filter (pitch-preserving).
      // Falls back to original audio if ffmpeg is unavailable.
      const slowed = await slowDownAudio(Buffer.from(audioResponse.data), 0.75);
      audioBase64 = slowed.toString("base64");
    } catch (audioErr) {
      console.error("ElevenLabs error:", audioErr?.response?.status || audioErr.message);
      audioUnavailable = true;
    }

    // Persist user's first name for personalised emails
    if (req.user.id && name) {
      supabase.from("user_profiles").update({ name }).eq("user_id", req.user.id).catch(() => {});
    }

    await supabase.from("sessions").insert({
      id: Date.now().toString(),
      user_id: req.user.id,
      email: req.user.email || null,
      title: `${program} — ${style || "Gentle Meditation"} — ${mins} min`,
      program, voice, background, script,
      audio_base64: audioBase64,
      white_label_id: white_label_id || null,
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
      .select("user_id, email, name, created_at")
      .eq("is_subscriber", false);

    if (!profiles?.length) return res.json({ success: true, processed: 0 });

    const now = Date.now();
    let sent = 0;
    const SEQUENCE = [
      { day: 1,  ms:  1 * 24 * 60 * 60 * 1000 },
      { day: 3,  ms:  3 * 24 * 60 * 60 * 1000 },
      { day: 7,  ms:  7 * 24 * 60 * 60 * 1000 },
      { day: 14, ms: 14 * 24 * 60 * 60 * 1000 },
      { day: 30, ms: 30 * 24 * 60 * 60 * 1000 },
    ];

    for (const profile of profiles) {
      const signedUpAt = new Date(profile.created_at).getTime();
      const elapsed = now - signedUpAt;
      for (const { day, ms } of SEQUENCE) {
        if (elapsed >= ms) {
          const didSend = await sendSequenceEmail(profile.user_id, profile.email, day, profile.name || "");
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

const PREVIEW_TEXT = "Take a slow deep breath... and relax...";
const PREVIEW_SETTINGS = {
  model_id: "eleven_multilingual_v2",
  speed: 0.75,
  voice_settings: { stability: 0.90, similarity_boost: 0.75, style: 0.10, use_speaker_boost: false },
};

// GET /preview-voice/:voiceName — returns audio/mpeg stream (used by the app)
app.get("/preview-voice/:voiceName", async (req, res) => {
  const voiceId = VOICE_MAP[req.params.voiceName];
  if (!voiceId) return res.status(400).json({ error: "Unknown voice" });
  try {
    const r = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
      { text: PREVIEW_TEXT, ...PREVIEW_SETTINGS },
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

// POST /preview-voice — takes { voice } in body, returns { audioBase64 }
app.post("/preview-voice", async (req, res) => {
  const { voice } = req.body || {};
  const voiceId = VOICE_MAP[voice];
  if (!voiceId) return res.status(400).json({ success: false, error: "Unknown voice" });
  try {
    const r = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
      { text: PREVIEW_TEXT, ...PREVIEW_SETTINGS },
      { headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY, "Content-Type": "application/json" }, responseType: "arraybuffer" }
    );
    res.json({ success: true, audioBase64: Buffer.from(r.data).toString("base64") });
  } catch (err) {
    const status = err?.response?.status || 500;
    res.status(status).json({ success: false, error: "Preview unavailable" });
  }
});

app.get("/test-elevenlabs", async (_req, res) => {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) return res.json({ ok: false, error: "ELEVENLABS_API_KEY is not set" });
  try {
    const r = await axios.post(
      "https://api.elevenlabs.io/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM",
      { text: "Test.", model_id: "eleven_multilingual_v2", speed: 0.75, voice_settings: { stability: 0.85, similarity_boost: 0.75, style: 0.15, use_speaker_boost: false } },
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

Pacing & formatting rules (critical — this is for text-to-speech audio at a slow meditation pace):
- Write in long, slow, flowing sentences with natural breath points built in.
- Use gentle, hypnotic rhythm — avoid short, clipped sentences.
- Add "..." at the end of every sentence to signal a natural pause.
- Write breathing instructions as spoken words within the text, for example: "Take a slow breath in... and as you breathe out... let everything soften..."
- Do NOT use any stage directions, labels, or parenthetical instructions like (pause), (breathe), (inhale), (exhale), or similar — these will be read aloud.
- Target approximately 80 words per minute of audio at a slow meditation pace (${wordTarget - 50}–${wordTarget + 50} total words for this session).

Content rules:
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
${deepContext ? "12" : "11"}. Output ONLY the script. No titles, labels, or commentary.`;
}

// ─── AUTH VERIFY ─────────────────────────────────────────────────────────────
// Verifies a Supabase JWT and returns the user's plan + subscription status
app.post("/auth/verify", requireAuth, async (req, res) => {
  try {
    const { data: profile } = await supabase
      .from("user_profiles")
      .select("plan, subscription_status, current_period_end, is_subscriber")
      .eq("user_id", req.user.id)
      .single();
    res.json({
      success: true,
      user_id: req.user.id,
      email:   req.user.email || null,
      guest:   !req.user.email,
      plan:    profile?.plan || null,
      status:  profile?.subscription_status || "free",
      is_subscriber: profile?.is_subscriber || false,
      current_period_end: profile?.current_period_end || null,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── SESSIONS BY USER ID ──────────────────────────────────────────────────────
app.get("/sessions/user/:user_id", requireAuth, async (req, res) => {
  // Enforce that users can only access their own sessions
  if (req.params.user_id !== req.user.id) {
    return res.status(403).json({ success: false, error: "Forbidden" });
  }
  const { data, error } = await supabase
    .from("sessions")
    .select("id, title, program, voice, background, created_at")
    .eq("user_id", req.user.id)
    .order("created_at", { ascending: false })
    .limit(10);
  if (error) return res.status(500).json({ success: false, error: error.message });
  res.json({ success: true, sessions: data || [] });
});

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

        // White label checkout
        if (session.metadata?.type === "whitelabel" && session.metadata?.wl_id) {
          await supabase.from("white_label_accounts").update({
            active: true,
            stripe_customer_id:     session.customer     || null,
            stripe_subscription_id: session.subscription || null,
          }).eq("id", session.metadata.wl_id);
          break;
        }

        // Regular user subscription
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

        // Process referral reward for this new subscriber
        if (email) {
          try {
            const { data: prof } = await supabase.from("user_profiles")
              .select("user_id").eq("email", email).single();
            if (prof?.user_id) {
              const { data: ref } = await supabase.from("referrals")
                .select("*").eq("referred_user_id", prof.user_id).eq("status", "pending").single();
              if (ref) await processReferralReward(ref);
            }
          } catch {}
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
    let resolvedStatus  = profile.subscription_status || "active";

    if (profile.stripe_subscription_id) {
      try {
        const sub = await stripeClient.subscriptions.retrieve(profile.stripe_subscription_id);
        nextBillingDate = new Date(sub.current_period_end * 1000).toISOString();
        // cancel_at_period_end means the sub is still "active" in Stripe but
        // will not renew — we surface this as "cancelling" so the UI shows correctly
        resolvedStatus = sub.cancel_at_period_end ? "cancelling" : sub.status;
        await supabase.from("user_profiles")
          .update({ subscription_status: resolvedStatus, current_period_end: nextBillingDate })
          .eq("user_id", req.user.id);
      } catch {}
    }

    res.json({
      success: true,
      plan:           profile.plan || null,
      status:         resolvedStatus,
      nextBillingDate,
      email:          profile.email || req.user.email,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── REFERRALS ───────────────────────────────────────────────────────────────

async function processReferralReward(referral) {
  await supabase.from("referrals").update({
    status: "rewarded",
    reward_type: "free_month",
    completed_at: new Date().toISOString(),
  }).eq("id", referral.id);

  const { data: referrerProfile } = await supabase.from("user_profiles")
    .select("referral_months_earned, email")
    .eq("user_id", referral.referrer_user_id)
    .single();

  if (!referrerProfile) return;

  await supabase.from("user_profiles")
    .update({ referral_months_earned: (referrerProfile.referral_months_earned || 0) + 1 })
    .eq("user_id", referral.referrer_user_id);

  const resend = getResendClient();
  if (!resend) return;

  if (referrerProfile.email) {
    resend.emails.send({
      from: FROM,
      to: referrerProfile.email,
      subject: "Your friend just joined Mind Tranceform — you earned 1 free month",
      html: emailWrap(
        h("You earned 1 free month of Premium ✦") +
        p("Your referral just subscribed to Mind Tranceform. As a thank you, you've earned 1 free month of Premium added to your account.") +
        p("We'll apply it to your next billing cycle. Keep sharing — every friend who joins earns you another free month.") +
        cta("View Your Account →", APP_URL)
      ),
    }).catch(console.error);
  }

  if (referral.referred_email) {
    resend.emails.send({
      from: FROM,
      to: referral.referred_email,
      subject: "Welcome to Mind Tranceform — your first month is 10% off",
      html: emailWrap(
        h("You've got a special offer") +
        p("A friend referred you to Mind Tranceform. As a thank you, your first month is 10% off — we'll apply the discount automatically.") +
        p("Enjoy your personalized sessions.") +
        cta("Start My Session ✦", APP_URL)
      ),
    }).catch(console.error);
  }
}

// GET /referral/code/:user_id — get or generate referral code + stats
app.get("/referral/code/:user_id", requireAuth, async (req, res) => {
  if (req.params.user_id !== req.user.id) return res.status(403).json({ success: false, error: "Forbidden" });
  try {
    const { data: profile } = await supabase.from("user_profiles")
      .select("referral_code, email").eq("user_id", req.user.id).single();

    if (!profile) return res.status(404).json({ success: false, error: "Profile not found." });

    let code = profile.referral_code;
    if (!code) {
      code = req.user.id.replace(/-/g, "").slice(0, 10).toUpperCase();
      await supabase.from("user_profiles").update({ referral_code: code }).eq("user_id", req.user.id);
    }

    const { data: referrals } = await supabase.from("referrals")
      .select("status").eq("referrer_user_id", req.user.id);

    const total       = referrals?.length || 0;
    const joined      = referrals?.filter(r => r.status === "completed" || r.status === "rewarded").length || 0;
    const monthsEarned = referrals?.filter(r => r.status === "rewarded").length || 0;

    res.json({ success: true, code, total, joined, monthsEarned });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /referral/track — record a referral when someone signs up via a ref link
app.post("/referral/track", requireAuth, async (req, res) => {
  const { referral_code } = req.body;
  const referred_user_id  = req.user.id;
  const referred_email    = req.user.email || null;

  if (!referral_code) return res.status(400).json({ success: false, error: "referral_code required." });
  try {
    const { data: referrer } = await supabase.from("user_profiles")
      .select("user_id, email").eq("referral_code", referral_code).single();

    if (!referrer) return res.status(404).json({ success: false, error: "Invalid referral code." });
    if (referrer.user_id === referred_user_id) return res.status(400).json({ success: false, error: "Cannot refer yourself." });

    const { data: existing } = await supabase.from("referrals")
      .select("id").eq("referred_user_id", referred_user_id).limit(1);
    if (existing?.length) return res.json({ success: true, already_tracked: true });

    await supabase.from("referrals").insert({
      referrer_email:   referrer.email,
      referrer_user_id: referrer.user_id,
      referred_email,
      referred_user_id,
      status: "pending",
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /referral/reward — manually trigger referral reward (backup to webhook)
app.post("/referral/reward", requireAuth, async (req, res) => {
  try {
    const { data: referral } = await supabase.from("referrals")
      .select("*").eq("referred_user_id", req.user.id).eq("status", "pending").single();
    if (!referral) return res.json({ success: true, no_referral: true });
    await processReferralReward(referral);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── WHITE LABEL ─────────────────────────────────────────────────────────────

// GET /whitelabel/admin — must be before /:id or Express matches "admin" as an id
app.get("/whitelabel/admin", requireAuth, async (req, res) => {
  const email = req.user.email;
  if (!email) return res.status(400).json({ success: false, error: "Authenticated email required." });
  try {
    const { data: account, error } = await supabase.from("white_label_accounts")
      .select("*")
      .eq("owner_email", email)
      .single();
    if (error || !account) return res.status(404).json({ success: false, error: "No white label account found." });

    const { count } = await supabase.from("sessions")
      .select("*", { count: "exact", head: true })
      .eq("white_label_id", account.id);

    res.json({ success: true, account, session_count: count || 0 });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /whitelabel/domain/:domain — must be before /:id
app.get("/whitelabel/domain/:domain", async (req, res) => {
  try {
    const { data, error } = await supabase.from("white_label_accounts")
      .select("id, brand_name, brand_color, brand_logo_url, plan, active")
      .eq("custom_domain", req.params.domain)
      .eq("active", true)
      .single();
    if (error || !data) return res.status(404).json({ success: false, error: "Not found." });
    res.json({ success: true, account: data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/whitelabel/:id", async (req, res) => {
  try {
    const { data, error } = await supabase.from("white_label_accounts")
      .select("id, brand_name, brand_color, brand_logo_url, custom_domain, plan, active")
      .eq("id", req.params.id)
      .single();
    if (error || !data) return res.status(404).json({ success: false, error: "White label account not found." });
    res.json({ success: true, account: data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.put("/whitelabel/:id", requireAuth, async (req, res) => {
  const email = req.user.email;
  const { brand_name, brand_color, brand_logo_url, custom_domain } = req.body;
  try {
    const { data: existing } = await supabase.from("white_label_accounts")
      .select("id")
      .eq("id", req.params.id)
      .eq("owner_email", email)
      .single();
    if (!existing) return res.status(403).json({ success: false, error: "Not authorized." });

    const updates = {};
    if (brand_name     !== undefined) updates.brand_name     = brand_name;
    if (brand_color    !== undefined) updates.brand_color    = brand_color;
    if (brand_logo_url !== undefined) updates.brand_logo_url = brand_logo_url;
    if (custom_domain  !== undefined) updates.custom_domain  = custom_domain;

    const { data, error } = await supabase.from("white_label_accounts")
      .update(updates).eq("id", req.params.id).select().single();
    if (error) throw new Error(error.message);
    res.json({ success: true, account: data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/whitelabel/register", async (req, res) => {
  const { brand_name, brand_color, brand_logo_url, custom_domain, plan, email } = req.body;
  if (!brand_name || !plan || !email) {
    return res.status(400).json({ success: false, error: "brand_name, plan, and email are required." });
  }
  const priceMap = {
    basic:        process.env.WL_PRICE_BASIC,
    professional: process.env.WL_PRICE_PROFESSIONAL,
    enterprise:   process.env.WL_PRICE_ENTERPRISE,
  };
  const priceId = priceMap[plan];
  if (!priceId) return res.status(400).json({ success: false, error: "Invalid plan or pricing not configured." });

  try {
    const { data: account, error } = await supabase.from("white_label_accounts").insert({
      owner_email:    email,
      brand_name,
      brand_color:    brand_color    || "#a8d8c8",
      brand_logo_url: brand_logo_url || null,
      custom_domain:  custom_domain  || null,
      plan,
      active: false,
    }).select().single();
    if (error) throw new Error(error.message);

    const session = await stripeClient.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "subscription",
      customer_email: email,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${APP_URL}/whitelabel?registered=true&wl_id=${account.id}`,
      cancel_url:  `${APP_URL}/whitelabel`,
      metadata: { type: "whitelabel", wl_id: account.id, plan },
    });

    res.json({ success: true, checkoutUrl: session.url, wl_id: account.id });
  } catch (err) {
    console.error("WL register error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/corporate-inquiry", async (req, res) => {
  const { name, email, company, role, teamSize, useCase, timeline, message } = req.body;
  if (!name || !email || !company) {
    return res.status(400).json({ success: false, error: "Name, email, and company are required." });
  }
  const resend = getResendClient();
  if (!resend) return res.status(500).json({ success: false, error: "Email service unavailable." });
  try {
    await resend.emails.send({
      from: FROM,
      to: "support@mindtranceformapp.com",
      subject: `Corporate inquiry — ${company} (${name})`,
      html: emailWrap(
        h(`Corporate Inquiry: ${company}`) +
        p(`<strong style="color:#e8e6f0;">Name:</strong> ${name}`) +
        p(`<strong style="color:#e8e6f0;">Email:</strong> ${email}`) +
        p(`<strong style="color:#e8e6f0;">Company:</strong> ${company}`) +
        (role     ? p(`<strong style="color:#e8e6f0;">Role:</strong> ${role}`)                    : "") +
        (teamSize ? p(`<strong style="color:#e8e6f0;">Team size:</strong> ${teamSize}`)            : "") +
        (useCase  ? p(`<strong style="color:#e8e6f0;">Use case:</strong> ${useCase}`)             : "") +
        (timeline ? p(`<strong style="color:#e8e6f0;">Timeline:</strong> ${timeline}`)            : "") +
        (message  ? p(`<strong style="color:#e8e6f0;">Message:</strong><br>${message}`)           : "")
      ),
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── TESTIMONIALS ────────────────────────────────────────────────────────────

app.post("/testimonial", requireAuth, async (req, res) => {
  const { user_name, program, rating, message } = req.body;
  if (!rating || rating < 1 || rating > 5) {
    return res.status(400).json({ success: false, error: "rating (1–5) required." });
  }
  try {
    await supabase.from("testimonials").insert({
      user_id:    req.user.id,
      user_email: req.user.email || null,
      user_name:  user_name || "Anonymous",
      program:    program   || null,
      rating,
      message:    message   || null,
      approved:   false,
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/testimonials", async (_req, res) => {
  const { data, error } = await supabase.from("testimonials")
    .select("id, user_name, program, rating, message, created_at")
    .eq("approved", true)
    .order("created_at", { ascending: false })
    .limit(6);
  if (error) return res.status(500).json({ success: false, error: error.message });
  res.json({ success: true, testimonials: data || [] });
});

app.get("/admin/testimonials", requireAdmin, async (_req, res) => {
  const { data, error } = await supabase.from("testimonials")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) return res.status(500).json({ success: false, error: error.message });
  res.json({ success: true, testimonials: data || [] });
});

app.put("/admin/testimonials/:id/approve", requireAdmin, async (req, res) => {
  const { error } = await supabase.from("testimonials")
    .update({ approved: true }).eq("id", req.params.id);
  if (error) return res.status(500).json({ success: false, error: error.message });
  res.json({ success: true });
});

app.post("/admin/grant-access", requireAdmin, async (req, res) => {
  const { email, plan } = req.body;
  if (!email || !plan) {
    return res.status(400).json({ success: false, error: "email and plan are required" });
  }
  const { error } = await supabase.from("user_profiles").update({
    plan,
    is_subscriber: true,
    subscription_status: "active",
  }).eq("email", email);
  if (error) return res.status(500).json({ success: false, error: error.message });
  res.json({ success: true, message: `Granted ${plan} access to ${email}` });
});

// ─── CONTENT CALENDAR ADMIN ──────────────────────────────────────────────────
app.get("/admin/content", requireAdmin, async (req, res) => {
  const { type, status, limit = 100 } = req.query;
  let q = supabase.from("content_calendar").select("*").order("generated_at", { ascending: false }).limit(Number(limit));
  if (type)   q = q.eq("type", type);
  if (status) q = q.eq("status", status);
  const { data, error } = await q;
  if (error) return res.status(500).json({ success: false, error: error.message });
  res.json({ success: true, items: data || [] });
});

app.put("/admin/content/:id/status", requireAdmin, async (req, res) => {
  const { status } = req.body;
  const validStatuses = ["draft", "approved", "posted"];
  if (!validStatuses.includes(status)) return res.status(400).json({ success: false, error: "Invalid status" });
  const update = { status };
  if (status === "posted") update.posted_at = new Date().toISOString();
  const { error } = await supabase.from("content_calendar").update(update).eq("id", req.params.id);
  if (error) return res.status(500).json({ success: false, error: error.message });
  res.json({ success: true });
});

// ─── BLOG ────────────────────────────────────────────────────────────────────
app.get("/blog/posts", async (req, res) => {
  const { data, error } = await supabase
    .from("blog_posts")
    .select("id, title, slug, excerpt, topic, published_at, created_at")
    .eq("status", "published")
    .order("published_at", { ascending: false })
    .limit(20);
  if (error) return res.status(500).json({ success: false, error: error.message });
  res.json({ success: true, posts: data || [] });
});

app.get("/blog/posts/:slug", async (req, res) => {
  const { data, error } = await supabase
    .from("blog_posts")
    .select("*")
    .eq("slug", req.params.slug)
    .eq("status", "published")
    .single();
  if (error || !data) return res.status(404).json({ success: false, error: "Post not found" });
  res.json({ success: true, post: data });
});

app.post("/admin/blog/generate", requireAdmin, async (req, res) => {
  try {
    const result = await require("./contentEngine").generateBlogPost();
    if (!result) return res.status(500).json({ success: false, error: "Generation failed" });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.put("/admin/blog/:id/publish", requireAdmin, async (req, res) => {
  const { error } = await supabase
    .from("blog_posts")
    .update({ status: "published", published_at: new Date().toISOString() })
    .eq("id", req.params.id);
  if (error) return res.status(500).json({ success: false, error: error.message });
  res.json({ success: true });
});

app.get("/admin/blog", requireAdmin, async (_req, res) => {
  const { data, error } = await supabase
    .from("blog_posts")
    .select("id, title, slug, topic, status, created_at, published_at")
    .order("created_at", { ascending: false });
  if (error) return res.status(500).json({ success: false, error: error.message });
  res.json({ success: true, posts: data || [] });
});

// ─── CONTENT CRON ENDPOINTS ──────────────────────────────────────────────────
function verifyCron(req, res) {
  if (req.headers["x-cron-secret"] !== process.env.CRON_SECRET) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

app.post("/cron/daily-content", async (req, res) => {
  if (!verifyCron(req, res)) return;
  try {
    const summary = await runDailyContentGeneration();
    res.json({ success: true, ...summary });
  } catch (err) {
    console.error("Cron daily-content error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/cron/daily-outreach", async (req, res) => {
  if (!verifyCron(req, res)) return;
  try {
    const summary = await runDailyOutreach();
    res.json({ success: true, ...summary });
  } catch (err) {
    console.error("Cron daily-outreach error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/cron/weekly-content", async (req, res) => {
  if (!verifyCron(req, res)) return;
  try {
    const summary = await runWeeklyContentGeneration();
    res.json({ success: true, ...summary });
  } catch (err) {
    console.error("Cron weekly-content error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── RESEND WEBHOOK (email open/click tracking) ───────────────────────────────
app.post("/webhook/resend", express.json(), async (req, res) => {
  try {
    const { type, data } = req.body || {};
    if (!type || !data) return res.json({ received: true });

    // type examples: "email.opened", "email.clicked", "email.bounced", "email.complained"
    const eventType = type.replace("email.", ""); // "opened", "clicked", etc.
    const resendId  = data.email_id || null;

    if (resendId) {
      await supabase.from("email_events").insert({
        event_type: eventType,
        resend_email_id: resendId,
        metadata: data,
      });
    }
    res.json({ received: true });
  } catch (err) {
    console.error("[webhook/resend]", err.message);
    res.json({ received: true }); // always 200 to Resend
  }
});

app.listen(PORT, () => {
  console.log(`Mind Tranceform backend running on port ${PORT}`);
  console.log(`ElevenLabs key loaded: ${process.env.ELEVENLABS_API_KEY ? "YES" : "MISSING"}`);
  console.log(`Resend key loaded:     ${process.env.RESEND_API_KEY ? "YES" : "MISSING"}`);
  console.log(`Email FROM address:    ${FROM}`);
  console.log(`App URL:               ${APP_URL}`);
  console.log(`Stripe key mode:       ${(process.env.STRIPE_SECRET_KEY || "").startsWith("sk_live") ? "LIVE" : (process.env.STRIPE_SECRET_KEY || "").startsWith("sk_test") ? "TEST" : "MISSING"}`);
});
