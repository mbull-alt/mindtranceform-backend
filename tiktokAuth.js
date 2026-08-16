/**
 * tiktokAuth.js — one-time OAuth callback for TikTok Content Posting API
 * access. Mirrors instagramAuth.js/facebookAuth.js's shape.
 *
 * Flow: TikTok redirects here with ?code=&state= after Mark authorizes via
 * TikTok Login Kit (scope: video.publish). Exchanges the code for an
 * access_token + refresh_token and shows both for copying.
 *
 * Token lifetimes (per TikTok's docs, checked 2026-08-15): access_token
 * valid 24 hours, refresh_token valid 365 days. postToTikTok uses the
 * access_token directly; refreshing before the 24h expiry isn't
 * implemented yet — flagged as a known gap, same as Instagram's token
 * lifetime issue.
 *
 * Unaudited apps (this one, until/unless a TikTok audit is submitted and
 * approved) are restricted to SELF_ONLY visibility regardless of what
 * privacy_level is requested — enforced by TikTok itself, not something
 * to work around.
 */

"use strict";

const axios = require("axios");

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

async function handleTikTokCallback(req, res) {
  const { code, error, error_description } = req.query;
  const REDIRECT_URI = `${process.env.BACKEND_URL || process.env.RENDER_EXTERNAL_URL || "http://localhost:" + (process.env.PORT || 8080)}/auth/tiktok/callback`;

  if (error) {
    return res.status(400).send(renderPage({
      title: "TikTok authorization failed",
      color: "#b91c1c",
      bodyHtml: `<p>${escapeHtml(error)}: ${escapeHtml(error_description || "no description")}</p>`,
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

    const { access_token, refresh_token, expires_in, refresh_expires_in, open_id, scope } = tokenRes.data;

    return res.send(renderPage({
      title: "TikTok authorization successful",
      color: "#15803d",
      bodyHtml: `
        <table>
          <tr><td>Open ID</td><td>${escapeHtml(open_id || "n/a")}</td></tr>
          <tr><td>Scope</td><td>${escapeHtml(scope || "n/a")}</td></tr>
          <tr><td>Access token expires</td><td>${expires_in ? Math.round(expires_in / 3600) + " hours" : "n/a"}</td></tr>
          <tr><td>Refresh token expires</td><td>${refresh_expires_in ? Math.round(refresh_expires_in / 86400) + " days" : "n/a"}</td></tr>
        </table>
        <p>Access token — copy this and send it back:</p>
        <div class="token">${escapeHtml(access_token)}</div>
        <p>Refresh token (keep this too — the access token expires in 24h):</p>
        <div class="token">${escapeHtml(refresh_token)}</div>
        <p style="color:#888;font-size:13px;">These become TIKTOK_ACCESS_TOKEN / TIKTOK_REFRESH_TOKEN on Render — never commit them anywhere.</p>
      `,
    }));
  } catch (err) {
    const detail = err.response?.data?.error_description || err.response?.data || err.message;
    return res.status(500).send(renderPage({
      title: "Token exchange failed",
      color: "#b91c1c",
      bodyHtml: `<p>${escapeHtml(typeof detail === "string" ? detail : JSON.stringify(detail))}</p>`,
    }));
  }
}

module.exports = { handleTikTokCallback };
