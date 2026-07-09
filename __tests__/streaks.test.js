const { computeStreaks, buildHeatmap, shouldOfferReassessment } = require("../lib/streaks");

// Helper: ISO timestamp for N days ago at a given hour (UTC)
function daysAgo(n, hour = 12) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
}

describe("computeStreaks", () => {
  const tz = "UTC";

  test("null / empty sessions → streak 0", () => {
    expect(computeStreaks(null, tz)).toEqual({ currentStreak: 0, longestStreak: 0 });
    expect(computeStreaks([], tz)).toEqual({ currentStreak: 0, longestStreak: 0 });
  });

  test("3 consecutive days → currentStreak 3, longestStreak 3", () => {
    const ts = [daysAgo(0), daysAgo(1), daysAgo(2)];
    expect(computeStreaks(ts, tz)).toEqual({ currentStreak: 3, longestStreak: 3 });
  });

  test("gap day resets current streak, preserves longest", () => {
    // days 0, 1 then gap then 3, 4, 5
    const ts = [daysAgo(0), daysAgo(1), daysAgo(3), daysAgo(4), daysAgo(5)];
    const { currentStreak, longestStreak } = computeStreaks(ts, tz);
    expect(currentStreak).toBe(2);
    expect(longestStreak).toBe(3);
  });

  test("most recent session yesterday (no session today) → streak still active", () => {
    const ts = [daysAgo(1), daysAgo(2), daysAgo(3)];
    expect(computeStreaks(ts, tz).currentStreak).toBe(3);
  });

  test("most recent session 2 days ago → streak broken (= 0)", () => {
    const ts = [daysAgo(2), daysAgo(3)];
    expect(computeStreaks(ts, tz).currentStreak).toBe(0);
  });

  test("two sessions on same UTC day count as 1 (no double-count)", () => {
    const ts = [daysAgo(0, 10), daysAgo(0, 15)]; // 10 am and 3 pm same day
    expect(computeStreaks(ts, tz).currentStreak).toBe(1);
  });

  test("timezone midnight boundary: 11:58 pm + 12:05 am next local day = 2-day streak", () => {
    // America/New_York is UTC-4 in summer (EDT).
    // We build a UTC "wall" that is today local-midnight in New_York, then place
    // one session 2 minutes before it (yesterday 11:58 pm) and one 5 minutes after
    // (today 12:05 am). Both sessions are in separate local calendar days.
    const todayMidnightNY = new Date(
      new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" }) + "T00:00:00-04:00"
    );
    const yesterdayNight = new Date(todayMidnightNY.getTime() - 2 * 60 * 1000).toISOString(); // 11:58 pm local yesterday
    const todayMorning   = new Date(todayMidnightNY.getTime() + 5 * 60 * 1000).toISOString(); // 12:05 am local today
    expect(computeStreaks([yesterdayNight, todayMorning], "America/New_York").currentStreak).toBe(2);
  });

  test("11:58 pm and 12:05 am same local day (UTC) = 1 day, no double-count", () => {
    // Two sessions on the same UTC calendar day: just past midnight and just before midnight.
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "UTC" }); // YYYY-MM-DD
    const earlyMorning = today + "T00:05:00Z";
    const lateNight    = today + "T23:58:00Z";
    expect(computeStreaks([earlyMorning, lateNight], "UTC").currentStreak).toBe(1);
  });

  test("single session today → currentStreak 1", () => {
    expect(computeStreaks([daysAgo(0)], tz).currentStreak).toBe(1);
  });
});

describe("buildHeatmap", () => {
  test("returns exactly numDays entries", () => {
    expect(buildHeatmap([], "UTC", 90)).toHaveLength(90);
    expect(buildHeatmap([], "UTC", 30)).toHaveLength(30);
  });

  test("no sessions → all hasSession false", () => {
    const heatmap = buildHeatmap([], "UTC", 90);
    expect(heatmap.every((d) => d.hasSession === false)).toBe(true);
  });

  test("session today → last entry hasSession true", () => {
    const heatmap = buildHeatmap([daysAgo(0)], "UTC", 90);
    expect(heatmap[heatmap.length - 1].hasSession).toBe(true);
  });

  test("session 89 days ago → first entry hasSession true", () => {
    const heatmap = buildHeatmap([daysAgo(89)], "UTC", 90);
    expect(heatmap[0].hasSession).toBe(true);
  });

  test("session 91 days ago → not visible in 90-day window", () => {
    const heatmap = buildHeatmap([daysAgo(91)], "UTC", 90);
    expect(heatmap.every((d) => d.hasSession === false)).toBe(true);
  });
});

describe("shouldOfferReassessment", () => {
  function daysAgoISO(n) {
    return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
  }

  test("null → false (never taken; handled separately as first-time offer)", () => {
    expect(shouldOfferReassessment(null)).toBe(false);
  });

  test("taken 3 days ago → false (< 14 days)", () => {
    expect(shouldOfferReassessment(daysAgoISO(3))).toBe(false);
  });

  test("taken exactly 14 days ago (minus 1 ms) → true", () => {
    const justOver14 = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000 - 1).toISOString();
    expect(shouldOfferReassessment(justOver14)).toBe(true);
  });

  test("taken 15 days ago → true", () => {
    expect(shouldOfferReassessment(daysAgoISO(15))).toBe(true);
  });

  test("taken 13 days ago → false", () => {
    expect(shouldOfferReassessment(daysAgoISO(13))).toBe(false);
  });
});
