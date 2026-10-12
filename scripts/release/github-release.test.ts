import { expect, test } from "vite-plus/test";
import { planPublication, planTag } from "./github-release";

const expected = new Map([
  ["Nodex-latest-arm64.dmg", { bytes: 10, sha256: "a".repeat(64) }],
  ["release-bundle.json", { bytes: 20, sha256: "b".repeat(64) }],
]);

test("planPublication creates when no release exists", () => {
  expect(planPublication(null, expected, false)).toEqual({ kind: "create" });
});

test("planPublication resumes only missing draft assets", () => {
  expect(
    planPublication(
      {
        assets: [{ digest: `sha256:${"a".repeat(64)}`, name: "Nodex-latest-arm64.dmg", size: 10 }],
        draft: true,
        prerelease: false,
        tag_name: "v0.2.0",
      },
      expected,
      false,
    ),
  ).toEqual({ kind: "resume-draft", missingAssetNames: ["release-bundle.json"] });
});

test("planPublication rejects mismatched assets instead of clobbering", () => {
  expect(() =>
    planPublication(
      {
        assets: [{ digest: `sha256:${"c".repeat(64)}`, name: "Nodex-latest-arm64.dmg", size: 10 }],
        draft: true,
        prerelease: false,
        tag_name: "v0.2.0",
      },
      expected,
      false,
    ),
  ).toThrow("does not match");
});

test("release tag planning never moves an existing tag", () => {
  const sourceSha = "a".repeat(40);
  expect(planTag(null, sourceSha)).toBe("create");
  expect(planTag(sourceSha, sourceSha)).toBe("reuse");
  expect(() => planTag("b".repeat(40), sourceSha)).toThrow("never move");
});
