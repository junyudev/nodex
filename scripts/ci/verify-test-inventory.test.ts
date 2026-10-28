import { describe, expect, test } from "vite-plus/test";
import { ownedTestCandidates, verifyTestInventory } from "./verify-test-inventory";

const file = "src/main/new-application/behavior.node.test.ts";

describe("actual test inventory", () => {
  test("independently finds new packages and suffixes without suite globs", () => {
    expect(
      ownedTestCandidates([
        file,
        "packages/new-package/behavior.spec.ts",
        "src/a.ts",
        "scripts/fixtures/tooling/invalid.test.ts",
        "packages/agent-runtime/vendor/contracts/src/background.test.ts",
      ]),
    ).toEqual([
      file,
      "packages/new-package/behavior.spec.ts",
      "packages/agent-runtime/vendor/contracts/src/background.test.ts",
    ]);
  });
  test("accepts one discovered owner", () => {
    expect(() =>
      verifyTestInventory([file], [{ suite: "core-client", tier: "default", files: [file] }]),
    ).not.toThrow();
  });
  test("rejects duplication across runtimes", () => {
    expect(() =>
      verifyTestInventory(
        [file],
        [
          { suite: "core-client", tier: "default", files: [file] },
          { suite: "main", tier: "default", files: [file] },
        ],
      ),
    ).toThrow("discovered");
  });
  test("rejects ignored owned tests and newly unowned packages", () => {
    expect(() => verifyTestInventory([file], [])).toThrow("discovered []");
    expect(() => verifyTestInventory(["packages/new-package/behavior.test.ts"], [])).toThrow(
      "0 declared owners",
    );
  });
  test("rejects discovery in the wrong tier", () => {
    expect(() =>
      verifyTestInventory([file], [{ suite: "core-client", tier: "stress", files: [file] }]),
    ).toThrow("discovered");
  });
  test("requires vendor collection and keeps live contracts outside the default tier", () => {
    const vendor = "packages/agent-runtime/vendor/contracts/src/background.test.ts";
    const live =
      "packages/agent-runtime/vendor/provider-opencode/src/server/v2/OpenCode2Server.live.test.ts";
    expect(() => verifyTestInventory([vendor], [])).toThrow("discovered []");
    expect(() =>
      verifyTestInventory([live], [{ suite: "agent-runtime", tier: "live", files: [live] }]),
    ).not.toThrow();
    expect(() =>
      verifyTestInventory([live], [{ suite: "agent-runtime", tier: "default", files: [live] }]),
    ).toThrow("expected agent-runtime:live");
  });
});
