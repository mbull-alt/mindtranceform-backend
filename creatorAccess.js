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

// Enforces the per-creator device cap.
// Known devices (seen in last 30 days, not revoked) are refreshed and allowed.
// New devices are counted; if count >= cap, throws DEVICE_CAP_EXCEEDED.
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
  appendAuditLog,
};
