// Unit tests for the pure logic in contentPosting.js — decidePostingOutcome,
// describeResult, renderResultPage, escapeHtml. Deliberately does NOT test
// queueContentPost/approveContentPost/rejectContentPost here, since those
// need a live Supabase connection — that's covered by a manual fake-row test
// against a real (dev) Supabase project instead, per the build spec's
// "fully testable with a fake row before touching any platform API".
// Run: node tests/content-posting.test.js

const assert = require("assert");
const {
  decidePostingOutcome,
  describeResult,
  renderResultPage,
  escapeHtml,
} = require("../contentPosting");

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

console.log("\ndecidePostingOutcome");

test("at least one success -> posted, even with other failures", () => {
  const { status, update } = decidePostingOutcome(
    { youtube: { success: true, post_id: "abc" }, tiktok: { success: false, error: "boom" } },
    "approved"
  );
  assert.strictEqual(status, "posted");
  assert.strictEqual(update.status, "posted");
  assert.ok(update.posted_at);
  assert.strictEqual(update.error, undefined);
});

test("all attempted and all failed -> failed, with a combined error string", () => {
  const { status, update } = decidePostingOutcome(
    { youtube: { success: false, error: "quota exceeded" }, tiktok: { success: false, error: "not audited" } },
    "approved"
  );
  assert.strictEqual(status, "failed");
  assert.strictEqual(update.status, "failed");
  assert.ok(update.error.includes("youtube: quota exceeded"));
  assert.ok(update.error.includes("tiktok: not audited"));
});

test("all skipped (no platform configured) -> status stays at prior value, not posted/failed", () => {
  const { status, update } = decidePostingOutcome(
    { youtube: { skipped: true, reason: "not configured" }, tiktok: { skipped: true, reason: "not configured" } },
    "approved"
  );
  assert.strictEqual(status, "approved");
  assert.strictEqual(update.status, undefined, "should not set status key when it hasn't changed");
  assert.strictEqual(update.posted_at, undefined);
  assert.strictEqual(update.error, undefined);
});

test("mix of skipped and success -> posted (skips don't count as failures)", () => {
  const { status, update } = decidePostingOutcome(
    { youtube: { success: true, post_id: "abc" }, tiktok: { skipped: true, reason: "not configured" } },
    "approved"
  );
  assert.strictEqual(status, "posted");
  assert.strictEqual(update.error, undefined);
});

test("mix of skipped and failure (no success) -> failed", () => {
  const { status, update } = decidePostingOutcome(
    { youtube: { success: false, error: "token expired" }, tiktok: { skipped: true, reason: "not configured" } },
    "approved"
  );
  assert.strictEqual(status, "failed");
  assert.ok(update.error.includes("youtube: token expired"));
  assert.ok(!update.error.includes("tiktok"), "skipped platforms should not appear in the error string");
});

console.log("\ndescribeResult");

test("success", () => {
  assert.strictEqual(describeResult("youtube", { success: true }), "Youtube posted ✓");
});

test("skipped includes the reason", () => {
  assert.strictEqual(
    describeResult("tiktok", { skipped: true, reason: "not audited" }),
    "Tiktok skipped — not audited"
  );
});

test("failed includes the error", () => {
  assert.strictEqual(
    describeResult("instagram", { success: false, error: "container failed" }),
    "Instagram failed — container failed"
  );
});

test("failed with no error message falls back to a generic string", () => {
  assert.strictEqual(
    describeResult("facebook", { success: false }),
    "Facebook failed — unknown error"
  );
});

console.log("\nescapeHtml");

test("escapes all five special characters", () => {
  assert.strictEqual(escapeHtml(`<script>&"'</script>`), "&lt;script&gt;&amp;&quot;&#39;&lt;/script&gt;");
});

test("describeResult/renderResultPage escape untrusted reason/error text", () => {
  const line = describeResult("youtube", { success: false, error: `<img src=x onerror=alert(1)>` });
  assert.ok(!line.includes("<img"), "raw HTML from an error message must not leak into the rendered line");
  const page = renderResultPage({ title: "Approved", lines: [line], color: "#15803d" });
  assert.ok(!page.includes("<img src=x"), "raw HTML must not leak into the final page");
});

console.log("\nrenderResultPage");

test("escapes the title too", () => {
  const page = renderResultPage({ title: `<b>hi</b>`, lines: ["ok"], color: "#000" });
  assert.ok(!page.includes("<b>hi</b>"));
  assert.ok(page.includes("&lt;b&gt;hi&lt;/b&gt;"));
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
