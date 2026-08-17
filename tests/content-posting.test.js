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
  decidePlatformAction,
  describeResult,
  renderResultPage,
  escapeHtml,
  hasRequiredLinks,
  linkSuffix,
  CANONICAL_LINK_LINE,
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

test("REGRESSION: YouTube succeeds immediately (native scheduling) while TikTok is still deferred -> status stays approved, NOT posted", () => {
  // This is the exact bug caught while designing the scheduling sweep: if
  // this finalized to "posted" the moment YouTube succeeded, the sweep's
  // `WHERE status = 'approved'` query would never find this row again, and
  // the deferred TikTok post would never actually go out.
  const { status, update } = decidePostingOutcome(
    { youtube: { success: true, post_id: "abc", publishAt: "2026-08-17T00:00:00.000Z" }, tiktok: { deferred: true, reason: "scheduled for 2026-08-17T00:00:00.000Z, not yet due" } },
    "approved"
  );
  assert.strictEqual(status, "approved");
  assert.strictEqual(update.status, undefined);
  assert.strictEqual(update.posted_at, undefined);
});

test("REGRESSION follow-up: once the deferred platform is later attempted for real, status finalizes normally", () => {
  const { status, update } = decidePostingOutcome(
    { youtube: { success: true, post_id: "abc" }, tiktok: { success: true, post_id: "xyz" } },
    "approved"
  );
  assert.strictEqual(status, "posted");
  assert.ok(update.posted_at);
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

console.log("\nhasRequiredLinks");

test("true when both links present via the canonical line", () => {
  assert.strictEqual(hasRequiredLinks("caption", "#tags", CANONICAL_LINK_LINE), true);
});

test("true when links are split across different fields", () => {
  assert.strictEqual(
    hasRequiredLinks("check out mindtranceformapp.com", "#tags", "play.google.com/store/apps/details?id=com.mindtranceformapp.app.twa"),
    true
  );
});

test("false when both links are missing — this is the exact real bug (2026-08-13/14 first live post)", () => {
  assert.strictEqual(
    hasRequiredLinks(
      "Calm added AI. It still can't write you anything new.",
      "#cantfocus #selfhypnosis #mentalfatigue #hypnosisapp",
      "Try your first session free. If you stay, Premium's $19.99 a month."
    ),
    false
  );
});

test("false when only the web link is present", () => {
  assert.strictEqual(hasRequiredLinks("mindtranceformapp.com", "#tags", "cta"), false);
});

test("false when only the Play link is present", () => {
  assert.strictEqual(hasRequiredLinks("play.google.com/store/apps/details?id=com.mindtranceformapp.app.twa", "#tags", "cta"), false);
});

console.log("\nlinkSuffix");

test("empty suffix when the row's own text already carries both links — avoids double-posting the link", () => {
  const row = { caption: "caption", hashtags: "#tags", cta: `Try it — ${CANONICAL_LINK_LINE}` };
  assert.strictEqual(linkSuffix(row), "");
});

test("appends CANONICAL_LINK_LINE when the row's own text is missing it — still guarantees it ends up in the final post", () => {
  const row = { caption: "caption", hashtags: "#tags", cta: "Try it free" };
  assert.strictEqual(linkSuffix(row), `\n\n${CANONICAL_LINK_LINE}`);
});

console.log("\ndecidePlatformAction");

const NOW = new Date("2026-08-16T12:00:00Z").getTime();
const FUTURE = "2026-08-16T18:00:00Z"; // 6h ahead of NOW
const PAST = "2026-08-16T06:00:00Z";   // 6h behind NOW

test("no scheduled_for -> attempt immediately, any platform", () => {
  assert.deepStrictEqual(decidePlatformAction("tiktok", undefined, null, NOW), { action: "attempt" });
});

test("scheduled_for in the past -> attempt immediately (due)", () => {
  assert.deepStrictEqual(decidePlatformAction("instagram", undefined, PAST, NOW), { action: "attempt" });
});

test("scheduled_for in the future, non-native platform -> defer (deferred, NOT skipped)", () => {
  const result = decidePlatformAction("tiktok", undefined, FUTURE, NOW);
  assert.strictEqual(result.action, "defer");
  assert.strictEqual(result.result.deferred, true);
  assert.strictEqual(result.result.skipped, undefined, "must not be marked skipped — decidePostingOutcome treats those differently");
  assert.ok(result.result.reason.includes(new Date(FUTURE).toISOString()));
});

test("scheduled_for in the future, YouTube (native scheduling) -> attempt immediately regardless", () => {
  assert.deepStrictEqual(decidePlatformAction("youtube", undefined, FUTURE, NOW), { action: "attempt" });
});

test("already succeeded -> skip, never re-attempt", () => {
  assert.deepStrictEqual(
    decidePlatformAction("youtube", { success: true, post_id: "abc" }, FUTURE, NOW),
    { action: "skip" }
  );
});

test("previously deferred (not yet success) -> re-evaluated, not treated as done", () => {
  const priorDeferred = { deferred: true, reason: "scheduled for later" };
  // Still future -> defer again
  assert.strictEqual(decidePlatformAction("tiktok", priorDeferred, FUTURE, NOW).action, "defer");
  // Now past -> attempt for real (this is what the sweep re-run relies on)
  assert.strictEqual(decidePlatformAction("tiktok", priorDeferred, PAST, NOW).action, "attempt");
});

test("unknown platform -> unknown action with an error result, not a crash", () => {
  const result = decidePlatformAction("myspace", undefined, null, NOW);
  assert.strictEqual(result.action, "unknown");
  assert.strictEqual(result.result.success, false);
  assert.ok(result.result.error.includes("myspace"));
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
