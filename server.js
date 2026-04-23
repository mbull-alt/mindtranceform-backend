const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const axios = require("axios");
const stripe = require("stripe");
const { createClient } = require("@supabase/supabase-js");
const { exec } = require("child_process");
const { randomUUID } = require("crypto");
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

async function requireAdmin(req, res, next) {
  // Legacy x-admin-key support (cron jobs, CLI)
  const adminKey = process.env.ADMIN_KEY;
  if (adminKey && req.headers["x-admin-key"] === adminKey) return next();

  // JWT-based: accept any logged-in user whose email matches ADMIN_EMAIL
  const adminEmail = process.env.ADMIN_EMAIL;
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (adminEmail && token) {
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (!error && user?.email === adminEmail) return next();
  }

  return res.status(401).json({ error: "Unauthorized" });
}

// ─── VOICE MAP ───────────────────────────────────────────────────────────────
// Default IDs are well-known ElevenLabs library voices.
// Override any slot via the corresponding environment variable in Render.
const VOICE_MAP = {
  "Female Calm":        process.env.ELEVENLABS_VOICE_FEMALE_CALM    || "XrExE9yKIg1WjnnlVkGX", // Matilda — naturally slow and warm
  "Female Warm":        process.env.ELEVENLABS_VOICE_FEMALE_WARM    || "EXAVITQu4vr4xnSDxMaL", // Bella
  "Female Whisper":     process.env.ELEVENLABS_VOICE_FEMALE_WHISPER || "ThT5KcBeYPX3keUQqHPh", // Dorothy
  "Female British":     process.env.ELEVENLABS_VOICE_FEMALE_BRITISH || "XB0fDUnXU5powFXDhCwa", // Charlotte
  "Male Calm":          process.env.ELEVENLABS_VOICE_MALE_CALM      || "onwK4e9ZLuTAKqWW03F9", // Daniel — calm British
  "Male Deep Hypnosis": process.env.ELEVENLABS_VOICE_MALE_DEEP      || "N2lVS1w4EtoT3dr4eOWO", // Callum — slow and measured
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
    &nbsp;·&nbsp; <a href="${APP_URL}/unsubscribe" style="color:#8a879e;text-decoration:none;">Unsubscribe</a>
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
    const welcomeBody = [
      "Welcome to Mind Tranceform",
      "",
      "Your personalized meditation and hypnosis session is ready to create — it takes less than 2 minutes.",
      "",
      "Tell us your name and goal. We'll write a script just for you, voice it with AI, and layer it with healing frequencies. It's entirely yours.",
      "",
      `Create your session: ${APP_URL}`,
      "",
      "You're receiving this because you signed up for Mind Tranceform.",
      `Unsubscribe: ${APP_URL}/unsubscribe`,
    ].join("\n");
    const result = await resend.emails.send({
      from: FROM,
      reply_to: "support@mindtranceformapp.com",
      to: email,
      subject: "Your free session is ready — create it now",
      text: welcomeBody,
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
  const deliveryText = [
    `Your session is ready, ${name}`,
    "",
    `Your personalized ${program} session has been created with a ${voice} voice.`,
    "Open the app to listen, or read your script below.",
    "",
    previewScript,
    "",
    `Listen in the app: ${APP_URL}`,
    "",
    "You're receiving this because you signed up for Mind Tranceform.",
    `Unsubscribe: ${APP_URL}/unsubscribe`,
  ].join("\n");
  try {
    const result = await resend.emails.send({
      from: FROM,
      reply_to: "support@mindtranceformapp.com",
      to: email,
      subject: `Your ${program} session is ready, ${name}`,
      text: deliveryText,
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
    (async () => {
      const { error } = await supabase.from("email_events").insert({ user_id: userId, email, email_type: type, event_type: "sent", resend_email_id: resendId });
      if (error) console.error("[email_events] insert:", error.message);
    })();
    return true;
  } catch (err) {
    console.error(`[email] sequence day=${day} FAILED to=${email} — ${err?.message}`, err?.response?.data ?? err);
    return false;
  }
}

// ─── SCRIPT CLEANING ─────────────────────────────────────────────────────────
// Strip stage directions and fix formatting before sending to ElevenLabs.
// SSML <break time="Xs"/> tags are intentional and must be preserved — they
// are the only reliable pause mechanism with eleven_multilingual_v2.
function cleanScriptForTTS(script) {
  return script
    // Remove parenthetical stage directions — ElevenLabs reads them aloud
    .replace(/\(pause\)/gi, " ")
    .replace(/\(breathe\)/gi, " ")
    .replace(/\(slow breath\)/gi, " ")
    .replace(/\(exhale\)/gi, " ")
    .replace(/\(inhale\)/gi, " ")
    .replace(/\([^)]{1,60}\)/g, " ")
    // Convert any stray dot-sequences (4+ dots) the AI may still generate into
    // a 1.5s break tag so pauses are never lost even if the prompt is ignored
    .replace(/\.{4,}/g, ' <break time="1.5s"/> ')
    // Collapse runs of 3+ spaces to a single space
    .replace(/ {3,}/g, " ")
    // Tidy up blank lines
    .replace(/^\s*[\r\n]/gm, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ─── AUDIO TEMPO ─────────────────────────────────────────────────────────────
// Slow the ElevenLabs audio buffer to `tempo` (0.5 = 50% speed) using
// ffmpeg's atempo filter, which preserves pitch. Falls back to the original
// buffer if ffmpeg is unavailable or fails.
// NOTE: atempo minimum is 0.5. To go slower, chain two filters (e.g. 0.5,0.5 = 0.25x).
function slowDownAudio(inputBuffer, tempo = 0.5) {
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

    // For tempo >= 0.5, a single atempo filter is sufficient.
    // For tempo < 0.5, chain two filters: e.g. atempo=0.5,atempo=0.5 = 0.25x
    const filterStr = tempo >= 0.5
      ? `atempo=${tempo}`
      : `atempo=0.5,atempo=${(tempo / 0.5).toFixed(4)}`;

    exec(
      `ffmpeg -i "${inputPath}" -filter:a "${filterStr}" -y "${outputPath}"`,
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

// ─── MP3 RE-MUX ──────────────────────────────────────────────────────────────
// Re-encode a concatenated MP3 buffer into a single clean CBR stream with a
// proper Xing/Info header so the browser reports the correct total duration.
// Rejects with code REMUX_FAILED on ffmpeg error so the caller can distinguish
// infrastructure failures from ElevenLabs failures.
function remuxMp3(inputBuffer) {
  return new Promise((resolve, reject) => {
    const tag = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const inputPath  = path.join(os.tmpdir(), `mt_concat_in_${tag}.mp3`);
    const outputPath = path.join(os.tmpdir(), `mt_remux_out_${tag}.mp3`);
    const cleanup = () => {
      try { fs.unlinkSync(inputPath);  } catch {}
      try { fs.unlinkSync(outputPath); } catch {}
    };
    try { fs.writeFileSync(inputPath, inputBuffer); } catch (err) {
      const e = Object.assign(new Error(`ffmpeg write failed: ${err.message}`), { code: "REMUX_FAILED" });
      return reject(e);
    }
    exec(
      `ffmpeg -y -i "${inputPath}" -af "loudnorm=I=-16:LRA=11:TP=-1.5" -c:a libmp3lame -b:a 128k -f mp3 "${outputPath}"`,
      { timeout: 120000 },
      (err, _stdout, stderr) => {
        if (err) {
          console.error("[remux] ffmpeg failed:", err.message);
          if (stderr) console.error("[remux] ffmpeg stderr:", stderr.slice(-2000));
          cleanup();
          const e = Object.assign(new Error(`ffmpeg re-mux failed: ${err.message}`), { code: "REMUX_FAILED", stderr });
          return reject(e);
        }
        try {
          const remuxed = fs.readFileSync(outputPath);
          cleanup();
          console.log(`[remux] complete: ${inputBuffer.length} → ${remuxed.length} bytes`);
          resolve(remuxed);
        } catch (readErr) {
          cleanup();
          const e = Object.assign(new Error(`ffmpeg output unreadable: ${readErr.message}`), { code: "REMUX_FAILED" });
          reject(e);
        }
      }
    );
  });
}

// Run ffprobe on a buffer and return the duration in seconds, or null if
// ffprobe is unavailable or the file is unreadable.
function probeDuration(inputBuffer) {
  return new Promise((resolve) => {
    const tag = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const inputPath = path.join(os.tmpdir(), `mt_probe_${tag}.mp3`);
    try { fs.writeFileSync(inputPath, inputBuffer); } catch { return resolve(null); }
    exec(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${inputPath}"`,
      { timeout: 30000 },
      (err, stdout) => {
        try { fs.unlinkSync(inputPath); } catch {}
        if (err || !stdout?.trim()) return resolve(null);
        const d = parseFloat(stdout.trim());
        resolve(isFinite(d) ? d : null);
      }
    );
  });
}

// ─── AUDIO PADDING ───────────────────────────────────────────────────────────
// Pad the audio buffer with silence at the end to reach targetSeconds duration.
// This is free — no API calls, no tokens. Used to fill remaining time after
// slowing when the generated script is still shorter than requested.
function padAudioToTarget(inputBuffer, targetSeconds) {
  return new Promise((resolve) => {
    const tag = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const inputPath  = path.join(os.tmpdir(), `tts_pad_in_${tag}.mp3`);
    const outputPath = path.join(os.tmpdir(), `tts_pad_out_${tag}.mp3`);

    const cleanup = () => {
      try { fs.unlinkSync(inputPath);  } catch {}
      try { fs.unlinkSync(outputPath); } catch {}
    };

    try {
      fs.writeFileSync(inputPath, inputBuffer);
    } catch (err) {
      console.warn("[audio] pad: could not write temp file:", err.message);
      return resolve(inputBuffer);
    }

    // Get the actual duration first
    exec(
      `ffprobe -i "${inputPath}" -show_entries format=duration -v quiet -of csv=p=0`,
      (probeErr, stdout) => {
        const actualDuration = parseFloat((stdout || "").trim());
        if (probeErr || isNaN(actualDuration)) {
          console.warn("[audio] pad: ffprobe failed, skipping padding");
          cleanup();
          return resolve(inputBuffer);
        }

        console.log(`[audio] pad: actual=${actualDuration.toFixed(1)}s target=${targetSeconds}s`);

        if (actualDuration >= targetSeconds) {
          // Already long enough — no padding needed
          console.log("[audio] pad: already at or above target, skipping");
          cleanup();
          return resolve(inputBuffer);
        }

        const padSeconds = Math.ceil(targetSeconds - actualDuration);
        console.log(`[audio] pad: adding ${padSeconds}s of silence`);

        exec(
          `ffmpeg -i "${inputPath}" -af "apad=pad_dur=${padSeconds}" -t ${targetSeconds} -y "${outputPath}"`,
          { timeout: 60000 },
          (padErr) => {
            if (padErr) {
              console.warn("[audio] pad: ffmpeg apad failed:", padErr.message);
              cleanup();
              return resolve(inputBuffer);
            }
            try {
              const padded = fs.readFileSync(outputPath);
              cleanup();
              console.log(`[audio] pad complete — ${inputBuffer.length} → ${padded.length} bytes`);
              resolve(padded);
            } catch (readErr) {
              console.warn("[audio] pad: could not read output:", readErr.message);
              cleanup();
              resolve(inputBuffer);
            }
          }
        );
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
  const { name, goal, program, voice, background, length, style, personalization, fears, motivation, idealLife, deepQ1, deepQ2, deepQ3, deepQ4, affirmationStyle, backgroundIntensity } = req.body;
  console.log(`[generate] Received: name=${name}, program=${program}, length=${length}, style=${style}, personalization=${personalization}`);
  if (!name || !goal || !program) return res.status(400).json({ success: false, error: "Name, goal, and program are required." });
  const mins = parseInt(length) || 5;
  // Per-chunk limit sent to ElevenLabs. Script is always split into chunks regardless of
  // total length — each chunk is synthesised separately then concatenated in order.
  const ELEVENLABS_CHUNK_LIMIT = 1500;
  // At speed=0.7 on eleven_multilingual_v2, spoken rate is ~105 WPM.
  // Break time is estimated at ~6s per minute of session; subtract it from total
  // time to get the seconds of actual speech needed, then convert to word count.
  const breakSecondsEstimate = mins * 6;
  const spokenSecondsNeeded = (mins * 60) - breakSecondsEstimate;
  const wordTarget = Math.round((spokenSecondsNeeded / 60) * 105);
  // maxTokens: scale with session length; minimum 2000 to prevent cut-off on short sessions.
  // At ~1.3 tokens/word plus SSML overhead, a 1890-word script needs ~3500 tokens minimum.
  // Using mins*300 gives comfortable headroom: 20 min → 6000, 5 min → 2000.
  const maxTokens = Math.max(mins * 300, 2000);
  console.log(`[generate] mins=${mins}, maxTokens=${maxTokens}`);

  // SSE mode: stream progress events as the pipeline advances.
  // Fallback: if the client doesn't send Accept: text/event-stream, return JSON as before.
  const useSSE = req.headers.accept?.includes("text/event-stream");
  let kaTick;
  if (useSSE) {
    res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no" });
    res.flushHeaders();
    kaTick = setInterval(() => { if (!res.writableEnded) res.write(": keepalive\n\n"); }, 30000);
    res.on("close", () => clearInterval(kaTick));
  }
  function emit(data) {
    if (useSSE && !res.writableEnded) res.write(`data: ${JSON.stringify(data)}\n\n`);
  }

  try {
    let rawScript;
    let currentWordCount;

    if (process.env.USE_SECTION_GENERATION === "true") {
      emit({ stage: "script_generating", message: "Writing your session..." });
      rawScript = await generateSessionSections({ name, goal, program, voice, background, style, personalization, fears, motivation, idealLife, deepQ1, deepQ2, deepQ3, deepQ4, affirmationStyle, wordTarget, maxTokens });
      currentWordCount = countSpokenWords(rawScript);
      console.log(`[generate] Section-generated spoken words: ${currentWordCount}, Target: ${wordTarget}`);
    } else {
      const prompt = buildPrompt({ name, goal, program, voice, background, style, personalization, fears, motivation, idealLife, deepQ1, deepQ2, deepQ3, deepQ4, affirmationStyle, backgroundIntensity, wordTarget, mins });
      emit({ stage: "script_generating", message: "Writing your session..." });
      const aiResponse = await axios.post(
        "https://api.openai.com/v1/chat/completions",
        { model: "gpt-4o-mini", messages: [{ role: "user", content: prompt }], max_tokens: maxTokens, temperature: 0.85 },
        { headers: { "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" } }
      );
      rawScript = aiResponse.data.choices[0]?.message?.content?.trim();
      if (!rawScript) throw new Error("No script returned from AI.");

    // ── Diagnostic: log raw LLM output before any processing ─────────────────
    {
      const rawStripped = countSpokenWords(rawScript);
      console.log(`[LLM RAW] char_count=${rawScript.length} stripped_word_count=${rawStripped} first_200_chars="${rawScript.slice(0, 200).replace(/\n/g, "\\n")}" last_200_chars="${rawScript.slice(-200).replace(/\n/g, "\\n")}"`);
    }

    // Validate word count — SSML tags stripped before counting (never count raw script).
    currentWordCount = countSpokenWords(rawScript);
    console.log(`[generate] Initial spoken words: ${currentWordCount}, Target: ${wordTarget}`);

    // Expansion loop: ask LLM to return the full expanded script (not just a continuation).
    // Max 2 retries to avoid runaway API costs; logs a warning if still short after retries.
    for (let attempt = 0; attempt < 2 && currentWordCount < wordTarget; attempt++) {
      const shortfall = wordTarget - currentWordCount;
      console.log(`[generate] Expansion attempt ${attempt + 1}: ${currentWordCount} spoken words, need ${wordTarget} (shortfall ${shortfall})`);
      emit({ stage: "script_expanding", attempt: attempt + 1, wordCount: currentWordCount, target: wordTarget, message: "Expanding script..." });
      const expandResponse = await axios.post(
        "https://api.openai.com/v1/chat/completions",
        {
          model: "gpt-4o-mini",
          messages: [{
            role: "user",
            content: `Your previous script was ${currentWordCount} spoken words but needs a minimum of ${wordTarget} spoken words. SSML tags like <break time="3s"/> do NOT count as words — count only actual spoken words. Expand the therapeutic content and reinforcement sections with additional imagery, repetition of suggestions in varied wording, and deeper sensory detail. Return the FULL expanded script — do not shorten any existing content. Do not add titles, labels, or commentary.\n\nScript to expand:\n${rawScript}`,
          }],
          max_tokens: maxTokens,
          temperature: 0.85,
        },
        { headers: { "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" } }
      );
      const expanded = expandResponse.data.choices[0]?.message?.content?.trim();
      if (expanded) {
        console.log(`[LLM EXPAND ${attempt + 1}] char_count=${expanded.length} stripped_word_count=${countSpokenWords(expanded)} first_200_chars="${expanded.slice(0, 200).replace(/\n/g, "\\n")}" last_200_chars="${expanded.slice(-200).replace(/\n/g, "\\n")}"`);
        rawScript = expanded;
        currentWordCount = countSpokenWords(rawScript);
      }
      console.log(`[generate] After expansion ${attempt + 1}: ${currentWordCount} spoken words`);
    }
    if (currentWordCount < wordTarget) {
      console.warn(`[generate] Script still under target after expansions: ${currentWordCount}/${wordTarget} — proceeding anyway`);
    }
    console.log(`[generate] Final spoken words: ${currentWordCount}, Target: ${wordTarget}`);

    // Validate that awakening language does not appear before the final 10% of paragraphs.
    // Awakening language in the last 10% is correct placement — do not flag it.
    const validationParagraphs = rawScript.split(/\n\n+/).filter(Boolean);
    const awakeningPhrases = [
      "open your eyes", "coming back", "returning to the room",
      "wiggle your fingers", "count from 1 to 5", "count to five", "wide awake",
    ];
    const safeZoneStart = Math.floor(validationParagraphs.length * 0.9);
    const earlyAwakeningIndex = validationParagraphs
      .slice(0, safeZoneStart)
      .findIndex(p => awakeningPhrases.some(phrase => p.toLowerCase().includes(phrase)));
    if (earlyAwakeningIndex !== -1) {
      console.warn(`[SCRIPT VALIDATION] Awakening language found in paragraph ${earlyAwakeningIndex + 1}/${validationParagraphs.length} (safe zone starts at ${safeZoneStart}) — regenerating`);
      const correctionPrompt = buildPrompt({ name, goal, program, voice, background, style, personalization, fears, motivation, idealLife, deepQ1, deepQ2, deepQ3, deepQ4, affirmationStyle, backgroundIntensity, wordTarget, mins })
        + `\n\nIMPORTANT: Your previous attempt contained awakening language mid-session. Do not repeat this. Also, you MUST write the full ${wordTarget} words — do not write a shorter script.`;
      const regenResponse = await axios.post(
        "https://api.openai.com/v1/chat/completions",
        { model: "gpt-4o-mini", messages: [{ role: "user", content: correctionPrompt }], max_tokens: maxTokens, temperature: 0.85 },
        { headers: { "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" } }
      );
      const regenScript = regenResponse.data.choices[0]?.message?.content?.trim();
      if (regenScript) {
        rawScript = regenScript;
        currentWordCount = countSpokenWords(rawScript);
        console.log(`[SCRIPT VALIDATION] Regenerated spoken word count: ${currentWordCount}`);
        if (currentWordCount < wordTarget * 0.85) {
          throw new Error(`Regenerated script too short: ${currentWordCount} words (target: ${wordTarget})`);
        }
      }
    }
    } // end else (single-call path)

    // Normalize malformed SSML break tags from LLM output before TTS.
    // The LLM frequently produces <break time="3s/> (missing closing quote) or
    // <break time='3s'/> — ElevenLabs silently ignores these, killing all pauses.
    {
      const breaksBefore = (rawScript.match(/<break/gi) || []).length;
      rawScript = rawScript.replace(/<break\s+time=["']?([\d.]+)s["']?\s*\/?>/gi, '<break time="$1s"/>');
      const breaksAfter = (rawScript.match(/<break\s+time="[\d.]+s"\s*\/>/g) || []).length;
      console.log(`[SSML FIX] normalized break tags: ${breaksAfter} valid out of ${breaksBefore} found`);
    }

    // ssmlScript — retains <break> tags for ElevenLabs audio generation
    const ssmlScript = cleanScriptForTTS(rawScript);
    const preTTSWordCount = countSpokenWords(ssmlScript);
    console.log(`[generate] Pre-TTS stripped word count: ${preTTSWordCount} words (target: ${wordTarget}, ${Math.round(preTTSWordCount / wordTarget * 100)}% of target)`);

    // cleanScript — all XML/SSML tags stripped; used for display, storage, email.
    // IMPORTANT: convert <break> tags to newlines FIRST so pause points become
    // paragraph breaks in the displayed text instead of collapsing into one long paragraph.
    const cleanScript = ssmlScript
      .replace(/<break[^>]*\/>/g, "\n\n")  // convert SSML break tags → paragraph breaks
      .replace(/<[^>]*>/g, "")             // strip any remaining XML/SSML tags
      .replace(/[ \t]{2,}/g, " ")          // collapse horizontal whitespace only
      .replace(/\n[ \t]+/g, "\n")          // remove leading spaces on new lines
      .replace(/\n{3,}/g, "\n\n")          // normalise to at most double newlines
      .trim();

    console.log(`wordTarget: ${wordTarget}`);

    const voiceId = VOICE_MAP[voice] || VOICE_MAP["Female Calm"];
    let audioBase64 = null;
    let audioUnavailable = false;

    // ── Diagnostic: state of script entering TTS pipeline ────────────────────
    console.log(`[PRE-CHUNK] char_count=${ssmlScript.length} stripped_word_count=${preTTSWordCount}`);

    const ttsChunks = splitIntoTTSChunks(ssmlScript, ELEVENLABS_CHUNK_LIMIT);
    const modelId = "eleven_multilingual_v2";
    const voiceSettings = { stability: 0.85, similarity_boost: 0.75, speed: 0.7 };

    // ── SCRIPT STATS — ground truth before TTS ────────────────────────────────
    const scriptBreakMatches = [...ssmlScript.matchAll(/<break\s+time="([\d.]+)s"\s*\/>/g)];
    const estimatedBreakSeconds = scriptBreakMatches.reduce((sum, m) => sum + parseFloat(m[1]), 0);
    const estimatedTotalDuration = Math.round((preTTSWordCount / 105) * 60 + estimatedBreakSeconds);
    console.log(`[SCRIPT STATS] target_minutes=${mins} word_target=${wordTarget} stripped_word_count=${preTTSWordCount}`);
    console.log(`[SCRIPT STATS] break_count=${scriptBreakMatches.length} estimated_break_seconds=${Math.round(estimatedBreakSeconds)} estimated_total_duration_seconds=${estimatedTotalDuration}`);
    console.log(`[AUDIO STATS] Chunks: ${ttsChunks.length}, sizes: [${ttsChunks.map(c => c.length).join(", ")}], model: ${modelId}`);

    try {
      const audioBuffers = [];
      for (let i = 0; i < ttsChunks.length; i++) {
        // Prepend a silent break to chunk 0 so the model initialises before speaking.
        const chunkText = i === 0 ? '<break time="2s"/> ' + ttsChunks[i] : ttsChunks[i];
        console.log(`[CHUNK ${i + 1}/${ttsChunks.length}] char_count=${chunkText.length} first_80_chars="${chunkText.slice(0, 80).replace(/\n/g, "\\n")}"`);
        emit({ stage: "synthesizing", chunk: i + 1, totalChunks: ttsChunks.length, message: `Generating voice, ${i + 1} of ${ttsChunks.length}...` });
        const chunkBuf = await synthesizeChunkWithRetry(voiceId, chunkText, modelId, voiceSettings);
        audioBuffers.push(chunkBuf);
        const chunkEstSecs = Math.round(chunkBuf.length / 16000);
        console.log(`[CHUNK ${i + 1} DONE] byte_count=${chunkBuf.length} estimated_seconds=${chunkEstSecs}`);
      }
      const rawConcatenated = Buffer.concat(audioBuffers);
      console.log(`[AUDIO STATS] Audio bytes per chunk: [${audioBuffers.map(b => b.length).join(", ")}]`);
      console.log(`[AUDIO STATS] Total raw concat bytes: ${rawConcatenated.length}`);

      // Re-mux concatenated chunks into a single clean CBR MP3 with a proper
      // Xing/Info header — without this the browser reads only the first chunk's
      // metadata and reports the wrong total duration.
      emit({ stage: "remuxing", message: "Finalizing audio..." });
      const finalAudio = await remuxMp3(rawConcatenated);
      audioBase64 = finalAudio.toString("base64");

      // ── Post-TTS duration assertion ────────────────────────────────────────
      const byteEstimatedSecs = Math.round(finalAudio.length / 16000);
      const probedSecs = await probeDuration(finalAudio);
      if (probedSecs !== null) {
        const delta = Math.abs(probedSecs - byteEstimatedSecs);
        const probedMins = Math.floor(probedSecs / 60);
        const probedSecPart = Math.round(probedSecs % 60);
        console.log(`[FINAL AUDIO] duration=${Math.round(probedSecs)}s (${probedMins}:${String(probedSecPart).padStart(2, "0")}) expected=${byteEstimatedSecs}s delta=${Math.round(delta)}s`);
        if (delta > 5) {
          console.error(`[FINAL AUDIO] ASSERTION FAILED — re-mux produced mismatched metadata (delta=${Math.round(delta)}s). Marking audio unavailable.`);
          audioUnavailable = true;
          audioBase64 = null;
        }
      } else {
        const estMins = Math.floor(byteEstimatedSecs / 60);
        const estSecPart = byteEstimatedSecs % 60;
        console.log(`[FINAL AUDIO] ffprobe unavailable — byte-estimate: ${byteEstimatedSecs}s (${estMins}:${String(estSecPart).padStart(2, "0")})`);
      }
      console.log(`[elevenlabs] All ${ttsChunks.length} chunk(s) synthesised`);
    } catch (audioErr) {
      if (audioErr.code === "REMUX_FAILED") {
        console.error(`[remux] Fatal remux error — propagating to outer catch:`, audioErr.message);
        throw audioErr;
      }
      console.error(`[elevenlabs] Audio generation failed: ${audioErr.message}`);
      audioUnavailable = true;
    }

    // Persist user's first name for personalised emails (fire-and-forget)
    if (req.user.id && name) {
      (async () => {
        const { error } = await supabase.from("user_profiles").update({ name }).eq("user_id", req.user.id);
        if (error) console.error("[user_profiles] update name:", error.message);
      })();
    }

    console.log(`[session] Audio size: ${audioBase64?.length || 0} chars, unavailable: ${audioUnavailable}`);
    const tentativeId = randomUUID();
    console.log(`[session] Saving session for user ${req.user.id} (${req.user.email})`);
    emit({ stage: "saving", message: "Almost done..." });
    const { data: insertData, error: insertError } = await supabase.from("sessions").insert({
      id: tentativeId,
      user_id: req.user.id,
      email: req.user.email || null,
      title: `${program} — ${style || "Gentle Meditation"} — ${mins} min`,
      program, voice, background,
      script: cleanScript,
      audio_base64: audioBase64,
      created_at: new Date().toISOString(),
    }).select("id").single();
    if (insertError) {
      console.error("[session] Insert failed:", insertError.message, "code:", insertError.code, "details:", insertError.details);
    } else {
      console.log("[session] Session saved successfully — id:", insertData?.id || tentativeId);
    }
    // Use the id returned by Supabase (handles auto-generated IDs) or fall back to tentativeId
    const sessionId = insertData?.id || tentativeId;

    const { data: old } = await supabase
      .from("sessions").select("id")
      .eq("user_id", req.user.id)
      .order("created_at", { ascending: false })
      .range(10, 1000);
    if (old?.length) await supabase.from("sessions").delete().in("id", old.map((s) => s.id));

    // Send session delivery email (fire-and-forget) — clean script only
    sendSessionDeliveryEmail(req.user.email, { name, program, voice, script: cleanScript }).catch(console.error);

    // Return sessionId so the frontend can stream audio from /sessions/:id/audio
    // Do NOT return audioBase64 in the JSON — 5-10MB base64 inside JSON is too large
    // to parse reliably in the browser and causes the result screen to show unavailable.
    const wordCount = currentWordCount;
    const estimatedMinutes = Math.round((wordCount / 95) * 10) / 10;
    if (useSSE) {
      emit({ stage: "complete", sessionId, script: cleanScript, audioUnavailable });
      clearInterval(kaTick);
      res.end();
    } else {
      return res.json({ success: true, script: cleanScript, sessionId, audioUnavailable, word_count: wordCount, estimated_minutes: estimatedMinutes });
    }
  } catch (err) {
    const message = err?.response?.data?.error?.message || err.message || "Generation failed.";
    console.error("Generation error:", message);
    if (err?.stack) console.error("Generation error stack:", err.stack);
    const userMessage = err?.code === "REMUX_FAILED"
      ? "Audio processing failed. Please try again or contact support."
      : "Generation failed. Please try again.";
    if (useSSE) {
      emit({ stage: "error", message: userMessage });
      clearInterval(kaTick);
      res.end();
    } else {
      return res.status(500).json({ success: false, error: message });
    }
  }
});

// Test endpoint — generates script only, no TTS, no Supabase write. Used to verify
// script length and structure before spending ElevenLabs credits.
app.post("/sessions/test-script", requireAuth, async (req, res) => {
  const { name, goal, program, voice, background, length, style, personalization, fears, motivation, idealLife, deepQ1, deepQ2, deepQ3, deepQ4, affirmationStyle, backgroundIntensity } = req.body;
  if (!name || !goal || !program) return res.status(400).json({ success: false, error: "Name, goal, and program are required." });
  const mins = parseInt(length) || 5;
  const wordTarget = mins * 95;
  const maxTokens = Math.ceil(wordTarget * 2.5);
  console.log(`[test-script] mins=${mins}, wordTarget=${wordTarget}`);
  try {
    const prompt = buildPrompt({ name, goal, program, voice, background, style, personalization, fears, motivation, idealLife, deepQ1, deepQ2, deepQ3, deepQ4, affirmationStyle, backgroundIntensity, wordTarget, mins });
    const aiResponse = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      { model: "gpt-4o-mini", messages: [{ role: "user", content: prompt }], max_tokens: maxTokens, temperature: 0.85 },
      { headers: { "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" } }
    );
    let rawScript = aiResponse.data.choices[0]?.message?.content?.trim();
    if (!rawScript) throw new Error("No script returned from AI.");

    let currentWordCount = rawScript.replace(/<[^>]*>/g, "").trim().split(/\s+/).filter(Boolean).length;
    console.log(`[test-script] Initial word count: ${currentWordCount}, target: ${wordTarget}`);

    for (let attempt = 0; attempt < 5 && currentWordCount < wordTarget * 0.85; attempt++) {
      const shortfall = wordTarget - currentWordCount;
      console.log(`[test-script] Expansion ${attempt + 1}: ${currentWordCount} words, shortfall ${shortfall}`);
      const expandResponse = await axios.post(
        "https://api.openai.com/v1/chat/completions",
        {
          model: "gpt-4o-mini",
          messages: [{
            role: "user",
            content: `The following meditation script has ${currentWordCount} words but needs to be ${wordTarget} words. Continue the script from where it ends, adding approximately ${shortfall} more words of deep relaxation content: extended visualizations with sensory detail, longer affirmation passages, additional breathing exercises, deeper body scan sections, and more guided imagery. Keep the same calm tone and include SSML <break time="Xs"/> pause tags between sections. Do not add any labels or commentary — output only the continuation of the script.\n\nCurrent script:\n${rawScript}`,
          }],
          max_tokens: Math.ceil(shortfall * 2.2),
          temperature: 0.85,
        },
        { headers: { "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" } }
      );
      const addition = expandResponse.data.choices[0]?.message?.content?.trim();
      if (addition) rawScript = rawScript + "\n\n" + addition;
      currentWordCount = rawScript.replace(/<[^>]*>/g, "").trim().split(/\s+/).filter(Boolean).length;
      console.log(`[test-script] After expansion ${attempt + 1}: ${currentWordCount} words`);
    }

    const ssmlScript = cleanScriptForTTS(rawScript);
    const cleanScript = ssmlScript
      .replace(/<break[^>]*\/>/g, "\n\n")
      .replace(/<[^>]*>/g, "")
      .replace(/[ \t]{2,}/g, " ")
      .replace(/\n[ \t]+/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    const wordCount = currentWordCount;
    const estimatedMinutes = Math.round((wordCount / 95) * 10) / 10;
    console.log(`[test-script] Done — word_count=${wordCount}, estimated_minutes=${estimatedMinutes}`);
    return res.json({ script: cleanScript, word_count: wordCount, estimated_minutes: estimatedMinutes });
  } catch (err) {
    const message = err?.response?.data?.error?.message || err.message || "Generation failed.";
    console.error("[test-script] Error:", message);
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

const PREVIEW_TEXT = "Take a slow, deep breath in............... and breathe out, slowly............... allow yourself to relax..........";
const PREVIEW_SETTINGS = {
  model_id: "eleven_multilingual_v2",
  voice_settings: { stability: 0.5, similarity_boost: 0.75 },
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
      { text: "Test.", model_id: "eleven_multilingual_v2", voice_settings: { stability: 0.5, similarity_boost: 0.75 } },
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
  console.log(`[sessions] Fetching sessions for user_id=${req.user.id} email=${req.user.email}`);

  // Primary query: by user_id
  let { data, error } = await supabase
    .from("sessions")
    .select("id, title, program, voice, background, created_at")
    .eq("user_id", req.user.id)
    .order("created_at", { ascending: false })
    .limit(20);

  if (error) {
    console.error("[sessions] user_id query failed:", error.message);
    return res.status(500).json({ success: false, error: error.message });
  }

  // Fallback: if nothing found by user_id, try email (covers sessions saved before auth was stable)
  if ((!data || data.length === 0) && req.user.email) {
    console.log("[sessions] No results by user_id — trying email fallback");
    const fallback = await supabase
      .from("sessions")
      .select("id, title, program, voice, background, created_at")
      .eq("email", req.user.email)
      .order("created_at", { ascending: false })
      .limit(20);
    if (!fallback.error && fallback.data?.length) {
      data = fallback.data;
      console.log(`[sessions] Email fallback returned ${data.length} sessions`);
    }
  }

  console.log(`[sessions] Returning ${data?.length || 0} sessions`);
  res.json({ success: true, sessions: data || [] });
});

app.get("/sessions/:id", requireAuth, async (req, res) => {
  // Excludes audio_base64 — audio is served separately via /sessions/:id/audio
  let { data, error } = await supabase
    .from("sessions")
    .select("id, title, program, voice, background, script, created_at")
    .eq("user_id", req.user.id)
    .eq("id", req.params.id)
    .single();

  // Email fallback for sessions saved before user_id was reliable
  if ((error || !data) && req.user.email) {
    const fb = await supabase
      .from("sessions")
      .select("id, title, program, voice, background, script, created_at")
      .eq("email", req.user.email)
      .eq("id", req.params.id)
      .single();
    if (!fb.error && fb.data) { data = fb.data; error = null; }
  }

  if (error || !data) {
    console.error("[session/:id] Not found:", error?.message, "id:", req.params.id);
    return res.status(404).json({ success: false, error: "Session not found." });
  }
  res.json({ success: true, session: data });
});

// Streams audio for a session as binary audio/mpeg.
// Accepts JWT via Authorization header OR ?token= query param so the
// <audio> element can use it directly as a src URL.
app.get("/sessions/:id/audio", async (req, res) => {
  const token = req.headers.authorization?.replace("Bearer ", "") || req.query.token;
  if (!token) return res.status(401).send("Unauthorized");
  const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !user) return res.status(401).send("Unauthorized");

  let { data, error } = await supabase
    .from("sessions")
    .select("audio_base64")
    .eq("user_id", user.id)
    .eq("id", req.params.id)
    .single();

  // Email fallback
  if ((error || !data) && user.email) {
    const fb = await supabase
      .from("sessions")
      .select("audio_base64")
      .eq("email", user.email)
      .eq("id", req.params.id)
      .single();
    if (!fb.error && fb.data) { data = fb.data; error = null; }
  }

  if (error || !data) return res.status(404).send("Session not found");
  if (!data.audio_base64) return res.status(404).send("No audio for this session");

  const buf = Buffer.from(data.audio_base64, "base64");
  const total = buf.length;
  const rangeHeader = req.headers.range;

  res.set("Content-Type", "audio/mpeg");
  res.set("Accept-Ranges", "bytes");
  res.set("Cache-Control", "private, max-age=3600");

  if (rangeHeader) {
    // Parse "bytes=start-end" — end is optional, defaults to last byte.
    const [, startStr, endStr] = rangeHeader.match(/bytes=(\d+)-(\d*)/) || [];
    const start = parseInt(startStr, 10);
    const end   = endStr ? parseInt(endStr, 10) : total - 1;
    if (isNaN(start) || start >= total || end >= total || start > end) {
      res.set("Content-Range", `bytes */${total}`);
      return res.status(416).send("Range Not Satisfiable");
    }
    const chunkLen = end - start + 1;
    console.log(`[session/:id/audio] Range ${start}-${end}/${total} for ${req.params.id}`);
    res.set("Content-Range", `bytes ${start}-${end}/${total}`);
    res.set("Content-Length", chunkLen);
    res.status(206).end(buf.slice(start, end + 1));
  } else {
    console.log(`[session/:id/audio] Full ${total} bytes for ${req.params.id}`);
    res.set("Content-Length", total);
    res.status(200).end(buf);
  }
});

app.delete("/sessions/:id", requireAuth, async (req, res) => {
  console.log(`[sessions] Deleting session_id=${req.params.id} for user_id=${req.user.id}`);
  const { error } = await supabase
    .from("sessions")
    .delete()
    .eq("user_id", req.user.id)
    .eq("id", req.params.id);
  if (error) {
    console.error("[sessions] Delete failed:", error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
  res.json({ success: true });
});

// ─── TTS HELPERS ─────────────────────────────────────────────────────────────
// Split an SSML script into chunks of at most maxChars, breaking only on
// paragraph boundaries so SSML tags are never split mid-tag.
function splitIntoTTSChunks(text, maxChars = 1500) {
  const paragraphs = text.split(/\n\n+/);
  const chunks = [];
  let current = "";
  for (const para of paragraphs) {
    const candidate = current ? current + "\n\n" + para : para;
    if (candidate.length > maxChars && current.length > 0) {
      chunks.push(current);
      current = para;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks.filter(Boolean);
}

// ─── PROMPT ───────────────────────────────────────────────────────────────────
// ─── SHARED HELPERS ──────────────────────────────────────────────────────────

function countSpokenWords(text) {
  return text.replace(/<[^>]+>/g, "").trim().split(/\s+/).filter(Boolean).length;
}

// ElevenLabs TTS with exponential-backoff retry (immediate → 1 s → 3 s).
// Throws with a user-friendly message after all attempts fail.
async function synthesizeChunkWithRetry(voiceId, chunkText, modelId, voiceSettings) {
  const DELAYS_MS = [0, 1000, 3000];
  for (let attempt = 0; attempt < DELAYS_MS.length; attempt++) {
    if (DELAYS_MS[attempt] > 0) await new Promise(r => setTimeout(r, DELAYS_MS[attempt]));
    let elevenRes;
    try {
      elevenRes = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
        {
          method: "POST",
          headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY, "Content-Type": "application/json" },
          body: JSON.stringify({ text: chunkText, model_id: modelId, voice_settings: voiceSettings, output_format: "mp3_44100_128" }),
        }
      );
    } catch (fetchErr) {
      if (attempt === DELAYS_MS.length - 1)
        throw new Error("Voice synthesis is temporarily unavailable. Please try again shortly.");
      console.warn(`[elevenlabs] Network error attempt ${attempt + 1}: ${fetchErr.message} — retrying in ${DELAYS_MS[attempt + 1]}ms`);
      continue;
    }
    if (!elevenRes.ok) {
      const errBody = await elevenRes.text();
      if (attempt === DELAYS_MS.length - 1)
        throw new Error("Voice synthesis is temporarily unavailable. Please try again shortly.");
      console.warn(`[elevenlabs] HTTP ${elevenRes.status} attempt ${attempt + 1}: ${errBody.slice(0, 200)} — retrying in ${DELAYS_MS[attempt + 1]}ms`);
      continue;
    }
    const buf = Buffer.from(await elevenRes.arrayBuffer());
    if (!buf.length) {
      if (attempt === DELAYS_MS.length - 1)
        throw new Error("Voice synthesis is temporarily unavailable. Please try again shortly.");
      console.warn(`[elevenlabs] Empty audio attempt ${attempt + 1} — retrying in ${DELAYS_MS[attempt + 1]}ms`);
      continue;
    }
    return buf;
  }
}

// ─── SECTION-BY-SECTION SCRIPT GENERATION ────────────────────────────────────
// Enabled via USE_SECTION_GENERATION=true env var.
// Runs five focused LLM calls in parallel — one per session section — then
// concatenates them. Retries any section that is >20 % under its word budget.

const SSML_RULES = `PAUSE NOTATION — use only SSML break tags, never dots or ellipses:
- Between sentences: <break time="1.5s"/>
- After breathing instructions: <break time="3s"/>
- After each countdown number: <break time="3s"/>
- After each affirmation: <break time="2s"/>
- Between major moments: <break time="2.5s"/>

BREATHING FORMAT (write exactly like this):
Breathe in, slowly, through your nose <break time="3s"/> and hold it gently <break time="2s"/> now breathe out, slowly, through your mouth <break time="3s"/> feel your body sink deeper into relaxation <break time="2s"/>

COUNTDOWN FORMAT (write each number like this):
Ten <break time="3s"/> allow yourself to sink deeper <break time="2s"/>
Nine <break time="3s"/> deeper still <break time="2s"/>

RULES: No stage directions. No parenthetical marks like (pause) or (breathe). No dots or ellipses. Output ONLY spoken words and <break> tags. No section headers or labels. Write in second person, slow flowing sentences with long vowels and natural breath points.`;

function buildSectionPrompt(section, budget, ctx) {
  const { name, goal, program, style, personalization, fears, motivation, idealLife, deepQ1, deepQ2, deepQ3, deepQ4, affirmationStyle } = ctx;

  const hasDeepQ  = personalization === "deep" && (deepQ1 || deepQ2 || deepQ3 || deepQ4);
  const hasLegacy = personalization === "deep" && (fears || motivation || idealLife);
  const deepCtx = hasDeepQ
    ? [deepQ1, deepQ2, deepQ3, deepQ4].filter(Boolean).map(q => `- ${q}`).join("\n")
    : hasLegacy
    ? [fears && `Fear/release: ${fears}`, motivation && `Motivation: ${motivation}`, idealLife && `Ideal life: ${idealLife}`].filter(Boolean).join("\n")
    : "";

  const affirmGuide = {
    "I am":          'Use "I am…" affirmations.',
    "You are":       'Use "You are…" affirmations.',
    "Present tense": "Write affirmations as present-tense truths.",
    "Future tense":  "Write affirmations as future certainties.",
  }[affirmationStyle] || 'Use "I am…" affirmations.';

  const footer = `MINIMUM: ${budget} spoken words (SSML tags do not count). Hard floor — expand with more imagery or repetition if you finish early.

${SSML_RULES}

User: ${name} | Goal: "${goal}" | Program: ${program} | Style: ${style || "Gentle Meditation"}${deepCtx ? `\nDeep personalization:\n${deepCtx}` : ""}`;

  const endings = {
    "Sleep":                "End this section with gentle drifting-toward-sleep suggestions.",
    "Stress & Anxiety":     "End with a calming positive anchor for the rest of the day.",
    "Abundance":            "End with vivid visualization of receiving abundance.",
    "Confidence":           "End with a surge of inner certainty and unstoppable self-belief.",
    "Focus & Productivity": "End with a sharp, energized state of clear mental focus.",
    "Quit Smoking":         "End with vivid freedom, clean lungs, and deep pride.",
    "Weight Loss Mindset":  "End with a positive body image and vibrant health visualization.",
    "Relationship Healing": "End with an open heart and readiness for love.",
    "Abundance & Wealth":   "End with a vivid felt sense of financial freedom and certainty.",
  };

  switch (section) {
    case "induction":
      return `Write the INDUCTION section of a personalized hypnosis session for ${name}.

This is the first thing the listener hears. Your job:
1. Welcome ${name} warmly and invite them to settle in
2. Lead exactly 3 complete breathing cycles using the breathing format below
3. Guide a progressive body scan from head to toe (at least 2 sentences per region: scalp, face, neck, shoulders, chest, arms, hands, belly, lower back, hips, legs, feet)
4. Use eye-fixation or downward-gaze suggestions to begin inducing trance
5. End with ${name} feeling heavy, warm, and deeply ready to go further

Do NOT include any countdown, therapeutic suggestions, or awakening language — those come later.
The next section will count ${name} down from 10 to 1.

${footer}`;

    case "deepener":
      return `Write the DEEPENER section of a personalized hypnosis session for ${name}.

${name} just completed a relaxation induction and is already calm but not yet in deep trance.
Your job: deepen their trance state significantly using a countdown.

1. Open with 1–2 transition sentences ("And as you go deeper now…")
2. Count DOWN from 10 to 1 using the countdown format below — after each number write 3–4 lines of deepening suggestions
3. Weave in vivid imagery: a warm staircase descending, a peaceful elevator, a soft cloud
4. End with ${name} in profound, receptive stillness

Do NOT repeat the body scan or breathing exercises from the previous section.
Do NOT include therapeutic suggestions — those come next.

${footer}`;

    case "therapeutic":
      return `Write the THERAPEUTIC CONTENT section of a personalized hypnosis session for ${name}.

${name} is in deep trance and maximally receptive. This is the core and longest section.
Your job: deliver deeply personalized therapeutic suggestions for the program "${program}".

1. Open with 2 sentences acknowledging how deeply relaxed ${name} is
2. Deliver core program suggestions: vivid visualizations, metaphors, and affirmations tied to "${goal}"
3. Create at least 3 distinct visualization scenes with full sensory detail (sight, sound, smell, touch, feeling)
4. Include 6 affirmations tied to "${goal}", each spoken twice with a pause between. ${affirmGuide}
5. Weave "${goal}" throughout — every suggestion should feel personally written for ${name}
6. Use repetition and varied wording to reinforce each suggestion
${endings[program] ? `7. ${endings[program]}` : ""}

CRITICAL: Do NOT include any awakening language. Never say "open your eyes", "returning to the room", "wiggle your fingers", or "wide awake". These are forbidden here.

${footer}`;

    case "reinforcement":
      return `Write the REINFORCEMENT section of a personalized hypnosis session for ${name}.

The therapeutic suggestions have just been delivered. ${name} is still in deep trance.
Your job: anchor the suggestions as permanent, automatic changes.

1. Create a post-hypnotic anchor: a word or sensation that recalls these feelings ("Every time you take a deep breath and say to yourself…")
2. Future-pace: describe how ${name} will feel and act in the coming days and weeks
3. Reinforce that the changes are real, already taking root, and growing stronger daily
4. Use a bridge phrase: "From this moment forward…" or "With every passing day…"
5. End with profound completion and quiet confidence

Do NOT include awakening language — that comes in the very next and final section.

${footer}`;

    case "emergence":
      return `Write the EMERGENCE section of a personalized hypnosis session for ${name}.

All suggestions have been delivered. Your job: gently return ${name} to full waking awareness.

1. Begin: "In a moment, I'll count from 1 to 5…"
2. Count 1 to 5 — each number brings more alertness (1 = deeply relaxed, 5 = fully alert and refreshed)
3. After each number, add 2–3 sentences of returning awareness and positive reinforcement
4. At 5, ${name} opens their eyes feeling refreshed, energized, and deeply well
5. End with a warm, grounding close

This is the ONLY section where awakening language is permitted.
Do NOT add more therapeutic suggestions — that work is complete.

${footer}`;

    default:
      throw new Error(`Unknown section: ${section}`);
  }
}

async function generateSessionSections({ name, goal, program, voice, background, style, personalization, fears, motivation, idealLife, deepQ1, deepQ2, deepQ3, deepQ4, affirmationStyle, wordTarget, maxTokens }) {
  const budgets = {
    induction:     Math.round(wordTarget * 0.20),
    deepener:      Math.round(wordTarget * 0.15),
    therapeutic:   Math.round(wordTarget * 0.40),
    reinforcement: Math.round(wordTarget * 0.15),
    emergence:     Math.round(wordTarget * 0.10),
  };
  const ctx = { name, goal, program, style, personalization, fears, motivation, idealLife, deepQ1, deepQ2, deepQ3, deepQ4, affirmationStyle };
  const headers = { "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" };

  async function callSection(section, budget, isRetry = false) {
    const prompt = buildSectionPrompt(section, budget, ctx);
    let text;
    try {
      const res = await axios.post(
        "https://api.openai.com/v1/chat/completions",
        { model: "gpt-4o-mini", messages: [{ role: "user", content: prompt }], max_tokens: Math.max(Math.ceil(budget * 2.5), 1000), temperature: 0.85 },
        { headers }
      );
      text = res.data.choices[0]?.message?.content?.trim();
    } catch (err) {
      if (!isRetry) { console.warn(`[section/${section}] LLM error, retrying: ${err.message}`); return callSection(section, budget, true); }
      throw new Error("We couldn't write your script right now. Please try again in a minute.");
    }
    if (!text) {
      if (!isRetry) { console.warn(`[section/${section}] Empty response, retrying`); return callSection(section, budget, true); }
      throw new Error("We couldn't write your script right now. Please try again in a minute.");
    }
    return text;
  }

  console.log(`[section] Parallel generation: ${JSON.stringify(budgets)}`);
  const [induction, deepener, therapeutic, reinforcement, emergence] = await Promise.all([
    callSection("induction",     budgets.induction),
    callSection("deepener",      budgets.deepener),
    callSection("therapeutic",   budgets.therapeutic),
    callSection("reinforcement", budgets.reinforcement),
    callSection("emergence",     budgets.emergence),
  ]);

  const sections = { induction, deepener, therapeutic, reinforcement, emergence };

  // Retry sections that are >20 % under their word budget (in parallel).
  const retryKeys = Object.entries(budgets)
    .filter(([k, b]) => { const wc = countSpokenWords(sections[k]); console.log(`[section/${k}] ${wc} words (target ${b}, ${Math.round(wc/b*100)}%)`); return wc / b < 0.80; })
    .map(([k]) => k);

  if (retryKeys.length > 0) {
    console.warn(`[section] Retrying under-target sections: ${retryKeys.join(", ")}`);
    const retried = await Promise.all(retryKeys.map(k => callSection(k, budgets[k], true)));
    retryKeys.forEach((k, i) => { sections[k] = retried[i]; console.log(`[section/${k}] After retry: ${countSpokenWords(sections[k])} words`); });
  }

  const total = Object.values(sections).reduce((s, t) => s + countSpokenWords(t), 0);
  console.log(`[section] Total spoken words: ${total} (target ${wordTarget}, ${Math.round(total/wordTarget*100)}%)`);

  return ["induction", "deepener", "therapeutic", "reinforcement", "emergence"]
    .map(k => sections[k])
    .join('\n\n<break time="3s"/>\n\n');
}

// ─── PROMPT (single-call fallback) ───────────────────────────────────────────
function buildPrompt({ name, goal, program, voice, background, style, personalization, fears, motivation, idealLife, deepQ1, deepQ2, deepQ3, deepQ4, affirmationStyle, backgroundIntensity, wordTarget = 400, mins = 5 }) {
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

  // Deep personalization: prefer the program-specific deepQ fields, fall back to legacy fears/motivation/idealLife
  const hasDeepQ = personalization === "deep" && (deepQ1 || deepQ2 || deepQ3 || deepQ4);
  const hasLegacy = personalization === "deep" && (fears || motivation || idealLife);
  const deepContext = hasDeepQ
    ? `\nDeep personalization:\n${deepQ1 ? `- ${deepQ1}` : ""}${deepQ2 ? `\n- ${deepQ2}` : ""}${deepQ3 ? `\n- ${deepQ3}` : ""}${deepQ4 ? `\n- ${deepQ4}` : ""}`.trim()
    : hasLegacy
    ? `\nDeep personalization:\n${fears ? `- Fear / what to release: ${fears}` : ""}\n${motivation ? `- Core motivation: ${motivation}` : ""}\n${idealLife ? `- Ideal life vision: ${idealLife}` : ""}`.trim()
    : "";

  return `Write a personalized guided ${program} meditation/hypnosis session.
Name: ${name}
Goal: ${goal}
Program: ${program}
Voice style: ${voice || "Female Calm"}
Background sound: ${background || "432 Hz"}
Session style: ${style || "Gentle Meditation"}${deepContext}

DELIVERY STYLE — read this carefully, it controls how the audio will sound:
Write as if speaking to someone who is already half asleep. Every word should be slow, soft, and unhurried. Use long vowel sounds and flowing sentences. Never use sharp or abrupt language.
Use these slow speech patterns throughout: "slowly, and gently", "allow yourself to", "feel yourself", "notice how", "with every breath", "deeper and deeper"
Write in long, flowing sentences with multiple commas creating natural breath points — not short clipped sentences.
Add a blank line between every single sentence.
Your script MUST meet these minimum word counts per section. Word counts exclude SSML tags like <break time="3s"/> — count only actual spoken words. Do not end any section early. If you finish a section before its minimum, expand with additional imagery, repetition in varied wording, or deeper sensory detail. Do NOT summarize or skip to the next section.

- Section 1 — Induction (eye fixation, progressive relaxation): minimum ${Math.round(wordTarget * 0.20)} words
- Section 2 — Deepener (staircase, counting down): minimum ${Math.round(wordTarget * 0.15)} words
- Section 3 — Therapeutic content (core suggestions, imagery, metaphor): minimum ${Math.round(wordTarget * 0.42)} words
- Section 4 — Reinforcement (post-hypnotic suggestions, anchoring): minimum ${Math.round(wordTarget * 0.15)} words
- Section 5 — Emergence (gradual return, counting up 1–5): minimum ${Math.round(wordTarget * 0.08)} words

TOTAL MINIMUM: ${wordTarget} spoken words (not counting SSML tags). This is a hard floor, not a target.

You are writing a single continuous hypnosis session script.
Follow this structure strictly — do not deviate:

SECTION 1 — INDUCTION (minimum ${Math.round(wordTarget * 0.20)} spoken words):
Welcome and progressive relaxation. Guide them into trance.
One induction only. Never repeat this.

SECTION 2 — DEEPENING (minimum ${Math.round(wordTarget * 0.15)} spoken words):
Deepen the relaxed state. Stairs, elevator, counting down, or floating imagery.

SECTION 3 — THERAPEUTIC CONTENT (minimum ${Math.round(wordTarget * 0.42)} spoken words):
Therapeutic suggestions, visualizations, affirmations.
This is the core of the session. Spend the most words here.
Do NOT include any awakening language in this section.
Do NOT count upward. Do NOT say "returning to the room".
Do NOT say "open your eyes". Do NOT say "wiggle your fingers".
These phrases are forbidden until Section 5.

SECTION 4 — REINFORCEMENT (minimum ${Math.round(wordTarget * 0.15)} spoken words):
Anchor the suggestions. Future pacing. Still in trance.

SECTION 5 — EMERGENCE (minimum ${Math.round(wordTarget * 0.08)} spoken words):
This is the ONLY place awakening language is permitted.
Gently count from 1 to 5. Bring them back to full awareness.
End with something positive and grounding.

CRITICAL RULES:
- There is exactly ONE induction and ONE emergence in the entire script
- The emergence is always the final paragraphs — never before
- Never break trance before Section 5
- The script must feel like one continuous flowing experience

Write EVERY section in full, unhurried detail:
- Opening: 3 full breathing cycles with 4+ lines each
- Deepening countdown: 10 to 1 — after each number write 3–4 lines of deepening suggestions
- Body scan: cover every part of the body in sequence, head to toe, at least 2 sentences per region
- Visualization: at least 3 distinct scenes with full sensory detail (sight, sound, smell, touch, feeling)
- Affirmations: minimum 6 affirmations, each spoken twice with a pause between repetitions
- Closing: a full gentle return, at least 8 lines
If you reach the closing section before ${wordTarget} spoken words, expand sections 3 and 4. Do not stop writing early under any circumstances.

PAUSE NOTATION — use SSML break tags for every pause. Do NOT use dots or ellipses for pauses — they will be read aloud or ignored. Use only these tags:
- Between every sentence: <break time="1.5s"/>
- After breathing instructions: <break time="3s"/>
- Between major sections: <break time="2s"/>
- After each countdown number: <break time="3s"/>
- After each affirmation: <break time="2s"/>
- During any countdown or counting sequence, place a <break time="2.5s"/> after each number to allow the listener time to absorb each count.
Pauses should feel calm and unhurried.

BREATHING INSTRUCTION FORMAT — write the opening breathing section exactly like this:
Breathe in, slowly, through your nose <break time="3s"/> and hold it gently <break time="2s"/> now breathe out, slowly, through your mouth <break time="3s"/> feel your body sink deeper into relaxation <break time="2s"/>

COUNTDOWN FORMAT — write the countdown exactly like this:
Ten <break time="3s"/> allow yourself to sink deeper <break time="2s"/>
Nine <break time="3s"/> deeper still <break time="2s"/>
Eight <break time="3s"/> more relaxed with every number <break time="2s"/>
Seven <break time="3s"/> letting go of everything now <break time="2s"/>
Six <break time="3s"/> peaceful and still <break time="2s"/>
Five <break time="3s"/> halfway there, sinking beautifully <break time="2s"/>
Four <break time="3s"/> deeper with every word <break time="2s"/>
Three <break time="3s"/> almost completely at rest <break time="2s"/>
Two <break time="3s"/> so deeply relaxed now <break time="2s"/>
One <break time="3s"/> completely, beautifully still <break time="2s"/>

Do NOT use any stage directions, labels, or parenthetical instructions like (pause), (breathe), (inhale), (exhale) — these will be read aloud verbatim.
Do NOT use dots or ellipses (...) anywhere — they are not parsed as pauses by the voice engine. Use only the <break> tags above.

Content rules:
1. Use ${name}'s name at least 4 times throughout.
2. Write in second person.
3. Begin with 3 slow breathing instructions using the breathing format above.
4. Include a body scan relaxation from head to toe.
5. Countdown from 10 to 1 using the countdown format above.
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

    res.json({ success: true, account, session_count: 0 });
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
  try {
    const { data, error } = await supabase.from("testimonials")
      .select("id, user_name, program, rating, message, created_at")
      .eq("approved", true)
      .order("created_at", { ascending: false })
      .limit(6);
    if (error) {
      // PGRST205 = table does not exist. Return empty array gracefully rather than crashing.
      // This prevents a 500 from blocking the app while the table is pending creation.
      const tableNotFound = error.code === "PGRST205" || error.message?.includes("does not exist");
      if (tableNotFound) {
        console.warn("[testimonials] Table not found — returning empty array (PGRST205)");
        return res.json({ success: true, testimonials: [] });
      }
      console.error("[testimonials] Supabase error:", error.message, error);
      return res.status(500).json({ success: false, error: error.message });
    }
    res.json({ success: true, testimonials: data || [] });
  } catch (err) {
    // Never let this route return a 500 — an empty list is always a safe fallback
    console.error("[testimonials] Unhandled exception:", err.message, err);
    res.json({ success: true, testimonials: [] });
  }
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
  console.log(`[admin/content] GET type=${type||"all"} status=${status||"all"} limit=${limit}`);
  let q = supabase.from("content_calendar").select("*").order("generated_at", { ascending: false }).limit(Number(limit));
  if (type)   q = q.eq("type", type);
  if (status) q = q.eq("status", status);
  const { data, error } = await q;
  if (error) {
    console.error("[admin/content] Supabase query error:", error.message, error.code);
    return res.status(500).json({ success: false, error: error.message });
  }
  console.log(`[admin/content] returning ${(data||[]).length} items`);
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