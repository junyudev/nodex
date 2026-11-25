import { describe, expect, test } from "vite-plus/test";

import { classifyChangedPaths } from "./classify-change";
import { githubOutputForClassification, parseClassificationDocument } from "./write-github-outputs";

describe("GitHub classification outputs", () => {
  test("writes compact changed-path and typed-plan outputs", () => {
    const document = parseClassificationDocument({
      changedPaths: ["src/renderer/app.tsx"],
      plan: classifyChangedPaths(["src/renderer/app.tsx"]),
    });
    const output = githubOutputForClassification(document);
    expect(output.split("\n")).toHaveLength(4);
    const lines = output.trim().split("\n");
    expect(JSON.parse(lines[0]!.slice("changed_paths=".length))).toEqual(["src/renderer/app.tsx"]);
    expect(JSON.parse(lines[1]!.slice("plan=".length))).toMatchObject({
      rustFast: false,
      testMode: "related",
    });
    expect(JSON.parse(lines[2]!.slice("app_lanes=".length))).toEqual([
      "browser-1",
      "browser-2",
      "browser-3",
      "renderer-1+unit-2",
      "renderer-2+unit-1",
    ]);
  });

  test("publishes an empty application matrix for an unlabelled draft", () => {
    const changedPaths = ["src/main/platform/host-capabilities.ts"];
    const plan = classifyChangedPaths(changedPaths, { draft: true });
    expect(githubOutputForClassification({ changedPaths, plan })).toContain("\napp_lanes=[]\n");
  });

  test("rejects unknown document and plan fields", () => {
    const plan = classifyChangedPaths(["src/renderer/app.tsx"]);
    expect(() => parseClassificationDocument({ changedPaths: [], plan, surprise: true })).toThrow(
      "unknown fields",
    );
    expect(() =>
      parseClassificationDocument({ changedPaths: [], plan: { ...plan, surprise: true } }),
    ).toThrow("unknown fields");
  });

  test("rejects non-string paths before they can reach a summary", () => {
    expect(() =>
      parseClassificationDocument({
        changedPaths: ["safe", 42],
        plan: classifyChangedPaths(["README.md"]),
      }),
    ).toThrow("string array");
  });

  test("rejects newline-bearing paths independently", () => {
    expect(() =>
      parseClassificationDocument({
        changedPaths: ["unsafe\npath"],
        plan: classifyChangedPaths(["README.md"]),
      }),
    ).toThrow("must not contain line breaks");
  });
});
