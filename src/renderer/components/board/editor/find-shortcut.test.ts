import { expect, test } from "vite-plus/test";
import { matchesNfmFindShortcut } from "./find-shortcut";

test.each(["macOS", "windows", "linux"] as const)(
  "local Find yields full-view and other modified F chords on %s",
  (platform) => {
    const event = {
      key: "f",
      code: "KeyF",
      metaKey: platform === "macOS",
      ctrlKey: platform !== "macOS",
      altKey: false,
      shiftKey: false,
    };
    expect(matchesNfmFindShortcut(event, platform)).toBe(true);
    expect(matchesNfmFindShortcut({ ...event, key: "F", shiftKey: true }, platform)).toBe(false);
    expect(matchesNfmFindShortcut({ ...event, altKey: true }, platform)).toBe(false);
    expect(matchesNfmFindShortcut({ ...event, key: "g", code: "KeyG" }, platform)).toBe(false);
  },
);
