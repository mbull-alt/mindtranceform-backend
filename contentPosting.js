/**
 * contentPosting.js — Approval-gated auto-posting pipeline for finished videos
 * from the trance-ads/ pipeline.
 *
 * Flow: trance-ads pipeline uploads a finished MP4 to the "content-videos"
 * Supabase Storage bucket, then POSTs to /content/queue with the storage path
 * + metadata. That inserts a `pending` content_posts row and emails Mark an
 * approve/reject link. Nothing calls a platform's publish endpoint until the
 * corresponding row is flipped to `approved` via that link.
 *
 * Platform posting functions (postToYouTube/Instagram/Facebook/TikTok) are
 * real implementations once credentials exist for that platform, and return
 * { skipped: true, reason } when they don't — runPostingJob never fails a
 * row just because a platform isn't wired up yet, it reports it.
 *
 * See migrations/005_content_posts.sql for the table, and the trance-ads
 * Discussions doc (2026-08-13, "Auto-post pipeline") for the full spec this
 * implements.
 */

"use strict";

const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

// Lazy-init both clients (rather than the eager module-scope pattern used in
// server.js/contentEngine.js) so this module can be required for its pure
// functions — decidePostingOutcome, describeResult, renderResultPage,
// escapeHtml — without SUPABASE_*/RESEND_API_KEY set. See
// tests/content-posting.test.js, which does exactly that.
let _supabase = null;
function getSupabase() {
  if (!_supabase) {
    _supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  }
  return _supabase;
}

const BACKEND_URL =
  process.env.BACKEND_URL ||
  process.env.RENDER_EXTERNAL_URL ||
  `http://localhost:${process.env.PORT || 8080}`;

const VIDEO_BUCKET = "content-videos";
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days — matches the email copy

// ─── queue ──────────────────────────────────────────────────────────────────

async function queueContentPost({ video_path, script_slot, platform_targets, caption, hashtags, cta }) {
  if (!video_path || !script_slot || !caption || !hashtags || !cta) {
    throw Object.assign(new Error("missing required field(s): video_path, script_slot, caption, hashtags, cta"), { statusCode: 400 });
  }
  if (!Array.isArray(platform_targets) || platform_targets.length === 0) {
    throw Object.assign(new Error("platform_targets must be a non-empty array"), { statusCode: 400 });
  }

  const approval_token = crypto.randomBytes(32).toString("hex");
  const token_expires_at = new Date(Date.now() + TOKEN_TTL_MS).toISOString();

  const { data, error } = await getSupabase()
    .from("content_posts")
    .insert({
      video_path, script_slot, platform_targets, caption, hashtags, cta,
      status: "pending", approval_token, token_expires_at,
    })
    .select("id")
    .single();

  if (error) throw Object.assign(new Error(`insert failed: ${error.message}`), { statusCode: 500 });

  await sendApprovalEmail({ id: data.id, video_path, script_slot, platform_targets, caption, approval_token });

  return { id: data.id, status: "pending" };
}

// ─── approval email ───────────────────────────────────────────────────────

async function getSignedVideoUrl(video_path) {
  const { data, error } = await getSupabase().storage
    .from(VIDEO_BUCKET)
    .createSignedUrl(video_path, TOKEN_TTL_MS / 1000);
  if (error) {
    console.error("[content_posts] createSignedUrl:", error.message);
    return null;
  }
  return data.signedUrl;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function sendApprovalEmail({ id, video_path, script_slot, platform_targets, caption, approval_token }) {
  const adminEmail = process.env.ADMIN_EMAIL;
  if (!adminEmail) {
    console.error(`[content_posts] ADMIN_EMAIL not set — cannot send approval email for row ${id}`);
    return;
  }

  const videoUrl = await getSignedVideoUrl(video_path);
  const approveUrl = `${BACKEND_URL}/content/approve/${approval_token}`;
  const rejectUrl = `${BACKEND_URL}/content/reject/${approval_token}`;
  const subjectCaption = caption.length > 60 ? caption.slice(0, 57) + "..." : caption;

  const html = `
    <p>A new video is ready for review.</p>
    <p>
      <strong>Slot:</strong> ${escapeHtml(script_slot)}<br>
      <strong>Caption:</strong> ${escapeHtml(caption)}<br>
      <strong>Platforms:</strong> ${platform_targets.map(escapeHtml).join(", ")}
    </p>
    ${videoUrl
      ? `<p><a href="${videoUrl}">Watch it</a></p>`
      : `<p>(Video preview link unavailable — check content_posts row ${id} in Supabase.)</p>`}
    <p>
      <a href="${approveUrl}" style="background:#22c55e;color:#fff;padding:10px 16px;text-decoration:none;border-radius:6px;display:inline-block;">Approve and post</a>
      &nbsp;&nbsp;
      <a href="${rejectUrl}" style="background:#ef4444;color:#fff;padding:10px 16px;text-decoration:none;border-radius:6px;display:inline-block;">Reject (don't post)</a>
    </p>
    <p style="color:#888;font-size:12px;">This link expires in 7 days.</p>
  `;

  // Deliberately NOT using email.js's sendEmail() here — its default `from`
  // ("hello@mindtranceform.com") is an unverified Resend domain and 403s.
  // server.js never actually calls into email.js either; every real email
  // path there uses getResendClient() + an explicit verified `from`. Matching
  // that working pattern rather than patching the broken one (see chat,
  // 2026-08-14 — this surfaced as a real send failure while testing).
  if (!process.env.RESEND_API_KEY) {
    console.error(`[content_posts] RESEND_API_KEY not set — cannot send approval email for row ${id}`);
    return;
  }
  const { Resend } = require("resend");
  const resend = new Resend(process.env.RESEND_API_KEY);
  const FROM = "Mind Tranceform <noreply@mindtranceformapp.com>";
  const { error: sendErr } = await resend.emails.send({
    from: FROM,
    to: adminEmail,
    subject: `Review: ${script_slot} video ready — ${subjectCaption}`,
    html,
  });
  if (sendErr) console.error(`[content_posts] approval email failed for row ${id}:`, sendErr.message || sendErr);
}

// ─── approve / reject ───────────────────────────────────────────────────────
// Both look up by token, refuse anything not currently `pending`, and use a
// conditional UPDATE (.eq("status","pending")) as a race guard so two clicks
// on the same link (or a retried request) can't both succeed.

async function approveContentPost(token) {
  const { data: row, error } = await getSupabase()
    .from("content_posts").select("*").eq("approval_token", token).single();
  if (error || !row) return { ok: false, reason: "not_found" };
  if (row.status !== "pending") return { ok: false, reason: "already_actioned", row };
  if (new Date(row.token_expires_at) < new Date()) return { ok: false, reason: "expired", row };

  const { data: updated, error: updateErr } = await getSupabase()
    .from("content_posts")
    .update({ status: "approved", approved_at: new Date().toISOString() })
    .eq("id", row.id)
    .eq("status", "pending")
    .select()
    .single();

  if (updateErr || !updated) return { ok: false, reason: "already_actioned", row };

  const result = await runPostingJob(updated);
  return { ok: true, row: updated, result };
}

async function rejectContentPost(token) {
  const { data: row, error } = await getSupabase()
    .from("content_posts").select("*").eq("approval_token", token).single();
  if (error || !row) return { ok: false, reason: "not_found" };
  if (row.status !== "pending") return { ok: false, reason: "already_actioned", row };
  if (new Date(row.token_expires_at) < new Date()) return { ok: false, reason: "expired", row };

  const { data: updated, error: updateErr } = await getSupabase()
    .from("content_posts")
    .update({ status: "rejected" })
    .eq("id", row.id)
    .eq("status", "pending")
    .select()
    .single();

  if (updateErr || !updated) return { ok: false, reason: "already_actioned", row };

  return { ok: true, row: updated };
}

// ─── platform posting ───────────────────────────────────────────────────────
// Real implementation once credentials exist for that platform; until then,
// { skipped: true, reason } — never throws just because a platform isn't
// wired up.

// Conservative default: new videos post as Unlisted, not Public, until Mark
// has watched a few real ones land correctly. Flip via YOUTUBE_PRIVACY_STATUS
// (public/unlisted/private) on Render once confident — no code change needed.
// Decided 2026-08-14: an accidental/premature public post to a real channel
// (subscriber notifications, indexing) is a lot harder to undo than a late
// flip to public, so default to the safer side while this is new.
async function postToYouTube(row) {
  const { YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, YOUTUBE_REFRESH_TOKEN } = process.env;
  if (!YOUTUBE_CLIENT_ID || !YOUTUBE_CLIENT_SECRET || !YOUTUBE_REFRESH_TOKEN) {
    return { skipped: true, reason: "YouTube not configured (YOUTUBE_CLIENT_ID/SECRET/REFRESH_TOKEN not set)" };
  }

  try {
    const { google } = require("googleapis");
    const oauth2Client = new google.auth.OAuth2(YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET);
    oauth2Client.setCredentials({ refresh_token: YOUTUBE_REFRESH_TOKEN });
    const youtube = google.youtube({ version: "v3", auth: oauth2Client });

    const { data: fileBlob, error: dlErr } = await getSupabase().storage.from(VIDEO_BUCKET).download(row.video_path);
    if (dlErr) return { success: false, error: `download from storage failed: ${dlErr.message}` };
    const videoBuffer = Buffer.from(await fileBlob.arrayBuffer());

    const { Readable } = require("stream");
    const tags = row.hashtags.split(/\s+/).filter(Boolean).map(h => h.replace(/^#/, ""));
    const privacyStatus = process.env.YOUTUBE_PRIVACY_STATUS || "unlisted";

    const res = await youtube.videos.insert({
      part: ["snippet", "status"],
      requestBody: {
        snippet: {
          title: row.caption.length > 100 ? row.caption.slice(0, 97) + "..." : row.caption,
          description: `${row.cta}\n\n${row.hashtags} #Shorts`,
          tags,
          categoryId: "26", // Howto & Style
        },
        status: {
          privacyStatus,
          selfDeclaredMadeForKids: false,
        },
      },
      media: { body: Readable.from(videoBuffer) },
    });

    return {
      success: true,
      post_id: res.data.id,
      url: `https://youtube.com/watch?v=${res.data.id}`,
      privacyStatus,
    };
  } catch (err) {
    const detail = err.response?.data?.error?.message || err.message;
    return { success: false, error: `YouTube upload failed: ${detail}` };
  }
}

// NOTE on token lifetime: IG_ACCESS_TOKEN as currently issued (via Instagram
// Business Login) is short-lived (~1hr). The documented ig_exchange_token
// long-lived-token exchange is failing with "Error validating client secret"
// against this app/token pair for reasons not yet root-caused (confirmed not
// a copy-paste error — tried two distinct app secrets and two distinct
// tokens, same result each time; the token itself works fine for real
// Graph API calls, just not that specific exchange endpoint). Until that's
// resolved, this token needs manual re-generation periodically — flagged
// to Mark, not silently worked around.
async function postToInstagram(row) {
  const { IG_ACCESS_TOKEN, IG_BUSINESS_ACCOUNT_ID } = process.env;
  if (!IG_ACCESS_TOKEN || !IG_BUSINESS_ACCOUNT_ID) {
    return { skipped: true, reason: "Instagram not configured (IG_ACCESS_TOKEN/IG_BUSINESS_ACCOUNT_ID not set)" };
  }

  try {
    const axios = require("axios");
    const { data: urlData, error: urlErr } = await getSupabase().storage
      .from(VIDEO_BUCKET)
      .createSignedUrl(row.video_path, 3600);
    if (urlErr) return { success: false, error: `signed url failed: ${urlErr.message}` };

    const caption = `${row.caption}\n\n${row.cta}\n\n${row.hashtags}`;

    const createRes = await axios.post(`https://graph.instagram.com/v21.0/${IG_BUSINESS_ACCOUNT_ID}/media`, null, {
      params: { media_type: "REELS", video_url: urlData.signedUrl, caption, access_token: IG_ACCESS_TOKEN },
    });
    const creationId = createRes.data.id;

    // Instagram processes the video asynchronously — poll until FINISHED
    // before publishing. ~2.5 min ceiling at 5s intervals.
    let status = "IN_PROGRESS";
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 5000));
      const statusRes = await axios.get(`https://graph.instagram.com/v21.0/${creationId}`, {
        params: { fields: "status_code", access_token: IG_ACCESS_TOKEN },
      });
      status = statusRes.data.status_code;
      if (status === "FINISHED" || status === "ERROR") break;
    }
    if (status !== "FINISHED") {
      return { success: false, error: `container never finished processing (status: ${status})` };
    }

    const publishRes = await axios.post(`https://graph.instagram.com/v21.0/${IG_BUSINESS_ACCOUNT_ID}/media_publish`, null, {
      params: { creation_id: creationId, access_token: IG_ACCESS_TOKEN },
    });
    const mediaId = publishRes.data.id;

    // The numeric media ID isn't the public URL shortcode — fetch the real
    // permalink rather than guessing at a URL shape.
    let url = null;
    try {
      const permalinkRes = await axios.get(`https://graph.instagram.com/v21.0/${mediaId}`, {
        params: { fields: "permalink", access_token: IG_ACCESS_TOKEN },
      });
      url = permalinkRes.data.permalink;
    } catch (_e) { /* non-fatal — the post still succeeded */ }

    return { success: true, post_id: mediaId, url };
  } catch (err) {
    const detail = err.response?.data?.error?.message || err.message;
    return { success: false, error: `Instagram publish failed: ${detail}` };
  }
}

// Same conservative-default reasoning as postToYouTube: publishes as a
// draft (Page-admin-only) unless FB_PUBLISH_LIVE=true, so the first test
// doesn't go live on the real Page by default.
async function postToFacebook(row) {
  const { FB_PAGE_ID, FB_PAGE_ACCESS_TOKEN } = process.env;
  if (!FB_PAGE_ID || !FB_PAGE_ACCESS_TOKEN) {
    return { skipped: true, reason: "Facebook not configured (FB_PAGE_ID/FB_PAGE_ACCESS_TOKEN not set)" };
  }

  try {
    const axios = require("axios");
    const { data: urlData, error: urlErr } = await getSupabase().storage
      .from(VIDEO_BUCKET)
      .createSignedUrl(row.video_path, 3600);
    if (urlErr) return { success: false, error: `signed url failed: ${urlErr.message}` };

    const description = `${row.caption}\n\n${row.cta}\n\n${row.hashtags}`;
    const published = process.env.FB_PUBLISH_LIVE === "true";

    const res = await axios.post(`https://graph-video.facebook.com/v21.0/${FB_PAGE_ID}/videos`, null, {
      params: { file_url: urlData.signedUrl, description, published, access_token: FB_PAGE_ACCESS_TOKEN },
    });

    return {
      success: true,
      post_id: res.data.id,
      url: `https://www.facebook.com/${FB_PAGE_ID}/videos/${res.data.id}`,
      published,
    };
  } catch (err) {
    const detail = err.response?.data?.error?.message || err.message;
    return { success: false, error: `Facebook publish failed: ${detail}` };
  }
}

async function postToTikTok(row) {
  if (!process.env.TIKTOK_ACCESS_TOKEN) {
    return { skipped: true, reason: "TikTok not configured (SELF_ONLY integration not yet built)" };
  }
  return { success: false, error: "postToTikTok not implemented yet" };
}

const PLATFORM_POSTERS = {
  youtube: postToYouTube,
  instagram: postToInstagram,
  facebook: postToFacebook,
  tiktok: postToTikTok,
};

// Status semantics after a posting attempt. The spec covers two cases
// explicitly (>=1 success -> "posted"; all attempted and all failed ->
// "failed"). It doesn't cover "every target platform was skipped because no
// platform has credentials yet" — which is the real state of every row
// today, since none of the three integrations are wired up. Decided here
// (see chat, 2026-08-14) rather than guessed silently: in that case the row
// is left at "approved", not advanced to "posted" or "failed" — neither
// claim would be true. It only becomes "posted"/"failed" once a platform is
// actually attempted.
async function runPostingJob(row) {
  const results = {};
  let anySuccess = false;
  let anyAttempted = false;

  for (const platform of row.platform_targets) {
    const poster = PLATFORM_POSTERS[platform];
    if (!poster) {
      results[platform] = { success: false, error: `unknown platform "${platform}"` };
      anyAttempted = true;
      continue;
    }
    try {
      const r = await poster(row);
      results[platform] = r;
      if (r.success) anySuccess = true;
      if (!r.skipped) anyAttempted = true;
    } catch (err) {
      results[platform] = { success: false, error: err.message };
      anyAttempted = true;
    }
  }

  const { status, update } = decidePostingOutcome(results, row.status);

  const { error: updateErr } = await getSupabase().from("content_posts").update(update).eq("id", row.id);
  if (updateErr) console.error("[content_posts] runPostingJob update failed:", updateErr.message);

  return { status, results };
}

// Pure decision logic, split out from runPostingJob so it's unit-testable
// without a live Supabase connection (see tests/content-posting.test.js).
// priorStatus is always "approved" in production (that's the only status
// runPostingJob is ever called with) but taking it as a parameter rather than
// hardcoding keeps the function honest about what it depends on.
function decidePostingOutcome(results, priorStatus) {
  const values = Object.values(results);
  const anySuccess = values.some(r => r.success);
  const anyAttempted = values.some(r => !r.skipped);

  let status = priorStatus;
  if (anySuccess) status = "posted";
  else if (anyAttempted) status = "failed";

  const update = { platform_post_ids: results };
  if (status !== priorStatus) update.status = status;
  if (status === "posted") update.posted_at = new Date().toISOString();
  if (status === "failed") {
    update.error = Object.entries(results)
      .filter(([, r]) => !r.success && !r.skipped)
      .map(([p, r]) => `${p}: ${r.error || "failed"}`)
      .join("; ");
  }

  return { status, update };
}

// ─── result page rendering (for the plain-GET approve/reject links) ─────────

function describeResult(platform, r) {
  const label = platform.charAt(0).toUpperCase() + platform.slice(1);
  if (r.success) return `${label} posted ✓`;
  if (r.skipped) return `${label} skipped — ${escapeHtml(r.reason)}`;
  return `${label} failed — ${escapeHtml(r.error || "unknown error")}`;
}

function renderResultPage({ title, lines, color }) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:480px;margin:80px auto;padding:0 20px;color:#111}
h1{font-size:20px;color:${color}}ul{padding-left:20px}li{margin:6px 0}</style></head>
<body><h1>${escapeHtml(title)}</h1><ul>${lines.map(l => `<li>${l}</li>`).join("")}</ul></body></html>`;
}

module.exports = {
  queueContentPost,
  approveContentPost,
  rejectContentPost,
  runPostingJob,
  decidePostingOutcome,
  describeResult,
  renderResultPage,
  escapeHtml,
};
