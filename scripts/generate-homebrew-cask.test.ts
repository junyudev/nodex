import { expect, test } from "bun:test";
import { generateHomebrewCask } from "./generate-homebrew-cask";

const sampleSha256 = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const otherSha256 = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

test("generateHomebrewCask renders architecture-specific URLs and checksums", () => {
  const cask = generateHomebrewCask({
    version: "0.2.3",
    arm64Sha256: sampleSha256,
    x64Sha256: otherSha256,
    owner: "Asphocarp",
    repo: "nodex",
    bundleId: "app.jyu.nodex",
    outputPath: null,
  });

  expect(cask.includes('version "0.2.3"')).toBeTrue();
  expect(cask.includes(`sha256 "${sampleSha256}"`)).toBeTrue();
  expect(cask.includes(`sha256 "${otherSha256}"`)).toBeTrue();
  expect(cask.includes('url "https://github.com/Asphocarp/nodex/releases/download/v#{version}/Nodex-#{version}-arm64.dmg"')).toBeTrue();
  expect(cask.includes('url "https://github.com/Asphocarp/nodex/releases/download/v#{version}/Nodex-#{version}-x64.dmg"')).toBeTrue();
  expect(cask.includes("auto_updates true")).toBeTrue();
});

test("generateHomebrewCask derives zap paths from the bundle id", () => {
  const cask = generateHomebrewCask({
    version: "0.2.3",
    arm64Sha256: sampleSha256,
    x64Sha256: otherSha256,
    owner: "Asphocarp",
    repo: "nodex",
    bundleId: "app.jyu.nodex",
    outputPath: null,
  });

  expect(cask.includes('~/Library/Preferences/app.jyu.nodex.plist')).toBeTrue();
  expect(cask.includes('~/Library/Saved Application State/app.jyu.nodex.savedState')).toBeTrue();
  expect(cask.includes("strategy :github_latest")).toBeTrue();
});
