// Unit tests for creatorAccess.js
// Run: node tests/creator-access.test.js
// No external dependencies — uses Node.js built-in assert.

const assert = require("assert");
const { isEntitledToPro, parseCookies, computeDeviceFingerprint } = require("../creatorAccess");

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

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
