import { CompilerDiagnostic, ErrorCategory } from "babel-plugin-react-compiler";
import { resolve } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { isRendererCompilerSource, projectCompilerEvent } from "./renderer-react-compiler";

describe("renderer compiler source boundary", () => {
  const root = resolve("compiler-test-root");
  const source = (path: string) => resolve(root, path);

  test("accepts first-party renderer modules and query-qualified source", () => {
    expect(isRendererCompilerSource(source("src/renderer/features/chat/view.tsx"), root)).toBe(
      true,
    );
    expect(isRendererCompilerSource(source("src/renderer/lib/use-chat.ts") + "?v=123", root)).toBe(
      true,
    );
  });

  test("excludes other runtimes, dependencies and prefix collisions", () => {
    for (const path of [
      "src/main/view.tsx",
      "src/renderer-other/view.tsx",
      "third_party/blocknote/view.tsx",
      "node_modules/package/view.tsx",
      "src/renderer/styles.css",
    ])
      expect(isRendererCompilerSource(source(path), root)).toBe(false);
  });

  test("keeps test inputs outside the production compiler pipeline", () => {
    for (const path of [
      "src/renderer/test/setup-browser.ts",
      "src/renderer/features/fixtures/view.tsx",
      "src/renderer/features/__tests__/view.tsx",
      "src/renderer/features/view.browser.test.tsx",
      "src/renderer/features/view.spec.tsx",
      "src/renderer/features/view.stories.tsx",
      "src/renderer/features/view.test-fixtures.tsx",
    ])
      expect(isRendererCompilerSource(source(path), root)).toBe(false);
  });
});

test("persists public compiler diagnostics without serializing class internals", () => {
  const detail = CompilerDiagnostic.create({
    category: ErrorCategory.Purity,
    reason: "An input changed during render",
    description: "Move the change to its owner",
  });
  expect(
    JSON.parse(
      JSON.stringify(
        projectCompilerEvent({
          kind: "CompileError",
          fnLoc: null,
          detail,
        }),
      ),
    ),
  ).toEqual({
    kind: "CompileError",
    fnLoc: null,
    reason: "An input changed during render",
    description: "Move the change to its owner",
    category: ErrorCategory.Purity,
    loc: null,
  });
});
