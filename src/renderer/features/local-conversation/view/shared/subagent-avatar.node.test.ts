import { describe, expect, test } from "vite-plus/test";
import {
  resolveSubagentAvatarAsset,
  resolveSubagentAvatarIndex,
  SUBAGENT_AVATAR_ASSETS,
} from "./subagent-avatar";

const EXPECTED_IDENTITY_ORDER = [
  "00-marigold",
  "01-hexloop",
  "02-lozenge",
  "03-lotus",
  "04-aperture",
  "05-hextwist",
  "06-cube",
  "07-clover",
  "08-comb",
  "09-quilt",
  "10-compass",
  "11-blossom",
  "12-tribar",
  "13-tetra",
  "14-bloom",
  "15-duo",
  "16-acorn",
  "17-rosette",
  "18-quadrant",
  "19-whirl",
  "20-gem",
  "21-trinity",
  "22-origami",
  "23-fan",
  "24-diamondloop",
  "25-turbine",
  "26-seed",
  "27-facet",
  "28-twist",
  "29-octagram",
  "30-propeller",
  "31-spiral",
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
