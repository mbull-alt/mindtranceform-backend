// Maps session rows to the Storage object paths that hold their generated audio.
// Kept pure and separate from server.js so it is unit-testable — see lib/streaks.js.
function buildSessionAudioPaths(sessionRows) {
  return (sessionRows || []).map((r) => `sessions/${r.id}/voice.mp3`);
}

module.exports = { buildSessionAudioPaths };
