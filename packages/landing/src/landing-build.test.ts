import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vite-plus/test";

test("the static build emits the public Nodex routes and release links", () => {
  const landingRoot = resolve(import.meta.dirname, "..");

  const builtIndexHtml = readFileSync(resolve(landingRoot, "dist/index.html"), "utf8");
  const builtDownloadHtml = readFileSync(resolve(landingRoot, "dist/download/index.html"), "utf8");
  const builtChangelogHtml = readFileSync(
    resolve(landingRoot, "dist/changelog/index.html"),
    "utf8",
  );
  const builtPrivacyHtml = readFileSync(resolve(landingRoot, "dist/privacy/index.html"), "utf8");
  const builtTermsHtml = readFileSync(resolve(landingRoot, "dist/terms/index.html"), "utf8");

  expect(builtIndexHtml).toContain('content="You and your agents, on the same page."');
  expect(builtIndexHtml).toContain("/media/hero-video/video.webm");
  expect(builtIndexHtml).toContain("/media/workspaces/video.webm");
  expect(builtIndexHtml).toContain("/media/compact-mode/video.webm");
  expect(builtIndexHtml).toContain("/media/glance/video.webm");
  expect(builtIndexHtml).toContain("/media/split-views/video.webm");
  expect(builtIndexHtml).toContain('href="https://nodex.jyu.app/"');
  expect(builtDownloadHtml).toContain("Nodex-latest-arm64.dmg");
  expect(builtDownloadHtml).toContain("Nodex-latest-x64.dmg");
  expect(builtChangelogHtml).toContain('id="unreleased"');
  expect(builtChangelogHtml).toContain("<h2>Unreleased</h2>");
  expect(builtPrivacyHtml).toContain("<h1");
  expect(builtTermsHtml).toContain("<h1");
  expect(builtIndexHtml).not.toContain("Zen Browser");
});
