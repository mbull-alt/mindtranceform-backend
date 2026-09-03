const crypto = require("crypto");

// Returns true if the user profile entitles access to Pro features.
// Checks paying subscriber first, then active creator grant with expiry.
function isEntitledToPro(profile) {
  if (!profile) return false;
  if (profile.is_subscriber) return true;
  if (!profile.creator_access_active) return false;
  if (profile.creator_access_expires_at) {
    return new Date(profile.creator_access_expires_at) > new Date();
  }
  return true;
}

const PLAN_RANK = { single: 1, premium: 2, pro: 3 };

// Highest tier the user is entitled to right now: the greater of what they pay
// for and what they have been comped. Returns null for no entitlement.
// Creator grants expire via isEntitledToPro(); `plan` never does — keep them separate.
function effectivePlan(profile) {
  if (!profile) return null;
  const paid = PLAN_RANK[profile.plan] ? profile.plan : null;
  const comped = isEntitledToPro(profile) && !profile.is_subscriber
    ? (PLAN_RANK[profile.creator_access_tier] ? profile.creator_access_tier : "pro")
    : null;
  if (!paid) return comped;
  if (!comped) return paid;
  return PLAN_RANK[comped] > PLAN_RANK[paid] ? comped : paid;
}

// Minimal cookie parser — avoids adding cookie-parser dependency.
function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  for (const pair of cookieHeader.split(";")) {
    const idx = pair.indexOf("=");
    if (idx < 0) continue;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    if (k) cookies[k] = v;
  }
  return cookies;
}

// SHA-256 fingerprint of stable request signals.
// IP /24 tolerates CGNAT drift within the same household.
function computeDeviceFingerprint(req, deviceIdCookie) {
  const ua       = req.headers["user-agent"]       || "";
  const lang     = req.headers["accept-language"]   || "";
  const deviceId = deviceIdCookie                   || "";
  const rawIp    = (req.headers["x-forwarded-for"]  || req.ip || "").split(",")[0].trim();
  const ip24     = rawIp.split(".").slice(0, 3).join(".");
  return crypto.createHash("sha256").update(`${ua}|${lang}|${deviceId}|${ip24}`).digest("hex");
}

// Device cap exists to limit login sharing on influencer/creator grants.
// Org, clinic and pilot grants are uncapped: creator_access_device_cap IS NULL.
// Decided 2026-09-03, after the 2026-09-01 App Review 403 — a cap of 2 locked
// a reviewer out on their second device, with no support-desk device-release
// procedure behind the resulting "contact support" message.
function shouldEnforceDeviceCap(profile) {
  if (!profile) return false;
  if (profile.is_subscriber) return false;
  if (!profile.creator_access_active) return false;
  const cap = profile.creator_access_device_cap;
  return typeof cap === "number" && cap > 0;
}

// Enforces the per-creator device cap. Only ever called when
// shouldEnforceDeviceCap(profile) is true, so deviceCap is always a real
// positive number here — no fallback needed. Known devices (seen in last 30
// days, not revoked) are refreshed and allowed; new devices are counted, and
// if count >= cap, throws DEVICE_CAP_EXCEEDED.
async function enforceDeviceCap(supabase, userId, fingerprint, deviceCap) {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const { data: existing } = await supabase
    .from("user_devices")
    .select("fingerprint")
    .eq("user_id", userId)
    .eq("fingerprint", fingerprint)
    .is("revoked_at", null)
    .gte("last_seen_at", since)
    .maybeSingle();

  if (existing) {
    await supabase
      .from("user_devices")
      .update({ last_seen_at: new Date().toISOString() })
      .eq("user_id", userId)
      .eq("fingerprint", fingerprint);
    return;
  }

  const { data: active } = await supabase
    .from("user_devices")
    .select("fingerprint")
    .eq("user_id", userId)
    .is("revoked_at", null)
    .gte("last_seen_at", since);

  if ((active?.length || 0) >= deviceCap) {
    const err = new Error("Device cap exceeded");
    err.code = "DEVICE_CAP_EXCEEDED";
    throw err;
  }

  await supabase
    .from("user_devices")
    .insert({ user_id: userId, fingerprint, last_seen_at: new Date().toISOString() });
}

async function appendAuditLog(supabase, event, actorEmail, targetUserId, targetEmail, details) {
  await supabase.from("audit_log").insert({
    event,
    actor_email:    actorEmail    || null,
    target_user_id: targetUserId  || null,
    target_email:   targetEmail   || null,
    details:        details       || {},
  });
}

module.exports = {
  isEntitledToPro,
  parseCookies,
  computeDeviceFingerprint,
  enforceDeviceCap,
  shouldEnforceDeviceCap,
  appendAuditLog,
  effectivePlan,
  PLAN_RANK,
};
