import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { analyzeEffectBoundaries, type EffectBoundaryDiagnosticCode } from "./effect-boundaries";

const fixtureRoot = resolve(import.meta.dirname, "../fixtures/effect-boundaries");

function fixture(name: string): string {
  return readFileSync(resolve(fixtureRoot, name), "utf8");
}

function codes(path: string, name: string): EffectBoundaryDiagnosticCode[] {
  return analyzeEffectBoundaries({ path, sourceText: fixture(name) }).map(
    (diagnostic) => diagnostic.code,
  );
}

describe("Effect architecture boundaries", () => {
  test("keeps renderer and wire-contract code Effect-free", () => {
    expect(codes("src/shared/wire-contract.ts", "effect-import.ts")).toEqual([
      "effect-free-import",
    ]);
    expect(codes("src/renderer/runtime.ts", "effect-import.ts")).toEqual(["effect-free-import"]);
    expect(
      codes("packages/codex-app-server-protocol/src/v2/thread.ts", "effect-import.ts"),
    ).toEqual(["effect-free-import"]);
  });

  test("localizes unstable APIs and Effect execution", () => {
    expect(codes("src/main/codex-runtime/session.ts", "unstable-import.ts")).toEqual([
      "unstable-outside-adapter",
    ]);
    expect(codes("src/main/core-client/supervisor.ts", "run-promise.ts")).toEqual([
      "run-outside-boundary",
    ]);
    expect(codes("src/main/core-client/supervisor.ts", "run-promise-effect-subpath.ts")).toEqual([
      "run-outside-boundary",
    ]);
    expect(codes("src/main/host-runtime/DetachedRuntime.ts", "node-runtime.ts")).toEqual([
      "node-runtime-outside-entry",
    ]);
  });

  test("rejects ambient configuration and unstructured async in application Modules", () => {
    expect(
      codes("src/main/host-runtime/DetachedRuntime.ts", "application-ambient-process.ts"),
    ).toEqual(["application-ambient-process", "application-ambient-process"]);
    expect(
      codes("src/main/host-runtime/DetachedRuntime.ts", "application-unstructured-async.ts"),
    ).toEqual([
      "application-unstructured-async",
      "application-unstructured-async",
      "application-unstructured-async",
      "application-unstructured-async",
      "application-unstructured-async",
    ]);
    expect(
      codes("src/main/host-runtime/DetachedRuntime.ts", "application-unsafe-runtime.ts"),
    ).toEqual([
      "application-unsafe-runtime",
      "application-unsafe-runtime",
      "application-unsafe-runtime",
      "application-unsafe-runtime",
    ]);

    const applicationRoots = [
      "src/main/automation-application/AutomationApplication.ts",
      "src/main/browser-application/BrowserApplication.ts",
      "src/main/codex-runtime/CodexEndpoint.ts",
      "src/main/database-application/DatabaseModule.ts",
      "src/main/git-application/GitActions.ts",
      "src/main/initial-project/InitialProjectBootstrapRuntime.ts",
      "src/main/library-application/LibraryModule.ts",
      "src/main/nodex-agent-application/NodexAgentApplication.ts",
      "src/main/project-application/ProjectLifecycleCommands.ts",
    ];
    for (const path of applicationRoots) {
      expect(codes(path, "application-unstructured-async.ts"), path).toHaveLength(5);
    }
  });

  test("accepts dedicated adapters and the unique process entry", () => {
    expect(codes("src/main/platform/node/persistence.ts", "unstable-import.ts")).toEqual([]);
    expect(codes("packages/effect-codex-app-server/src/client.ts", "unstable-import.ts")).toEqual(
      [],
    );
    expect(codes("src/main/app/MainEntry.ts", "run-promise.ts")).toEqual([]);
    expect(codes("src/main/git-worker/entry.ts", "node-runtime.ts")).toEqual([]);
    expect(codes("src/main/worktree-worker/entry.ts", "node-runtime.ts")).toEqual([]);
    expect(codes("src/main/worktree-worker/stdio-entry.ts", "node-runtime.ts")).toEqual([]);
    expect(codes("scripts/codex-probe-session.ts", "node-runtime.ts")).toEqual([]);
    expect(codes("scripts/dev-launcher.ts", "run-promise.ts")).toEqual([]);
    expect(codes("src/main/data-authority.integration.ts", "run-promise.ts")).toEqual([]);
    expect(
      codes("scripts/scenarios/adapters/core-client-seed-runtime.ts", "run-promise.ts"),
    ).toEqual([]);
    expect(codes("src/main/app/MainEntry.test.ts", "run-promise.ts")).toEqual([]);
    expect(
      codes("src/main/core-runtime/ProjectionLiveRuntime.ts", "callback-unsafe-ingress.ts"),
    ).toEqual([]);
  });

  test("keeps the final application graph bounded and conversation internals private", () => {
    expect(codes("src/main/app/MainApplicationLive.ts", "final-kernel-violations.ts")).toEqual([
      "conversation-internal-import",
      "application-static-layer-build",
      "application-root-uninterruptible",
      "production-unbounded-channel",
      "production-unbounded-channel",
    ]);
    expect(codes("src/main/app/CodexApplicationLive.ts", "final-kernel-violations.ts")).toEqual([
      "application-static-layer-build",
      "production-unbounded-channel",
      "production-unbounded-channel",
    ]);
    expect(codes("src/main/codex-runtime/CodexEndpoint.ts", "final-kernel-violations.ts")).toEqual([
      "conversation-internal-import",
      "production-unbounded-channel",
      "production-unbounded-channel",
    ]);
  });

  test("limits probe execution to registered standalone entrypoints", () => {
    for (const path of [
      "scripts/probe-acp-agent.ts",
      "scripts/testing/probe-agent-cli-bootstrap.ts",
    ]) {
      expect(codes(path, "run-promise.ts"), path).toEqual([]);
    }
    expect(codes("scripts/testing/probe-agent-cli-helper.ts", "run-promise.ts")).toEqual([
      "run-outside-boundary",
    ]);
  });

  test("allows only the reviewed synchronous ingress operation in each owner", () => {
    const sourceText = `
      import * as Deferred from "effect/Deferred";
      import * as Queue from "effect/Queue";
      import * as Semaphore from "effect/Semaphore";
      Deferred.makeUnsafe();
      Semaphore.makeUnsafe(1);
      Queue.offerUnsafe(queue, "snapshot");
      Deferred.doneUnsafe(completion, effect);
    `;
    const rejectedOperations = (path: string) =>
      analyzeEffectBoundaries({ path, sourceText }).map((diagnostic) =>
        sourceText.split("\n")[diagnostic.line - 1]!.trim(),
      );
    expect(rejectedOperations("src/main/host-runtime/EditorHistoryRuntime.ts")).toEqual([
      "Semaphore.makeUnsafe(1);",
      'Queue.offerUnsafe(queue, "snapshot");',
      "Deferred.doneUnsafe(completion, effect);",
    ]);
    expect(rejectedOperations("src/main/host-runtime/ChromeControlRuntime.ts")).toEqual([
      "Deferred.makeUnsafe();",
      "Semaphore.makeUnsafe(1);",
      "Deferred.doneUnsafe(completion, effect);",
    ]);
  });
});
