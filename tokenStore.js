/**
 * tokenStore.js — durable OAuth token storage + refresh for Instagram and
 * TikTok, backed by the platform_tokens Supabase table (see
 * migrations/006_platform_tokens.sql).
 *
 * Why a DB table instead of just refreshing in memory: Render env vars are
 * static — this running process can't update them, so a refreshed token
 * would be lost on the next deploy/restart if not persisted somewhere. Each
 * getValid*Token() call checks the stored token's expiry (with a buffer),
 * refreshes if needed, persists the result, and returns a token guaranteed
 * usable right now. First call ever seeds the table from the original env
 * vars (IG_ACCESS_TOKEN / TIKTOK_ACCESS_TOKEN+REFRESH_TOKEN).
 *
 * Instagram: uses graph.instagram.com's ig_refresh_token grant — confirmed
 * (2026-08-16) this works directly on the token from Instagram Business
 * Login without needing the client secret, unlike the separate
 * ig_exchange_token endpoint which has an unresolved bug (see
 * contentPosting.js's postToInstagram comment). Extends ~60 days per call.
 *
 * TikTok: standard refresh_token grant. Access token lasts 24h, refresh
 * token 365 days — refresh_token itself may rotate on each use, which is
 * exactly why this needs to be persisted, not just re-read from the
 * original env var indefinitely.
 */

"use strict";

const { createClient } = require("@supabase/supabase-js");

let _supabase = null;
function getSupabase() {
  if (!_supabase) {
    _supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  }
  return _supabase;
}

// Refresh this far ahead of actual expiry, so a slow refresh call never
// races a token going stale mid-request.
const REFRESH_BUFFER_MS = {
  instagram: 5 * 24 * 60 * 60 * 1000, // 5 days, tokens last ~60
  tiktok: 2 * 60 * 60 * 1000,          // 2 hours, tokens last 24
};

async function getStoredToken(platform) {
  const { data, error } = await getSupabase().from("platform_tokens").select("*").eq("platform", platform).maybeSingle();
  if (error) throw new Error(`platform_tokens lookup failed: ${error.message}`);
  return data;
}

async function saveToken(platform, { access_token, refresh_token, access_token_expires_at, refresh_token_expires_at, scope }) {
  const { error } = await getSupabase().from("platform_tokens").upsert({
    platform, access_token, refresh_token: refresh_token ?? null,
    access_token_expires_at, refresh_token_expires_at: refresh_token_expires_at ?? null,
    scope: scope ?? null,
    updated_at: new Date().toISOString(),
  });
  if (error) throw new Error(`platform_tokens save failed: ${error.message}`);
}

// ─── Instagram ──────────────────────────────────────────────────────────────

async function getValidInstagramToken() {
  let stored = await getStoredToken("instagram");
  if (!stored) {
    const seed = process.env.IG_ACCESS_TOKEN;
    if (!seed) return null;
    // Treat the env-var seed as already-expired so it gets refreshed (and
    // persisted as a real long-lived token) on this very first call.
    stored = { access_token: seed, access_token_expires_at: new Date(0).toISOString() };
  }

  if (Date.now() < new Date(stored.access_token_expires_at).getTime() - REFRESH_BUFFER_MS.instagram) {
    return stored.access_token;
  }

  const axios = require("axios");
  const res = await axios.get("https://graph.instagram.com/refresh_access_token", {
    params: { grant_type: "ig_refresh_token", access_token: stored.access_token },
  });
  const { access_token, expires_in } = res.data;
  const access_token_expires_at = new Date(Date.now() + expires_in * 1000).toISOString();
  await saveToken("instagram", { access_token, access_token_expires_at });
  return access_token;
}

// ─── TikTok ─────────────────────────────────────────────────────────────────

async function getValidTikTokToken() {
  let stored = await getStoredToken("tiktok");
  if (!stored) {
    const access_token = process.env.TIKTOK_ACCESS_TOKEN;
    const refresh_token = process.env.TIKTOK_REFRESH_TOKEN;
    if (!access_token || !refresh_token) return null;
    stored = { access_token, refresh_token, access_token_expires_at: new Date(0).toISOString() };
  }

  if (Date.now() < new Date(stored.access_token_expires_at).getTime() - REFRESH_BUFFER_MS.tiktok) {
    return stored.access_token;
  }

  const { TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET } = process.env;
  if (!TIKTOK_CLIENT_KEY || !TIKTOK_CLIENT_SECRET) {
    throw new Error("TIKTOK_CLIENT_KEY/TIKTOK_CLIENT_SECRET not set — needed to refresh the TikTok access token");
  }

  const axios = require("axios");
  const res = await axios.post(
    "https://open.tiktokapis.com/v2/oauth/token/",
    new URLSearchParams({
      client_key: TIKTOK_CLIENT_KEY,
      client_secret: TIKTOK_CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: stored.refresh_token,
    }),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );
  const { access_token, refresh_token, expires_in, refresh_expires_in, scope } = res.data;
  const access_token_expires_at = new Date(Date.now() + expires_in * 1000).toISOString();
  const refresh_token_expires_at = new Date(Date.now() + refresh_expires_in * 1000).toISOString();
  // TikTok's refresh_token grant doesn't always echo scope back — fall back
  // to what's already stored rather than overwriting it with null.
  await saveToken("tiktok", { access_token, refresh_token, access_token_expires_at, refresh_token_expires_at, scope: scope || stored.scope || null });
  return access_token;
}

module.exports = { getValidInstagramToken, getValidTikTokToken, getSupabase };
