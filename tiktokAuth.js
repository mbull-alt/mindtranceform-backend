/**
 * tiktokAuth.js — OAuth start + callback for TikTok Content Posting API
 * access, plus a diagnostic. Mirrors instagramAuth.js/facebookAuth.js's
 * shape for the callback; start/diagnostic are new (2026-09-03).
 *
 * Flow: /auth/tiktok/start builds TikTok's Login Kit authorize URL and
 * redirects there (scope: user.info.basic,video.upload — Direct Post is
 * disabled in the app's Developer Portal config, confirmed 2026-09-02;
 * video.publish, the Direct Post scope, was never granted and must not be
 * requested). TikTok redirects back to /auth/tiktok/callback with ?code=,
 * which is checked against a short-lived server-side state, exchanged for an
 * access_token + refresh_token, and persisted into platform_tokens via
 * tokenStore — never rendered on the page.
 *
 * An unaudited app can only complete this flow signed in as the developer's
 * own TikTok account (the account that owns the app in the Developer
 * Portal). That's a TikTok-side restriction, not something this code
 * enforces.
 *
 * Token lifetimes (per TikTok's docs, checked 2026-08-15): access_token
 * valid 24 hours, refresh_token valid 365 days. tokenStore.getValidTikTokToken
 * refreshes ahead of the 24h expiry and re-persists — see that file.
 *
 * postToTikTok (contentPosting.js) posts via the inbox/draft upload flow,
 * not Direct Post — it sends no privacy_level, since that endpoint takes no
 * post_info at all (confirmed 2026-09-02). The Direct Post SELF_ONLY
 * restriction for unaudited apps doesn't apply to this flow: inbox drafts
 * are never public until the creator manually finishes the post in-app.
 */

"use strict";

const axios = require("axios");
const { randomUUID } = require("crypto");

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function renderPage({ title, color, bodyHtml }) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:640px;margin:60px auto;padding:0 20px;color:#111}
h1{font-size:20px;color:${color}} .token{word-break:break-all;background:#f3f4f6;padding:12px;border-radius:6px;font-family:monospace;font-size:13px;margin:8px 0}
table{border-collapse:collapse;margin:12px 0} td{padding:4px 12px 4px 0;vertical-align:top} td:first-child{font-weight:600;white-space:nowrap}</style></head>
<body><h1>${escapeHtml(title)}</h1>${bodyHtml}</body></html>`;
}

function getRedirectUri() {
  return `${process.env.BACKEND_URL || process.env.RENDER_EXTERNAL_URL || "http://localhost:" + (process.env.PORT || 8080)}/auth/tiktok/callback`;
}

// CSRF state for the OAuth round trip. In-memory is fine here: this is a
// manual, interactive, one-person flow completed in a single browser
// sitting, not a durable credential — losing pending states on a restart
// just means starting over at /auth/tiktok/start.
const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const pendingStates = new Map(); // state -> expiresAt (ms epoch)

function createState() {
  const state = randomUUID();
  pendingStates.set(state, Date.now() + STATE_TTL_MS);
  return state;
}

// One-time use: consumed (deleted) whether or not it's valid, so a replayed
// callback URL can never succeed twice.
function consumeState(state) {
  if (!state || !pendingStates.has(state)) return false;
  const expiresAt = pendingStates.get(state);
  pendingStates.delete(state);
  return Date.now() < expiresAt;
}

// Not gated behind requireAdmin: that middleware only accepts an x-admin-key
// header or a Bearer JWT, neither of which a plain browser navigation (or a
// link click) can attach — wrapping this route in it would break the exact
// flow it exists for. The practical exposure is small and TikTok-side: an
// unaudited app only completes authorization for the developer's own
// account, so a stranger hitting this URL can get redirected to TikTok's
// login but can't complete the handshake as anyone but the account that
// already controls the Developer Portal app.
async function handleTikTokStart(req, res) {
  const { TIKTOK_CLIENT_KEY } = process.env;
  if (!TIKTOK_CLIENT_KEY) {
    return res.status(503).send(renderPage({
      title: "Not configured yet",
      color: "#b91c1c",
      bodyHtml: `<p>TIKTOK_CLIENT_KEY isn't set on Render yet. Check <a href="/content/tiktok-status">/content/tiktok-status</a>.</p>`,
    }));
  }

  const state = createState();
  const authorizeUrl = new URL("https://www.tiktok.com/v2/auth/authorize/");
  authorizeUrl.searchParams.set("client_key", TIKTOK_CLIENT_KEY);
  authorizeUrl.searchParams.set("scope", "user.info.basic,video.upload");
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("redirect_uri", getRedirectUri());
  authorizeUrl.searchParams.set("state", state);

  res.redirect(authorizeUrl.toString());
}

async function handleTikTokCallback(req, res) {
  const { code, state, error, error_description } = req.query;
  const REDIRECT_URI = getRedirectUri();

  if (error) {
    return res.status(400).send(renderPage({
      title: "TikTok authorization failed",
      color: "#b91c1c",
      bodyHtml: `<p>${escapeHtml(error)}: ${escapeHtml(error_description || "no description")}</p>`,
    }));
  }

  if (!consumeState(state)) {
    return res.status(400).send(renderPage({
      title: "Invalid or expired authorization attempt",
      color: "#b91c1c",
      bodyHtml: `<p>The <code>state</code> parameter didn't match a request from <a href="/auth/tiktok/start">/auth/tiktok/start</a>, or it expired (10 minute window). Start over there rather than reloading this page.</p>`,
    }));
  }

  if (!code) {
    return res.status(400).send(renderPage({
      title: "Missing authorization code",
      color: "#b91c1c",
      bodyHtml: `<p>No ?code= in the callback URL.</p>`,
    }));
  }

  const { TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET } = process.env;
  if (!TIKTOK_CLIENT_KEY || !TIKTOK_CLIENT_SECRET) {
    return res.status(503).send(renderPage({
      title: "Not configured yet",
      color: "#b91c1c",
      bodyHtml: `<p>Got the code, but TIKTOK_CLIENT_KEY/TIKTOK_CLIENT_SECRET aren't set on Render yet.</p>`,
    }));
  }

  try {
    const tokenRes = await axios.post(
      "https://open.tiktokapis.com/v2/oauth/token/",
      new URLSearchParams({
        client_key: TIKTOK_CLIENT_KEY,
        client_secret: TIKTOK_CLIENT_SECRET,
        code,
        grant_type: "authorization_code",
        redirect_uri: REDIRECT_URI,
      }),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );

    const { access_token, refresh_token, expires_in, refresh_expires_in, scope } = tokenRes.data;

    const access_token_expires_at = new Date(Date.now() + expires_in * 1000).toISOString();
    const refresh_token_expires_at = refresh_expires_in
      ? new Date(Date.now() + refresh_expires_in * 1000).toISOString()
      : null;

    const { saveToken } = require("./tokenStore");
    await saveToken("tiktok", { access_token, refresh_token, access_token_expires_at, refresh_token_expires_at, scope });

    // Best-effort handle lookup for the confirmation page. The token is
    // already saved at this point — a failed lookup here shouldn't read as
    // a failed authorization.
    let handle = null;
    try {
      const userRes = await axios.get("https://open.tiktokapis.com/v2/user/info/", {
        params: { fields: "display_name" },
        headers: { Authorization: `Bearer ${access_token}` },
      });
      handle = userRes.data?.data?.user?.display_name || null;
    } catch (_userErr) {
      // Leave handle null — shown as "connected" below with a pointer to the diagnostic.
    }

    return res.send(renderPage({
      title: "TikTok authorization successful",
      color: "#15803d",
      bodyHtml: `
        <table>
          <tr><td>Account</td><td>${escapeHtml(handle || "connected (name lookup failed — check /content/tiktok-status)")}</td></tr>
          <tr><td>Scope</td><td>${escapeHtml(scope || "n/a")}</td></tr>
          <tr><td>Access token expires</td><td>${expires_in ? Math.round(expires_in / 3600) + " hours" : "n/a"}</td></tr>
        </table>
        <p>Saved to <code>platform_tokens</code> — nothing to copy or paste into Render.</p>
        <p style="color:#888;font-size:13px;">Next: queue one real post, approve it, and confirm the video lands in TikTok Drafts.</p>
      `,
    }));
  } catch (err) {
    const detail = err.response?.data?.error_description || err.response?.data || err.message;
    return res.status(500).send(renderPage({
      title: "TikTok connection failed",
      color: "#b91c1c",
      bodyHtml: `<p>${escapeHtml(typeof detail === "string" ? detail : JSON.stringify(detail))}</p>`,
    }));
  }
}

// Admin-guarded diagnostic (wired with requireAdmin at the route in
// server.js). Reports presence, not values — never a token, never a prefix.
// Distinguishes "platform_tokens doesn't exist" from "it exists but has no
// tiktok row" from "it has one" — those three states used to be
// indistinguishable from outside, which is exactly the trap the
// content_posts work hit in August.
async function handleTikTokStatus(req, res) {
  const env = {
    TIKTOK_CLIENT_KEY: !!process.env.TIKTOK_CLIENT_KEY,
    TIKTOK_CLIENT_SECRET: !!process.env.TIKTOK_CLIENT_SECRET,
    TIKTOK_ACCESS_TOKEN: !!process.env.TIKTOK_ACCESS_TOKEN,
    TIKTOK_REFRESH_TOKEN: !!process.env.TIKTOK_REFRESH_TOKEN,
  };

  const { getSupabase } = require("./tokenStore");
  const { data, error } = await getSupabase()
    .from("platform_tokens")
    .select("access_token_expires_at, refresh_token_expires_at, scope")
    .eq("platform", "tiktok")
    .maybeSingle();

  let platform_tokens;
  if (error) {
    // 42P01 = Postgres undefined_table; PostgREST also surfaces this as a
    // "does not exist" message on some versions — check both.
    const missing = error.code === "42P01" || /does not exist/i.test(error.message || "");
    platform_tokens = missing
      ? { table_exists: false, row_present: false, note: "run migrations/006_platform_tokens.sql" }
      : { table_exists: "unknown", row_present: false, error: error.message };
  } else if (!data) {
    platform_tokens = { table_exists: true, row_present: false };
  } else {
    platform_tokens = {
      table_exists: true,
      row_present: true,
      access_token_expires_at: data.access_token_expires_at,
      refresh_token_expires_at: data.refresh_token_expires_at,
      scope: data.scope || null,
    };
  }

  res.json({ env, platform_tokens });
}

module.exports = { handleTikTokStart, handleTikTokCallback, handleTikTokStatus };
