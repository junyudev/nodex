import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vite-plus/test";

import { landingMediaBudget, landingMediaNames, landingMediaStatus } from "./constants/media";

const publicRoot = resolve(import.meta.dirname, "../public");

if (landingMediaStatus === "ready") {
  describe("reviewed landing media", () => {
    test.each(landingMediaNames)("%s has a poster and both video formats", (name) => {
      const mediaRoot = resolve(publicRoot, "media", name);
      const posterPath = resolve(mediaRoot, "poster.webp");
      const webmPath = resolve(mediaRoot, "video.webm");
      const mp4Path = resolve(mediaRoot, "video.mp4");

      expect(existsSync(posterPath)).toBe(true);
      expect(existsSync(webmPath)).toBe(true);
      expect(existsSync(mp4Path)).toBe(true);
      expect(statSync(posterPath).size).toBeLessThanOrEqual(landingMediaBudget.posterBytes);
      expect(statSync(webmPath).size).toBeLessThanOrEqual(landingMediaBudget.videoBytes);
      expect(statSync(mp4Path).size).toBeLessThanOrEqual(landingMediaBudget.videoBytes);
    });
  });
} else {
  test("unreviewed landing media remains deployment-gated", () => {
    expect(landingMediaStatus).toBe("pending");
  });
}
