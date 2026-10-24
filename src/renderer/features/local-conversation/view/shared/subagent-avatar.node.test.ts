import { describe, expect, test } from "vite-plus/test";
import {
  resolveSubagentAvatarAsset,
  resolveSubagentAvatarIndex,
  SUBAGENT_AVATAR_ASSETS,
} from "./subagent-avatar";

const EXPECTED_IDENTITY_ORDER = [
  "00-honeycomb",
  "01-twin",
  "02-swirl",
  "03-lotus",
  "04-clover",
  "05-arch",
  "06-halo",
  "07-triad",
  "08-whirl",
  "09-flame",
  "10-scallop",
  "11-moth",
  "12-spark",
  "13-octagram",
  "14-hexa",
  "15-drop",
  "16-sprout",
  "17-trillium",
  "18-quincunx",
  "19-atom",
  "20-gem",
  "21-saturn",
  "22-compass",
  "23-succulent",
  "24-sun",
  "25-ammonite",
  "26-seal",
  "27-blossom",
  "28-cradle",
  "29-trinity",
  "30-rosette",
  "31-duo",
] as const;

// Resolve files independently of the production bank, including Vite-inlined SVG URLs.
const assetUrlsByPath = import.meta.glob<string>("/src/renderer/assets/subagent-avatars/*.svg", {
  eager: true,
  import: "default",
});

describe("subagent avatar identity", () => {
  test("makes all 32 ordered identities reachable with distinct theme variants", () => {
    expect(SUBAGENT_AVATAR_ASSETS).toHaveLength(32);
    const assetUrls = SUBAGENT_AVATAR_ASSETS.flatMap(({ dark, light }) => [dark, light]);
    expect(new Set(assetUrls).size).toBe(64);

    // Single code units cover slots 0–31 without searching through the implementation.
    const seeds = Array.from({ length: 32 }, (_, index) => String.fromCharCode(32 + index));
    expect(seeds.map(resolveSubagentAvatarIndex)).toEqual(
      Array.from({ length: 32 }, (_, index) => index),
    );
    expect(seeds.map(resolveSubagentAvatarAsset)).toEqual(
      EXPECTED_IDENTITY_ORDER.map((identity) => ({
        light: assetUrlsByPath[`/src/renderer/assets/subagent-avatars/${identity}-light.svg`],
        dark: assetUrlsByPath[`/src/renderer/assets/subagent-avatars/${identity}-dark.svg`],
      })),
    );
  });

  test.each([
    { label: "empty", seed: "", expected: 0 },
    { label: "persisted thread ID", seed: "019f3c6a-2ebc-7b82-ab83-cb7edb449ada", expected: 1 },
    { label: "Chinese", seed: "代理", expected: 3 },
    { label: "surrogate pair", seed: "😀", expected: 3 },
    { label: "mixed ASCII and surrogate pair", seed: "agent-🤖", expected: 6 },
    { label: "unpaired high surrogate", seed: "\uD800", expected: 0 },
    { label: "unpaired low surrogate", seed: "\uDC00", expected: 0 },
    { label: "repeated modulus wrapping", seed: "x".repeat(4_096), expected: 28 },
  ])("maps $label to slot $expected", ({ seed, expected }) => {
    expect(resolveSubagentAvatarIndex(seed)).toBe(expected);
  });

  test("accepts collisions without depending on other threads or render order", () => {
    expect(["a", "A", "a"].map(resolveSubagentAvatarIndex)).toEqual([1, 1, 1]);
    expect(["A", "a", "A"].map(resolveSubagentAvatarIndex)).toEqual([1, 1, 1]);
    expect(resolveSubagentAvatarAsset("a")).toBe(resolveSubagentAvatarAsset("A"));
  });
});
