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

// The first real post (2026-08-13/14) shipped with no link anywhere —
// root cause: content_posts never had a dedicated link field, and the
// caption/hashtags/cta fields used for that post simply didn't contain
// one (confirmed directly, not inferred — see chat, 2026-08-16). Fixed two
// ways: (1) queueContentPost rejects anything missing both URLs below, so
// the source content is required to carry them; (2) every postTo* function
// also explicitly appends this exact line to what it actually posts,
// so the fix doesn't depend on every future caller remembering correctly.
const REQUIRED_LINK_WEB = "mindtranceformapp.com";
const REQUIRED_LINK_PLAY = "play.google.com/store/apps/details?id=com.mindtranceformapp.app.twa";
const CANONICAL_LINK_LINE = "app.mindtranceformapp.com — also on Google Play: play.google.com/store/apps/details?id=com.mindtranceformapp.app.twa";

// Platforms whose native API supports scheduled publishing directly —
// these always post immediately on approval (the API call itself just
// carries a future publish time); everything else must not be attempted
// until scheduled_for actually arrives, handled by runPostingJob below.
const NATIVE_SCHEDULE_SUPPORTED = { youtube: true };

function hasRequiredLinks(caption, hashtags, cta) {
  const combined = `${caption} ${hashtags} ${cta}`;
  return combined.includes(REQUIRED_LINK_WEB) && combined.includes(REQUIRED_LINK_PLAY);
}

// Used by every postTo* function instead of unconditionally appending
// CANONICAL_LINK_LINE. Without this, a caller who already did the right
// thing (embedded both links in caption/hashtags/cta, e.g. via the source
// script's pinned-comment text, to satisfy queueContentPost's validation)
// would see the link appear twice in the final posted text — once from
// their own copy, once from the auto-append. Still guarantees the link is
// present in the final output either way, just doesn't duplicate it.
function linkSuffix(row) {
  return hasRequiredLinks(row.caption, row.hashtags, row.cta) ? "" : `\n\n${CANONICAL_LINK_LINE}`;
}

// ─── queue ──────────────────────────────────────────────────────────────────

async function queueContentPost({ video_path, script_slot, platform_targets, caption, hashtags, cta, scheduled_for }) {
  if (!video_path || !script_slot || !caption || !hashtags || !cta) {
    throw Object.assign(new Error("missing required field(s): video_path, script_slot, caption, hashtags, cta"), { statusCode: 400 });
  }
  if (!Array.isArray(platform_targets) || platform_targets.length === 0) {
    throw Object.assign(new Error("platform_targets must be a non-empty array"), { statusCode: 400 });
  }

  if (!hasRequiredLinks(caption, hashtags, cta)) {
    throw Object.assign(new Error(
      "caption/hashtags/cta must include both the web URL (mindtranceformapp.com) and the direct Google Play URL " +
      "(play.google.com/store/apps/details?id=com.mindtranceformapp.app.twa)"
    ), { statusCode: 400 });
  }

  let scheduledForIso = null;
  if (scheduled_for) {
    const parsed = new Date(scheduled_for);
    if (isNaN(parsed.getTime())) {
      throw Object.assign(new Error("scheduled_for must be a valid ISO 8601 timestamp"), { statusCode: 400 });
    }
    scheduledForIso = parsed.toISOString();
  }

  const approval_token = crypto.randomBytes(32).toString("hex");
  const token_expires_at = new Date(Date.now() + TOKEN_TTL_MS).toISOString();

  const { data, error } = await getSupabase()
    .from("content_posts")
    .insert({
      video_path, script_slot, platform_targets, caption, hashtags, cta,
      scheduled_for: scheduledForIso,
      status: "pending", approval_token, token_expires_at,
    })
    .select("id")
    .single();

  if (error) throw Object.assign(new Error(`insert failed: ${error.message}`), { statusCode: 500 });

  await sendApprovalEmail({ id: data.id, video_path, script_slot, platform_targets, caption, hashtags, cta, approval_token, scheduled_for: scheduledForIso });

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

async function sendApprovalEmail({ id, video_path, script_slot, platform_targets, caption, hashtags, cta, approval_token, scheduled_for }) {
  const adminEmail = process.env.ADMIN_EMAIL;
  if (!adminEmail) {
    console.error(`[content_posts] ADMIN_EMAIL not set — cannot send approval email for row ${id}`);
    return;
  }

  const videoUrl = await getSignedVideoUrl(video_path);
  const approveUrl = `${BACKEND_URL}/content/approve/${approval_token}`;
  const rejectUrl = `${BACKEND_URL}/content/reject/${approval_token}`;
  const subjectCaption = caption.length > 60 ? caption.slice(0, 57) + "..." : caption;
  const scheduledLine = scheduled_for
    ? `<strong>Scheduled for:</strong> ${escapeHtml(new Date(scheduled_for).toLocaleString("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short" }))} ET<br>`
    : "";

  // TikTok's inbox/draft upload API takes no caption/title field at all
  // (confirmed against TikTok's current API reference, 2026-09-02) — the
  // creator types it themselves when they open the draft in the TikTok app.
  // Surface the full text here rather than silently dropping it, so it's
  // not lost between approval and whoever finishes the post in-app.
  const tiktokNote = platform_targets.includes("tiktok")
    ? `<p style="background:#fff7ed;border-left:4px solid #f97316;padding:12px 16px;">
        <strong>TikTok note:</strong> approving sends this video to the TikTok inbox as a draft —
        TikTok's API doesn't support a pre-filled caption for that flow, so paste the text below
        into the TikTok app yourself when you finish the post there.
      </p>
      <p><strong>Caption/CTA/hashtags for TikTok:</strong><br>
        <pre style="white-space:pre-wrap;background:#f3f4f6;padding:12px;border-radius:6px;font-family:inherit;">${escapeHtml(caption)}\n\n${escapeHtml(cta)}\n\n${escapeHtml(hashtags)}</pre>
      </p>`
    : "";

  const html = `
    <p>A new video is ready for review.</p>
    <p>
      <strong>Slot:</strong> ${escapeHtml(script_slot)}<br>
      <strong>Caption:</strong> ${escapeHtml(caption)}<br>
      <strong>Platforms:</strong> ${platform_targets.map(escapeHtml).join(", ")}<br>
      ${scheduledLine}
    </p>
    ${videoUrl
      ? `<p><a href="${videoUrl}">Watch it</a></p>`
      : `<p>(Video preview link unavailable — check content_posts row ${id} in Supabase.)</p>`}
    ${tiktokNote}
    <p>
      <a href="${approveUrl}" style="background:#22c55e;color:#fff;padding:10px 16px;text-decoration:none;border-radius:6px;display:inline-block;">${scheduled_for ? "Approve (posts at scheduled time)" : "Approve and post now"}</a>
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

    // Native scheduled publish: upload now as private with publishAt set,
    // YouTube itself flips it public at that timestamp — no cron needed on
    // our end for this platform specifically (see NATIVE_SCHEDULE_SUPPORTED).
    const scheduledMs = row.scheduled_for ? new Date(row.scheduled_for).getTime() : null;
    const isFutureSchedule = scheduledMs && scheduledMs > Date.now();
    const status = isFutureSchedule
      ? { privacyStatus: "private", publishAt: new Date(scheduledMs).toISOString(), selfDeclaredMadeForKids: false }
      : { privacyStatus: process.env.YOUTUBE_PRIVACY_STATUS || "unlisted", selfDeclaredMadeForKids: false };

    const res = await youtube.videos.insert({
      part: ["snippet", "status"],
      requestBody: {
        snippet: {
          title: row.caption.length > 100 ? row.caption.slice(0, 97) + "..." : row.caption,
          description: `${row.cta}\n\n${row.hashtags} #Shorts${linkSuffix(row)}`,
          tags,
          categoryId: "26", // Howto & Style
        },
        status,
      },
      media: { body: Readable.from(videoBuffer) },
    });

    return {
      success: true,
      post_id: res.data.id,
      url: `https://youtube.com/watch?v=${res.data.id}`,
      privacyStatus: status.privacyStatus,
      publishAt: status.publishAt || null,
    };
  } catch (err) {
    const detail = err.response?.data?.error?.message || err.message;
    return { success: false, error: `YouTube upload failed: ${detail}` };
  }
}

// NOTE on token lifetime: IG_ACCESS_TOKEN as currently issued (via Instagram
// Business Login) started short-lived (~1hr). The documented
// ig_exchange_token long-lived-token exchange failed with "Error validating
// client secret" against this app/token pair for reasons never root-caused
// (confirmed not a copy-paste error — tried two distinct app secrets and two
// distinct tokens, same result each time). Worked around via a DIFFERENT,
// simpler endpoint instead: graph.instagram.com's ig_refresh_token grant,
// which extends the token directly (~60 days per call, no client secret
// needed) and works fine even on a token that never went through the
// exchange flow. See tokenStore.js for the actual refresh-and-persist logic.
async function postToInstagram(row) {
  const { IG_BUSINESS_ACCOUNT_ID } = process.env;
  if (!IG_BUSINESS_ACCOUNT_ID) {
    return { skipped: true, reason: "Instagram not configured (IG_BUSINESS_ACCOUNT_ID not set)" };
  }
  const { getValidInstagramToken } = require("./tokenStore");
  const IG_ACCESS_TOKEN = await getValidInstagramToken();
  if (!IG_ACCESS_TOKEN) {
    return { skipped: true, reason: "Instagram not configured (IG_ACCESS_TOKEN not set)" };
  }

  try {
    const axios = require("axios");
    const { data: urlData, error: urlErr } = await getSupabase().storage
      .from(VIDEO_BUCKET)
      .createSignedUrl(row.video_path, 3600);
    if (urlErr) return { success: false, error: `signed url failed: ${urlErr.message}` };

    const caption = `${row.caption}\n\n${row.cta}\n\n${row.hashtags}${linkSuffix(row)}`;

    // POST body (not query-string params) — sending rich text like the
    // em-dash in CANONICAL_LINK_LINE via URL query params produced corrupted
    // characters on Facebook's side (confirmed via postToFacebook, same
    // underlying pattern); a form-encoded body avoids that entirely.
    const createRes = await axios.post(
      `https://graph.instagram.com/v21.0/${IG_BUSINESS_ACCOUNT_ID}/media`,
      new URLSearchParams({ media_type: "REELS", video_url: urlData.signedUrl, caption, access_token: IG_ACCESS_TOKEN })
    );
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

    const description = `${row.caption}\n\n${row.cta}\n\n${row.hashtags}${linkSuffix(row)}`;
    const published = process.env.FB_PUBLISH_LIVE === "true";

    // POST body, not query-string params — fixes the em-dash/UTF-8
    // corruption confirmed on real posted content (2026-08-17): em-dashes
    // in the description came through as "�" on Facebook's side.
    const res = await axios.post(
      `https://graph-video.facebook.com/v21.0/${FB_PAGE_ID}/videos`,
      new URLSearchParams({ file_url: urlData.signedUrl, description, published: String(published), access_token: FB_PAGE_ACCESS_TOKEN })
    );

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

// Pure — the exact request body for the inbox/draft video init call.
// Deliberately just source_info: confirmed against TikTok's current API
// reference (developers.tiktok.com/doc/content-posting-api-reference-
// upload-video, checked 2026-09-02) that /inbox/video/init/ accepts no
// post_info field at all — title, privacy_level, disable_duet,
// disable_comment, disable_stitch are all Direct Post-only and either
// ignored or rejected here. There is no way to pre-fill a caption for this
// mode; the creator types it themselves when they open the draft in the
// TikTok app (see the TikTok note added to sendApprovalEmail below).
function buildTikTokInboxInitPayload(videoSize) {
  return {
    source_info: {
      source: "FILE_UPLOAD",
      video_size: videoSize,
      chunk_size: videoSize,
      total_chunk_count: 1,
    },
  };
}

// Pure — interprets one status/fetch response for the inbox/draft flow.
// SEND_TO_USER_INBOX, not PUBLISH_COMPLETE, is the terminal state our side
// controls: per TikTok's Get Post Status reference (checked 2026-09-02),
// PUBLISH_COMPLETE for the upload/inbox flow only fires after a human opens
// the TikTok app and finishes the post themselves — that can take hours or
// never happen, so waiting for it here would report every successful inbox
// upload as a failure once the poll ceiling is hit. PUBLISH_COMPLETE still
// counts as success if it happens to land within the poll window anyway.
function decideTikTokPollOutcome(status) {
  if (status === "SEND_TO_USER_INBOX" || status === "PUBLISH_COMPLETE") return { terminal: true, success: true };
  if (status === "FAILED") return { terminal: true, success: false };
  return { terminal: false, success: false };
}

// Sends the finished video to the creator's TikTok inbox as a draft — this
// app's Developer Portal config holds only user.info.basic + video.upload
// and has Direct Post disabled (confirmed in the portal 2026-09-02), so the
// Direct Post video/init/ call this used to make could never have succeeded
// regardless of the creator_info/privacy_level handling that used to sit
// around it; video.upload is exactly the scope the inbox/draft flow needs
// (video.publish is the Direct Post-only scope, confirmed against TikTok's
// docs 2026-09-02) and Direct Post's SELF_ONLY-for-unaudited-apps restriction
// doesn't apply here in the first place, since inbox drafts are never public
// until the creator manually posts them.
async function postToTikTok(row) {
  const { getValidTikTokToken } = require("./tokenStore");
  const TIKTOK_ACCESS_TOKEN = await getValidTikTokToken();
  if (!TIKTOK_ACCESS_TOKEN) {
    return { skipped: true, reason: "TikTok not configured (TIKTOK_ACCESS_TOKEN/TIKTOK_REFRESH_TOKEN not set)" };
  }

  try {
    const axios = require("axios");

    const { data: fileBlob, error: dlErr } = await getSupabase().storage.from(VIDEO_BUCKET).download(row.video_path);
    if (dlErr) return { success: false, error: `download from storage failed: ${dlErr.message}` };
    const videoBuffer = Buffer.from(await fileBlob.arrayBuffer());

    const initRes = await axios.post(
      "https://open.tiktokapis.com/v2/post/publish/inbox/video/init/",
      buildTikTokInboxInitPayload(videoBuffer.length),
      { headers: { Authorization: `Bearer ${TIKTOK_ACCESS_TOKEN}`, "Content-Type": "application/json" } }
    );
    if (initRes.data.error?.code !== "ok") {
      return { success: false, error: `init failed: ${initRes.data.error?.message || "unknown"}` };
    }
    const { publish_id, upload_url } = initRes.data.data;

    await axios.put(upload_url, videoBuffer, {
      headers: {
        "Content-Type": "video/mp4",
        "Content-Length": videoBuffer.length,
        "Content-Range": `bytes 0-${videoBuffer.length - 1}/${videoBuffer.length}`,
      },
      maxBodyLength: Infinity,
    });

    // Poll until the video actually reaches the creator's inbox — see
    // decideTikTokPollOutcome above for why this isn't PUBLISH_COMPLETE.
    let status = "PROCESSING_UPLOAD";
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 5000));
      const statusRes = await axios.post(
        "https://open.tiktokapis.com/v2/post/publish/status/fetch/",
        { publish_id },
        { headers: { Authorization: `Bearer ${TIKTOK_ACCESS_TOKEN}`, "Content-Type": "application/json" } }
      );
      status = statusRes.data.data?.status;
      if (decideTikTokPollOutcome(status).terminal) break;
    }
    if (!decideTikTokPollOutcome(status).success) {
      return { success: false, error: `upload never reached the creator's inbox (status: ${status})` };
    }

    return { success: true, post_id: publish_id, mode: "inbox_draft" };
  } catch (err) {
    const detail = err.response?.data?.error?.message || err.message;
    return { success: false, error: `TikTok publish failed: ${detail}` };
  }
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
// Pure decision for a single platform within runPostingJob, split out so
// the scheduling logic is unit-testable without a live poster call. nowMs
// is a parameter rather than reading Date.now() internally so tests can
// pin it exactly (see tests/content-posting.test.js).
function decidePlatformAction(platform, existingResult, scheduledFor, nowMs) {
  if (existingResult?.success) return { action: "skip" };

  if (!PLATFORM_POSTERS[platform]) {
    return { action: "unknown", result: { success: false, error: `unknown platform "${platform}"` } };
  }

  const scheduledMs = scheduledFor ? new Date(scheduledFor).getTime() : null;
  const isFutureSchedule = scheduledMs && scheduledMs > nowMs;
  if (isFutureSchedule && !NATIVE_SCHEDULE_SUPPORTED[platform]) {
    // deferred, NOT skipped — a distinct state so decidePostingOutcome
    // keeps the row at "approved" (not "posted"/"failed") while anything is
    // still deferred, which is what keeps it visible to the sweep's
    // `WHERE status = 'approved'` query. Conflating this with "skipped, no
    // credentials" (which is fine to finalize around, since nothing further
    // will ever happen for that platform) would silently strand rows —
    // e.g. YouTube succeeds immediately via native scheduling while TikTok
    // is still waiting, status would flip to "posted", and the sweep would
    // never look at that row again to actually post to TikTok.
    return { action: "defer", result: { deferred: true, reason: `scheduled for ${new Date(scheduledMs).toISOString()}, not yet due` } };
  }

  return { action: "attempt" };
}

// Called both at approval time and (for rows with a future scheduled_for)
// again later by the scheduled-posts sweep. Safe to call more than once on
// the same row: results starts from whatever's already stored, already-
// successful platforms are never re-attempted, and whether a platform gets
// attempted THIS call vs deferred is derived from actual elapsed time
// (scheduled_for vs Date.now()) rather than a flag saying which caller this
// is — so the sweep doesn't need to tell this function anything special,
// it just needs to call it again once scheduled_for has actually passed.
async function runPostingJob(row) {
  const results = { ...(row.platform_post_ids || {}) };

  for (const platform of row.platform_targets) {
    const decision = decidePlatformAction(platform, results[platform], row.scheduled_for, Date.now());
    if (decision.action === "skip") continue; // already posted — never double-post
    if (decision.action === "defer") { results[platform] = decision.result; continue; }
    if (decision.action === "unknown") { results[platform] = decision.result; continue; }

    const poster = PLATFORM_POSTERS[platform];
    try {
      results[platform] = await poster(row);
    } catch (err) {
      results[platform] = { success: false, error: err.message };
    }
  }

  const { status, update } = decidePostingOutcome(results, row.status);

  const { error: updateErr } = await getSupabase().from("content_posts").update(update).eq("id", row.id);
  if (updateErr) console.error("[content_posts] runPostingJob update failed:", updateErr.message);

  return { status, results };
}

// Finds content_posts rows whose scheduled time has arrived and still have
// work left to do, and re-runs the posting job for each. Rows self-exclude
// once fully resolved: decidePostingOutcome flips status away from
// "approved" (to "posted" or "failed") once nothing's left pending, so this
// query naturally stops returning them — no extra bookkeeping needed.
async function runScheduledPostsSweep() {
  const { data: dueRows, error } = await getSupabase()
    .from("content_posts")
    .select("*")
    .eq("status", "approved")
    .not("scheduled_for", "is", null)
    .lte("scheduled_for", new Date().toISOString());

  if (error) throw new Error(`scheduled sweep query failed: ${error.message}`);

  const outcomes = [];
  for (const row of dueRows || []) {
    try {
      const result = await runPostingJob(row);
      outcomes.push({ id: row.id, ...result });
    } catch (err) {
      console.error(`[content_posts] sweep failed for row ${row.id}:`, err.message);
      outcomes.push({ id: row.id, status: "error", error: err.message });
    }
  }
  return outcomes;
}

// Pure decision logic, split out from runPostingJob so it's unit-testable
// without a live Supabase connection (see tests/content-posting.test.js).
// priorStatus is always "approved" in production (that's the only status
// runPostingJob is ever called with) but taking it as a parameter rather than
// hardcoding keeps the function honest about what it depends on.
function decidePostingOutcome(results, priorStatus) {
  const values = Object.values(results);
  const anySuccess = values.some(r => r.success);
  const anyAttempted = values.some(r => !r.skipped && !r.deferred);
  // While anything is still deferred (scheduled, not yet due), the row must
  // stay at "approved" regardless of what else happened this call — that's
  // what keeps it visible to the sweep's `WHERE status = 'approved'` query.
  // Otherwise e.g. YouTube succeeding immediately via native scheduling
  // would finalize the row as "posted" while TikTok is still waiting, and
  // nothing would ever come back to actually post it.
  const anyDeferred = values.some(r => r.deferred);

  let status = priorStatus;
  if (!anyDeferred) {
    if (anySuccess) status = "posted";
    else if (anyAttempted) status = "failed";
  }

  const update = { platform_post_ids: results };
  if (status !== priorStatus) update.status = status;
  if (status === "posted") update.posted_at = new Date().toISOString();
  if (status === "failed") {
    update.error = Object.entries(results)
      .filter(([, r]) => !r.success && !r.skipped && !r.deferred)
      .map(([p, r]) => `${p}: ${r.error || "failed"}`)
      .join("; ");
  }

  return { status, update };
}

// ─── result page rendering (for the plain-GET approve/reject links) ─────────

function describeResult(platform, r) {
  const label = platform.charAt(0).toUpperCase() + platform.slice(1);
  if (r.success) return `${label} posted ✓`;
  if (r.deferred) return `${label} scheduled — ${escapeHtml(r.reason)}`;
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
  runScheduledPostsSweep,
  decidePostingOutcome,
  decidePlatformAction,
  describeResult,
  renderResultPage,
  escapeHtml,
  hasRequiredLinks,
  linkSuffix,
  CANONICAL_LINK_LINE,
  buildTikTokInboxInitPayload,
  decideTikTokPollOutcome,
};
