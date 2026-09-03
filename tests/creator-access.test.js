// Unit tests for creatorAccess.js
// Run: node tests/creator-access.test.js
// No external dependencies — uses Node.js built-in assert.

const assert = require("assert");
const { isEntitledToPro, parseCookies, computeDeviceFingerprint, effectivePlan, shouldEnforceDeviceCap } = require("../creatorAccess");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    failed++;
  }
}

console.log("\nisEntitledToPro");

test("returns true for paying subscriber", () => {
  assert.strictEqual(isEntitledToPro({ is_subscriber: true }), true);
});

test("returns true for active creator with no expiry", () => {
  assert.strictEqual(
    isEntitledToPro({ is_subscriber: false, creator_access_active: true, creator_access_expires_at: null }),
    true
  );
});

test("returns true for active creator with future expiry", () => {
  const future = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString();
  assert.strictEqual(
    isEntitledToPro({ is_subscriber: false, creator_access_active: true, creator_access_expires_at: future }),
    true
  );
});

test("returns false for active creator with past expiry", () => {
  const past = new Date(Date.now() - 1000).toISOString();
  assert.strictEqual(
    isEntitledToPro({ is_subscriber: false, creator_access_active: true, creator_access_expires_at: past }),
    false
  );
});

test("returns false when creator_access_active is false", () => {
  assert.strictEqual(
    isEntitledToPro({ is_subscriber: false, creator_access_active: false, creator_access_expires_at: null }),
    false
  );
});

test("returns false for null profile", () => {
  assert.strictEqual(isEntitledToPro(null), false);
});

test("is_subscriber true overrides expired creator access", () => {
  const past = new Date(Date.now() - 1000).toISOString();
  assert.strictEqual(
    isEntitledToPro({ is_subscriber: true, creator_access_active: true, creator_access_expires_at: past }),
    true
  );
});

console.log("\nparseCookies");

test("returns empty object for undefined header", () => {
  assert.deepStrictEqual(parseCookies(undefined), {});
});

test("parses single cookie", () => {
  assert.deepStrictEqual(parseCookies("device_id=abc123"), { device_id: "abc123" });
});

test("parses multiple cookies", () => {
  const result = parseCookies("device_id=abc; session=xyz; other=1");
  assert.strictEqual(result["device_id"], "abc");
  assert.strictEqual(result["session"], "xyz");
  assert.strictEqual(result["other"], "1");
});

console.log("\ncomputeDeviceFingerprint");

test("is deterministic with same inputs", () => {
  const req = { headers: { "user-agent": "TestUA/1.0", "accept-language": "en-US", "x-forwarded-for": "1.2.3.4" }, ip: "" };
  const f1 = computeDeviceFingerprint(req, "cookie-abc");
  const f2 = computeDeviceFingerprint(req, "cookie-abc");
  assert.strictEqual(f1, f2);
});

console.log("\neffectivePlan");

test("no profile -> null", () => {
  assert.strictEqual(effectivePlan(null), null);
});

test("plan: null, active pro grant, no expiry -> pro", () => {
  assert.strictEqual(
    effectivePlan({ plan: null, is_subscriber: false, creator_access_active: true, creator_access_tier: "pro", creator_access_expires_at: null }),
    "pro"
  );
});

test("plan: null, active grant, expired -> null — the 12-month-renewable protection; the most important case here", () => {
  const past = new Date(Date.now() - 1000).toISOString();
  assert.strictEqual(
    effectivePlan({ plan: null, is_subscriber: false, creator_access_active: true, creator_access_tier: "pro", creator_access_expires_at: past }),
    null
  );
});

test("plan: single, active pro grant -> pro — comp beats paid", () => {
  assert.strictEqual(
    effectivePlan({ plan: "single", is_subscriber: false, creator_access_active: true, creator_access_tier: "pro", creator_access_expires_at: null }),
    "pro"
  );
});

test("plan: pro, is_subscriber: true, expired grant -> pro — paid tier unaffected by grant expiry", () => {
  const past = new Date(Date.now() - 1000).toISOString();
  assert.strictEqual(
    effectivePlan({ plan: "pro", is_subscriber: true, creator_access_active: true, creator_access_tier: "premium", creator_access_expires_at: past }),
    "pro"
  );
});

test("creator_access_active: false, plan: premium -> premium", () => {
  assert.strictEqual(
    effectivePlan({ plan: "premium", is_subscriber: false, creator_access_active: false, creator_access_tier: "pro", creator_access_expires_at: null }),
    "premium"
  );
});

test("unknown/garbage creator_access_tier with an active grant -> pro, not the raw garbage string", () => {
  assert.strictEqual(
    effectivePlan({ plan: null, is_subscriber: false, creator_access_active: true, creator_access_tier: "legacy_vip_v2", creator_access_expires_at: null }),
    "pro"
  );
});

console.log("\nshouldEnforceDeviceCap");

test("subscriber -> false — paying subscribers never hit device-cap logic", () => {
  assert.strictEqual(
    shouldEnforceDeviceCap({ is_subscriber: true, creator_access_active: true, creator_access_device_cap: 5 }),
    false
  );
});

test("creator_access_active: false -> false", () => {
  assert.strictEqual(
    shouldEnforceDeviceCap({ is_subscriber: false, creator_access_active: false, creator_access_device_cap: 5 }),
    false
  );
});

test("active with cap null -> false — the uncapped org/pilot/clinic case", () => {
  assert.strictEqual(
    shouldEnforceDeviceCap({ is_subscriber: false, creator_access_active: true, creator_access_device_cap: null }),
    false
  );
});

test("active with cap 0 -> false", () => {
  assert.strictEqual(
    shouldEnforceDeviceCap({ is_subscriber: false, creator_access_active: true, creator_access_device_cap: 0 }),
    false
  );
});

test("active with cap 5 -> true — the capped influencer/creator case", () => {
  assert.strictEqual(
    shouldEnforceDeviceCap({ is_subscriber: false, creator_access_active: true, creator_access_device_cap: 5 }),
    true
  );
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
