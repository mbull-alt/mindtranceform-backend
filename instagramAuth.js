/**
 * instagramAuth.js — one-time OAuth callback handler for setting up
 * "Instagram API with Instagram Login" (Instagram Business Login) access.
 *
 * Not part of the ongoing content_posts posting pipeline — this exists
 * purely so Mark can complete the one-time authorization flow in his
 * browser and get back a long-lived access token + Instagram Business
 * Account ID to hand to Claude Code, which then goes into Render as
 * IG_PAGE_ACCESS_TOKEN / IG_BUSINESS_ACCOUNT_ID for postToInstagram.
 *
 * Flow: Meta redirects the browser here with ?code=... after Mark
 * authorizes. This exchanges that code for a short-lived token, then
 * exchanges that for a 60-day long-lived token, then renders both the
 * token and the account info on a plain HTML page for him to copy.
 *
 * Requires INSTAGRAM_APP_ID / INSTAGRAM_APP_SECRET as env vars — these
 * are NOT secret in the OAuth-authorize-URL sense (App ID is public) but
 * the App Secret is, so both are Render env vars only, same as everything
 * else in this pipeline.
 */

"use strict";

const axios = require("axios");
const crypto = require("crypto");

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

async function handleInstagramCallback(req, res) {
  const { code, error, error_description } = req.query;
  const REDIRECT_URI = `${process.env.BACKEND_URL || process.env.RENDER_EXTERNAL_URL || "http://localhost:" + (process.env.PORT || 8080)}/auth/instagram/callback`;

  if (error) {
    return res.status(400).send(renderPage({
      title: "Instagram authorization failed",
      color: "#b91c1c",
      bodyHtml: `<p>${escapeHtml(error)}: ${escapeHtml(error_description || "no description")}</p>`,
    }));
  }

  if (!code) {
    return res.status(400).send(renderPage({
      title: "Missing authorization code",
      color: "#b91c1c",
      bodyHtml: `<p>No ?code= in the callback URL. Did you land here directly instead of via Meta's authorize redirect?</p>`,
    }));
  }

  const { INSTAGRAM_APP_ID, INSTAGRAM_APP_SECRET } = process.env;
  if (!INSTAGRAM_APP_ID || !INSTAGRAM_APP_SECRET) {
    return res.status(503).send(renderPage({
      title: "Not configured yet",
      color: "#b91c1c",
      bodyHtml: `<p>Got the authorization code, but INSTAGRAM_APP_ID / INSTAGRAM_APP_SECRET aren't set on Render yet. Add those (from the Meta app's Basic Settings) and try the authorize link again — codes are single-use and short-lived, so you'll need a fresh one.</p>`,
    }));
  }

  try {
    // 1. Exchange the code for a short-lived token (~1hr).
    const shortLivedRes = await axios.post(
      "https://api.instagram.com/oauth/access_token",
      new URLSearchParams({
        client_id: INSTAGRAM_APP_ID,
        client_secret: INSTAGRAM_APP_SECRET,
        grant_type: "authorization_code",
        redirect_uri: REDIRECT_URI,
        code,
      })
    );
    const { access_token: shortLivedToken, user_id } = shortLivedRes.data;

    // 2. Exchange the short-lived token for a 60-day long-lived token.
    const longLivedRes = await axios.get("https://graph.instagram.com/access_token", {
      params: { grant_type: "ig_exchange_token", client_secret: INSTAGRAM_APP_SECRET, access_token: shortLivedToken },
    });
    const { access_token: longLivedToken, expires_in } = longLivedRes.data;

    // 3. Fetch account info so Mark can confirm this is the right account.
    const meRes = await axios.get(`https://graph.instagram.com/${user_id}`, {
      params: { fields: "id,username,account_type", access_token: longLivedToken },
    });

    const expiresDate = new Date(Date.now() + expires_in * 1000).toISOString().slice(0, 10);

    return res.send(renderPage({
      title: "Instagram authorization successful",
      color: "#15803d",
      bodyHtml: `
        <table>
          <tr><td>Username</td><td>@${escapeHtml(meRes.data.username)}</td></tr>
          <tr><td>Account type</td><td>${escapeHtml(meRes.data.account_type)}</td></tr>
          <tr><td>Instagram Business Account ID</td><td>${escapeHtml(meRes.data.id)}</td></tr>
          <tr><td>Token expires</td><td>${expiresDate} (60 days — will need a refresh before then)</td></tr>
        </table>
        <p>Long-lived access token — copy this and send it back:</p>
        <div class="token">${escapeHtml(longLivedToken)}</div>
        <p style="color:#888;font-size:13px;">Send this token + the Account ID above. These become IG_PAGE_ACCESS_TOKEN / IG_BUSINESS_ACCOUNT_ID on Render — never commit them anywhere.</p>
      `,
    }));
  } catch (err) {
    const detail = err.response?.data?.error_message || err.response?.data || err.message;
    return res.status(500).send(renderPage({
      title: "Token exchange failed",
      color: "#b91c1c",
      bodyHtml: `<p>${escapeHtml(typeof detail === "string" ? detail : JSON.stringify(detail))}</p>`,
    }));
  }
}

// ─── deauthorize callback ────────────────────────────────────────────────────
// Meta POSTs here (application/x-www-form-urlencoded, field `signed_request`)
// when the authorized account removes the app's access. Verifies the HMAC
// signature with the app secret per Meta's spec, then just logs it — this
// app only holds one shared token (IG_PAGE_ACCESS_TOKEN on Render) for the
// single Mind Tranceform account, not a per-user token store, so there's
// nothing else to clean up automatically. If this ever fires unexpectedly,
// it means that token is dead and Instagram Business Login needs re-running.

function parseSignedRequest(signedRequest, appSecret) {
  const [encodedSig, encodedPayload] = signedRequest.split(".");
  if (!encodedSig || !encodedPayload) throw new Error("malformed signed_request");
  const sig = Buffer.from(encodedSig.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  const expectedSig = crypto.createHmac("sha256", appSecret).update(encodedPayload).digest();
  if (sig.length !== expectedSig.length || !crypto.timingSafeEqual(sig, expectedSig)) {
    throw new Error("signature mismatch");
  }
  return JSON.parse(Buffer.from(encodedPayload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());
}

function handleDeauthorize(req, res) {
  const { signed_request } = req.body || {};
  if (!signed_request) return res.sendStatus(400);
  const { INSTAGRAM_APP_SECRET } = process.env;
  if (!INSTAGRAM_APP_SECRET) {
    console.error("[instagram] deauthorize callback hit but INSTAGRAM_APP_SECRET not set — cannot verify");
    return res.sendStatus(503);
  }
  try {
    const data = parseSignedRequest(signed_request, INSTAGRAM_APP_SECRET);
    console.warn(`[instagram] Deauthorize received for user_id ${data.user_id}. IG_PAGE_ACCESS_TOKEN on Render is likely now invalid — Instagram Business Login will need re-running.`);
    res.sendStatus(200);
  } catch (err) {
    console.error("[instagram] deauthorize signature check failed:", err.message);
    res.sendStatus(400);
  }
}

// ─── data deletion instructions ──────────────────────────────────────────────
// Meta accepts either an automated callback (receive signed_request, respond
// with {url, confirmation_code} and host a status-check page) or a simple
// static Instructions URL. Going with the static page: this app is a
// single-account automation tool, not a multi-user consumer app — there's no
// per-user data store, so there's nothing for an automated deletion flow to
// actually act on. The instructions page is the honest, proportionate option.

function handleDataDeletionInstructions(_req, res) {
  res.send(renderPage({
    title: "Data Deletion Instructions",
    color: "#111",
    bodyHtml: `
      <p>Mind Tranceform's content-posting integration is configured for a single
      Instagram Business account and does not collect or store data for any other
      Instagram users.</p>
      <p>To request deletion of any data associated with your account's connection
      to this integration, email
      <a href="mailto:hello@mindtranceformapp.com">hello@mindtranceformapp.com</a>
      with your Instagram username. Requests are processed within 30 days.</p>
    `,
  }));
}

module.exports = { handleInstagramCallback, handleDeauthorize, handleDataDeletionInstructions };
