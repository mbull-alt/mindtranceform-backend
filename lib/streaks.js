// Pure streak/heatmap calculation — no I/O, fully unit-testable.
// All date math normalises to calendar days in the user's IANA timezone.

// Returns a 'YYYY-MM-DD' string for a timestamp in the given IANA timezone.
function toLocalDateStr(date, tz) {
  return new Date(date).toLocaleDateString("en-CA", { timeZone: tz });
}

// Difference in calendar days between two 'YYYY-MM-DD' strings (a – b).
function dayDiff(dateStrA, dateStrB) {
  return Math.round(
    (Date.parse(dateStrA + "T12:00:00Z") - Date.parse(dateStrB + "T12:00:00Z")) /
      86400000
  );
}

/**
 * Computes streak metrics from an array of session timestamps.
 *
 * Current streak: consecutive calendar days ending today or yesterday.
 * Longest streak: historical max over all recorded days.
 *
 * Two sessions on the same calendar day are counted as one day (no double-count).
 * The timezone boundary test: a session at 11:58 pm and one at 12:05 am the
 * following local day are treated as two separate days — the right answer.
 *
 * @param {string[]|Date[]} sessionTimestamps – created_at values from sessions table
 * @param {string} tz – IANA timezone, e.g. 'America/Chicago'. Defaults to 'UTC'.
 * @returns {{ currentStreak: number, longestStreak: number }}
 */
function computeStreaks(sessionTimestamps, tz = "UTC") {
  if (!sessionTimestamps || sessionTimestamps.length === 0) {
    return { currentStreak: 0, longestStreak: 0 };
  }

  // Deduplicate to unique calendar days, sorted most-recent first
  const daySet = new Set(sessionTimestamps.map((ts) => toLocalDateStr(ts, tz)));
  const days = Array.from(daySet).sort().reverse();

  const todayStr = toLocalDateStr(new Date(), tz);
  const yesterdayStr = toLocalDateStr(new Date(Date.now() - 86400000), tz);

  // Current streak: only active when the most-recent day is today or yesterday
  let currentStreak = 0;
  if (days[0] === todayStr || days[0] === yesterdayStr) {
    currentStreak = 1;
    for (let i = 1; i < days.length; i++) {
      if (dayDiff(days[i - 1], days[i]) === 1) {
        currentStreak++;
      } else {
        break;
      }
    }
  }

  // Longest streak: sweep all days regardless of recency
  let longestStreak = currentStreak;
  let run = 1;
  for (let i = 1; i < days.length; i++) {
    if (dayDiff(days[i - 1], days[i]) === 1) {
      run++;
      if (run > longestStreak) longestStreak = run;
    } else {
      run = 1;
    }
  }

  return { currentStreak, longestStreak };
}

/**
 * Builds a heatmap array for the last `numDays` calendar days.
 * Useful for CSS-grid heatmap rendering on the frontend.
 *
 * @param {string[]|Date[]} sessionTimestamps
 * @param {string} tz – IANA timezone
 * @param {number} numDays – window size (default 90)
 * @returns {{ date: string, hasSession: boolean }[]} – ordered oldest → newest
 */
function buildHeatmap(sessionTimestamps, tz = "UTC", numDays = 90) {
  const daySet = new Set(
    (sessionTimestamps || []).map((ts) => toLocalDateStr(ts, tz))
  );
  const result = [];
  const now = Date.now();
  for (let i = numDays - 1; i >= 0; i--) {
    const dateStr = toLocalDateStr(new Date(now - i * 86400000), tz);
    result.push({ date: dateStr, hasSession: daySet.has(dateStr) });
  }
  return result;
}

/**
 * Returns true if a 14-day re-offer for self-assessment should be shown.
 * Returns false when lastTakenAt is null (never taken — handled separately by
 * /assessments/status which returns shouldOffer: true for first-timers).
 *
 * @param {string|Date|null} lastTakenAt
 * @returns {boolean}
 */
function shouldOfferReassessment(lastTakenAt) {
  if (!lastTakenAt) return false;
  return Date.now() - new Date(lastTakenAt).getTime() >= 14 * 24 * 60 * 60 * 1000;
}

module.exports = { toLocalDateStr, dayDiff, computeStreaks, buildHeatmap, shouldOfferReassessment };
