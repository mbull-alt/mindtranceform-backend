const { buildSessionAudioPaths } = require("../lib/accountDeletion");

describe("buildSessionAudioPaths", () => {
  test("empty array → empty array", () => {
    expect(buildSessionAudioPaths([])).toEqual([]);
  });

  test("null → empty array", () => {
    expect(buildSessionAudioPaths(null)).toEqual([]);
  });

  test("undefined → empty array", () => {
    expect(buildSessionAudioPaths(undefined)).toEqual([]);
  });

  test("one row → one path", () => {
    expect(buildSessionAudioPaths([{ id: "abc-123" }])).toEqual(["sessions/abc-123/voice.mp3"]);
  });

  test("several rows → one path per row, in order", () => {
    const rows = [{ id: "a" }, { id: "b" }, { id: "c" }];
    expect(buildSessionAudioPaths(rows)).toEqual([
      "sessions/a/voice.mp3",
      "sessions/b/voice.mp3",
      "sessions/c/voice.mp3",
    ]);
  });

  test("path shape matches the upload path built in server.js (sessions/<id>/voice.mp3)", () => {
    const id = "11111111-2222-3333-4444-555555555555";
    const [path] = buildSessionAudioPaths([{ id }]);
    expect(path).toBe(`sessions/${id}/voice.mp3`);
  });
});
