/**
 * facebookAuth.js — one-time OAuth callback for getting a Facebook Page
 * Access Token, so postToFacebook can post videos to the linked Page.
 *
 * Separate from instagramAuth.js on purpose: Instagram Business Login and
 * Facebook Login are genuinely different Meta products/token families
 * (graph.instagram.com + IGAA-prefixed tokens vs graph.facebook.com +
 * EAA-prefixed tokens), even though they're managed from the same Meta app.
 * An Instagram Business Login token does NOT grant Facebook Page access.
 *
 * Flow: Meta redirects here with ?code=... after Mark authorizes via
 * Facebook Login (scopes: pages_show_list, pages_read_engagement,
 * pages_manage_posts). This exchanges the code for a User token, upgrades
 * it to a long-lived User token, then calls /me/accounts to list every
 * Page Mark manages along with that Page's own Access Token (Page tokens
 * derived from a long-lived User token are themselves long-lived/effectively
 * non-expiring — no separate exchange step needed, unlike Instagram).
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
table{border-collapse:collapse;margin:12px 0;width:100%} td{padding:6px 12px 6px 0;vertical-align:top;border-bottom:1px solid #eee} td:first-child{font-weight:600;white-space:nowrap}</style></head>
<body><h1>${escapeHtml(title)}</h1>${bodyHtml}</body></html>`;
}

async function handleFacebookCallback(req, res) {
  const { code, error, error_description } = req.query;
  const REDIRECT_URI = `${process.env.BACKEND_URL || process.env.RENDER_EXTERNAL_URL || "http://localhost:" + (process.env.PORT || 8080)}/auth/facebook/callback`;

  if (error) {
    return res.status(400).send(renderPage({
      title: "Facebook authorization failed",
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

  // Reuses the same Meta app credentials as Instagram (same app, different product).
  const { INSTAGRAM_APP_ID: FB_APP_ID, INSTAGRAM_APP_SECRET: FB_APP_SECRET } = process.env;
  if (!FB_APP_ID || !FB_APP_SECRET) {
    return res.status(503).send(renderPage({
      title: "Not configured yet",
      color: "#b91c1c",
      bodyHtml: `<p>Got the code, but INSTAGRAM_APP_ID/INSTAGRAM_APP_SECRET aren't set on Render (same app credentials used for Instagram — add those first).</p>`,
    }));
  }

  try {
    // 1. Exchange code for a short-lived User token.
    const shortLivedRes = await axios.get("https://graph.facebook.com/v21.0/oauth/access_token", {
      params: { client_id: FB_APP_ID, client_secret: FB_APP_SECRET, redirect_uri: REDIRECT_URI, code },
    });
    const shortLivedToken = shortLivedRes.data.access_token;

    // 2. Exchange for a long-lived User token (~60 days).
    const longLivedRes = await axios.get("https://graph.facebook.com/v21.0/oauth/access_token", {
      params: {
        grant_type: "fb_exchange_token",
        client_id: FB_APP_ID,
        client_secret: FB_APP_SECRET,
        fb_exchange_token: shortLivedToken,
      },
    });
    const longLivedUserToken = longLivedRes.data.access_token;

    // 3. List every Page this user manages + that Page's own Access Token.
    // Page tokens derived from a long-lived User token are themselves
    // long-lived — no further exchange needed.
    const pagesRes = await axios.get("https://graph.facebook.com/v21.0/me/accounts", {
      params: { access_token: longLivedUserToken },
    });
    let pages = pagesRes.data.data || [];

    // Fallback: Pages owned via a Business Portfolio (Meta Business Suite)
    // don't show up in /me/accounts unless the user also has a direct
    // per-Page role assigned — but they DO show up via
    // /me/businesses -> /{business_id}/owned_pages, given the
    // business_management scope (requested above). Try that path before
    // giving up.
    if (!pages.length) {
      try {
        const bizRes = await axios.get("https://graph.facebook.com/v21.0/me/businesses", { params: { access_token: longLivedUserToken } });
        const businesses = bizRes.data.data || [];
        const found = [];
        for (const biz of businesses) {
          const ownedRes = await axios.get(`https://graph.facebook.com/v21.0/${biz.id}/owned_pages`, { params: { access_token: longLivedUserToken } });
          for (const p of ownedRes.data.data || []) {
            try {
              const tokRes = await axios.get(`https://graph.facebook.com/v21.0/${p.id}`, { params: { fields: "name,access_token", access_token: longLivedUserToken } });
              found.push({ id: p.id, name: tokRes.data.name, access_token: tokRes.data.access_token, via_business: biz.name });
            } catch (_e) { /* couldn't get a page-level token for this one — skip it */ }
          }
        }
        pages = found;
      } catch (_e) { /* business_management likely wasn't granted this time — falls through to diagnostics below */ }
    }

    if (!pages.length) {
      // Diagnose rather than dead-end: confirm which user this was, and
      // which permissions were actually granted during authorization —
      // pages_show_list can silently not be granted even if the rest of
      // the consent screen was approved.
      let who = null, perms = null;
      try {
        const meRes = await axios.get("https://graph.facebook.com/v21.0/me", { params: { access_token: longLivedUserToken } });
        who = meRes.data;
      } catch (_e) {}
      try {
        const permRes = await axios.get("https://graph.facebook.com/v21.0/me/permissions", { params: { access_token: longLivedUserToken } });
        perms = permRes.data.data;
      } catch (_e) {}

      return res.send(renderPage({
        title: "No Pages found",
        color: "#b91c1c",
        bodyHtml: `
          <p>This account doesn't manage any Facebook Pages, or the pages_show_list permission wasn't granted during authorization.</p>
          <table>
            <tr><td>Authorized as</td><td>${who ? escapeHtml(who.name) + " (" + escapeHtml(who.id) + ")" : "lookup failed"}</td></tr>
            <tr><td>Granted permissions</td><td>${perms ? escapeHtml(JSON.stringify(perms)) : "lookup failed"}</td></tr>
          </table>
          <p style="color:#888;font-size:13px;">Long-lived user token (for debugging, not otherwise needed):</p>
          <div class="token">${escapeHtml(longLivedUserToken)}</div>
        `,
      }));
    }

    const rows = pages.map(p => `
      <tr><td colspan="2" style="padding-top:16px;font-weight:700;border-bottom:none;">${escapeHtml(p.name)}</td></tr>
      <tr><td>Page ID</td><td>${escapeHtml(p.id)}</td></tr>
      <tr><td>Page Access Token</td><td><div class="token">${escapeHtml(p.access_token)}</div></td></tr>
    `).join("");

    return res.send(renderPage({
      title: "Facebook authorization successful",
      color: "#15803d",
      bodyHtml: `
        <p>Found ${pages.length} Page(s). Copy the ID + token for the Mind Tranceform Page and send both back:</p>
        <table>${rows}</table>
        <p style="color:#888;font-size:13px;">These become FB_PAGE_ID / FB_PAGE_ACCESS_TOKEN on Render — never commit them anywhere.</p>
      `,
    }));
  } catch (err) {
    const detail = err.response?.data?.error?.message || err.response?.data || err.message;
    return res.status(500).send(renderPage({
      title: "Token exchange failed",
      color: "#b91c1c",
      bodyHtml: `<p>${escapeHtml(typeof detail === "string" ? detail : JSON.stringify(detail))}</p>`,
    }));
  }
}

module.exports = { handleFacebookCallback };
