import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vite-plus/test";

import {
  analyzeMainIpcSource,
  analyzeRendererSource,
  collectIpcApiEndpoints,
  rendererCommandBoundaryDiagnostics,
  type RendererCommandOccurrence,
} from "./renderer-command-boundaries";

const fixtureRoot = resolve(import.meta.dirname, "../fixtures/renderer-command-boundaries");

const fixture = (name: string): string => readFileSync(resolve(fixtureRoot, name), "utf8");

const diagnosticCodes = (occurrences: readonly RendererCommandOccurrence[]) =>
  rendererCommandBoundaryDiagnostics({ occurrences }).map((diagnostic) => diagnostic.code);

describe("renderer command boundary inventory", () => {
  test("detects raw invoke imports and calls in leaf UI", () => {
    const occurrences = analyzeRendererSource({
      path: "src/renderer/features/example/view/raw-leaf.tsx",
      sourceText: fixture("raw-leaf.tsx"),
    });

    expect(diagnosticCodes(occurrences)).toEqual([
      "renderer-leaf-raw-invoke-import",
      "renderer-leaf-raw-invoke-call",
    ]);
    expect(occurrences.map(({ detail }) => detail)).toEqual(["rawInvoke", "projects:update"]);
  });

  test("detects the retired raw renderer transport resolver", () => {
    const occurrences = analyzeRendererSource({
      path: "src/renderer/lib/raw-renderer-transport.ts",
      sourceText: fixture("raw-renderer-transport.ts"),
    });

    expect(diagnosticCodes(occurrences)).toEqual([
      "renderer-raw-transport-import",
      "renderer-raw-transport-call",
    ]);
  });

  test("detects non-null and optional direct preload invocation", () => {
    const occurrences = analyzeRendererSource({
      path: "src/renderer/lib/direct-preload.ts",
      sourceText: fixture("direct-preload.ts"),
    });

    expect(diagnosticCodes(occurrences)).toEqual([
      "renderer-direct-preload-invoke",
      "renderer-direct-preload-invoke",
    ]);
    expect(occurrences.map(({ detail }) => detail)).toEqual(["terminal-write", "terminal-write"]);
  });

  test("inventories LocalCommit admissions without treating them as ratchet debt", () => {
    const occurrences = analyzeRendererSource({
      path: "src/renderer/lib/local-commit-fixture.ts",
      sourceText: fixture("local-commit-admission.ts"),
    });

    expect(occurrences.map(({ code, detail }) => ({ code, detail }))).toEqual([
      { code: "renderer-local-commit-admission", detail: "admitLocalCommitApply" },
      { code: "renderer-local-commit-admission", detail: "admitPacket" },
    ]);
    expect(diagnosticCodes(occurrences)).toEqual([]);
  });

  test("rejects typed renderer command transport imports from leaf UI", () => {
    const path = "src/renderer/features/example/view/leaf-typed-command.tsx";
    const occurrences = analyzeRendererSource({
      path,
      sourceText: fixture("leaf-typed-command.tsx"),
    });
    const diagnostics = rendererCommandBoundaryDiagnostics({ occurrences });

    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: "renderer-leaf-typed-transport-import",
        detail: "invokeLocalCommitCommand",
        line: 1,
        path,
      }),
    ]);
  });

  test("identifies presentation outside path-shaped view folders", () => {
    const path = "src/renderer/features/example/panel.tsx";
    const occurrences = analyzeRendererSource({
      path,
      sourceText: fixture("leaf-typed-command.tsx"),
    });

    expect(rendererCommandBoundaryDiagnostics({ occurrences })).toEqual([
      expect.objectContaining({
        code: "renderer-leaf-typed-transport-import",
        detail: "invokeLocalCommitCommand",
        path,
      }),
    ]);
  });

  test("rejects traced command transport from presentation", () => {
    const path = "src/renderer/features/example/traced-panel.tsx";
    const occurrences = analyzeRendererSource({
      path,
      sourceText: fixture("leaf-traced-command.tsx"),
    });

    expect(rendererCommandBoundaryDiagnostics({ occurrences })).toEqual([
      expect.objectContaining({
        code: "renderer-leaf-typed-transport-import",
        detail: "invokePlainCommandWithTrace",
        path,
      }),
    ]);
  });

  test("rejects dynamically importing command capabilities from presentation", () => {
    const path = "src/renderer/features/example/dynamic-panel.tsx";
    const occurrences = analyzeRendererSource({
      path,
      sourceText: fixture("renderer-command-dynamic-import.tsx"),
    });

    expect(rendererCommandBoundaryDiagnostics({ occurrences })).toEqual([
      expect.objectContaining({
        code: "renderer-leaf-typed-transport-import",
        detail: "import()",
        path,
      }),
    ]);
  });

  test("does not mistake a non-visual React owner hook for leaf presentation", () => {
    const path = "src/renderer/lib/use-escaped-command.ts";
    const occurrences = analyzeRendererSource({
      path,
      sourceText: fixture("react-hook-command.ts"),
    });

    expect(rendererCommandBoundaryDiagnostics({ occurrences })).toEqual([]);
  });

  test("allows presentation to depend on a semantic owner Interface", () => {
    const occurrences = analyzeRendererSource({
      path: "src/renderer/features/example/panel.tsx",
      sourceText: fixture("presentation-semantic-owner.tsx"),
    });

    expect(rendererCommandBoundaryDiagnostics({ occurrences })).toEqual([]);
  });

  test("rejects re-exporting renderer command capabilities through a facade", () => {
    const path = "src/renderer/lib/escaped-command.ts";
    const occurrences = analyzeRendererSource({
      path,
      sourceText: fixture("renderer-command-reexport.ts"),
    });

    expect(rendererCommandBoundaryDiagnostics({ occurrences })).toEqual([
      expect.objectContaining({
        code: "renderer-command-capability-reexport",
        path,
      }),
    ]);
  });

  test("rejects re-exporting an imported renderer command capability", () => {
    const path = "src/renderer/lib/indirect-escaped-command.ts";
    const occurrences = analyzeRendererSource({
      path,
      sourceText: fixture("renderer-command-indirect-reexport.ts"),
    });

    expect(rendererCommandBoundaryDiagnostics({ occurrences })).toEqual([
      expect.objectContaining({
        code: "renderer-command-capability-reexport",
        detail: "<imported-capability>",
        path,
      }),
    ]);
  });

  test("requires typed command calls to use a registered-definition identifier", () => {
    const path = "src/renderer/lib/typed-command-literal.ts";
    const occurrences = analyzeRendererSource({
      path,
      sourceText: fixture("typed-command-literal.ts"),
    });
    const diagnostics = rendererCommandBoundaryDiagnostics({ occurrences });

    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: "renderer-command-call-requires-definition",
        detail: "invokePlainCommand",
        line: 6,
        path,
      }),
      expect.objectContaining({
        code: "renderer-command-call-requires-definition",
        detail: "invokePlainCommand",
        line: 10,
        path,
      }),
      expect.objectContaining({
        code: "renderer-command-call-requires-definition",
        detail: "invokePlainCommand",
        line: 22,
        path,
      }),
    ]);
  });

  test("accepts an owner-registered definition with typed command transport", () => {
    const occurrences = analyzeRendererSource({
      path: "src/renderer/lib/typed-command-owner.ts",
      sourceText: fixture("typed-command-owner.ts"),
    });

    expect(rendererCommandBoundaryDiagnostics({ occurrences })).toEqual([]);
  });

  test("leaves query and control channel matching to TypeScript", () => {
    const occurrences = analyzeRendererSource({
      path: "src/renderer/lib/typed-query-control.ts",
      sourceText: fixture("typed-query-control.ts"),
    });

    expect(rendererCommandBoundaryDiagnostics({ occurrences })).toEqual([]);
  });

  test("discovers forwarded Main ipc.handle wrappers and their literal registration", () => {
    const occurrences = analyzeMainIpcSource({
      path: "src/main/ipc/handlers/FixtureIpc.ts",
      sourceText: fixture("main-wrapper.ts"),
    });

    expect(occurrences.map(({ code, detail }) => ({ code, detail }))).toEqual([
      { code: "main-ipc-handle-wrapper", detail: "channel" },
      { code: "main-ipc-handle-registration", detail: "projects:update" },
    ]);
    expect(diagnosticCodes(occurrences)).toEqual([
      "main-ipc-handle-wrapper",
      "main-ipc-handle-registration",
    ]);
  });

  test("extracts IpcApi endpoint literals deterministically", () => {
    expect(
      collectIpcApiEndpoints({
        path: "src/shared/ipc-api.ts",
        sourceText: fixture("ipc-api.ts"),
      }),
    ).toEqual(["projects:list", "projects:update"]);
  });

  test("reports every raw occurrence without a baseline allowance", () => {
    const occurrences = analyzeRendererSource({
      path: "src/renderer/lib/direct-preload.ts",
      sourceText: fixture("direct-preload.ts"),
    });
    const diagnostics = rendererCommandBoundaryDiagnostics({ occurrences });

    expect(diagnostics).toHaveLength(2);
    expect(diagnostics[0]).toMatchObject({
      code: "renderer-direct-preload-invoke",
      detail: "terminal-write",
      line: 2,
    });
    expect(diagnostics[1]).toMatchObject({
      code: "renderer-direct-preload-invoke",
      detail: "terminal-write",
      line: 3,
    });
  });
});
