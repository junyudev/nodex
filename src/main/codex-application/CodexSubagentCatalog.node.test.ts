import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import type { DesktopProjectWorkspaceThread } from "../core-client/project-workspace-adapter";
import { CodexConversationRelationships } from "./CodexConversationRelationships";
import { CodexThreadDirectory, type CodexThreadDirectoryEntry } from "./CodexThreadDirectory";
import { buildWorkspaceThreadSummary } from "./CodexThreadCatalogProjection";
import { CODEX_SUBAGENT_CATALOG_MAX_ENTRIES, make } from "./CodexSubagentCatalog";

const relationships = CodexConversationRelationships.of({ refresh: () => Effect.succeed([]) });

const workspaceThread = (threadId: string): DesktopProjectWorkspaceThread => ({
  threadId,
  projectId: "project-1",
  sessionId: null,
  forkedFromId: null,
  parentThreadId: "root",
  threadSource: "subagent",
  serviceName: null,
  agentNickname: null,
  agentRole: null,
  agentPath: null,
  threadName: threadId,
  threadPreview: "",
  modelProvider: "openai",
  executionProfile: null,
  executionHostId: "local",
  cwd: "/workspace",
  managedWorktreePath: null,
  projectlessOutputDirectory: null,
  projectlessWorkspaceBrowserRoot: null,
  statusType: "idle",
  statusActiveFlags: [],
  archived: false,
  pinnedOrder: null,
  hasUnreadTurn: false,
  createdAt: 100_000,
  updatedAt: 100_000,
  recencyAt: 100_000,
  linkedAt: "2026-08-23T00:00:00.000Z",
});

const entry = (threadId: string, fidelity: CodexThreadDirectoryEntry["fidelity"]) => {
  const durable = workspaceThread(threadId);
  return {
    fidelity,
    historyMode: null,
    durable,
    summary: buildWorkspaceThreadSummary(durable),
    canonical: null,
    snapshot: null,
  } satisfies CodexThreadDirectoryEntry;
};

it.effect("deduplicates background hydration and requests the final fidelity", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const reads: unknown[] = [];
      const directory = CodexThreadDirectory.of({
        materializeInCurrentLane: () => Effect.die("unused"),
        resolve: () => Effect.die("unused"),
        descendants: (input) =>
          Effect.sync(() => {
            reads.push(input);
            return input.threadIds?.map((threadId) => entry(threadId, input.fidelity)) ?? [];
          }),
        acceptRollbackResult: () => Effect.die("unused"),
        acceptImportResult: () => Effect.die("unused"),
        acceptForkResult: () => Effect.die("unused"),
        observeMetadata: () => Effect.die("unused"),
        acceptStandaloneStart: () => Effect.die("unused"),
        acceptResumeResult: () => Effect.die("unused"),
        acceptSessionStart: () => Effect.die("unused"),
      });
      const runtime = yield* make.pipe(
        Effect.provideService(CodexConversationRelationships, relationships),
        Effect.provideService(CodexThreadDirectory, directory),
      );

      const summaries = yield* runtime.hydrateBackground({
        rootThreadId: "root",
        threadIds: [" child-1 ", "child-1", "", "child-2"],
        includeTail: true,
      });

      assert.deepEqual(reads, [
        {
          rootThreadId: "root",
          threadIds: ["child-1", "child-2"],
          fidelity: "tail",
        },
      ]);
      assert.deepEqual(
        summaries.map((summary) => summary.threadId),
        ["child-1", "child-2"],
      );
    }),
  ),
);

it.effect("delegates panel lineage and fidelity to the authoritative Directory", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const calls: unknown[] = [];
      const directory = CodexThreadDirectory.of({
        materializeInCurrentLane: () => Effect.die("unused"),
        resolve: () => Effect.die("unused"),
        descendants: (input) =>
          Effect.sync(() => {
            calls.push(input);
            return [entry("child-2", "metadata")];
          }),
        acceptRollbackResult: () => Effect.die("unused"),
        acceptImportResult: () => Effect.die("unused"),
        acceptForkResult: () => Effect.die("unused"),
        observeMetadata: () => Effect.die("unused"),
        acceptStandaloneStart: () => Effect.die("unused"),
        acceptResumeResult: () => Effect.die("unused"),
        acceptSessionStart: () => Effect.die("unused"),
      });
      const runtime = yield* make.pipe(
        Effect.provideService(CodexConversationRelationships, relationships),
        Effect.provideService(CodexThreadDirectory, directory),
      );

      const summaries = yield* runtime.hydratePanel({
        rootThreadId: "root",
        threadIds: ["child-2"],
        includeTail: false,
      });

      assert.deepEqual(calls, [
        { rootThreadId: "root", threadIds: ["child-2"], fidelity: "metadata" },
      ]);
      assert.deepEqual(
        summaries.map((summary) => summary.threadId),
        ["child-2"],
      );
    }),
  ),
);

it.effect("opens full-fidelity delivery and clears both subagent indexes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const directory = CodexThreadDirectory.of({
        materializeInCurrentLane: () => Effect.die("unused"),
        resolve: () => Effect.die("unused"),
        descendants: () => Effect.die("unused"),
        acceptRollbackResult: () => Effect.die("unused"),
        acceptImportResult: () => Effect.die("unused"),
        acceptForkResult: () => Effect.die("unused"),
        observeMetadata: () => Effect.die("unused"),
        acceptStandaloneStart: () => Effect.die("unused"),
        acceptResumeResult: () => Effect.die("unused"),
        acceptSessionStart: () => Effect.die("unused"),
      });
      const runtime = yield* make.pipe(
        Effect.provideService(CodexConversationRelationships, relationships),
        Effect.provideService(CodexThreadDirectory, directory),
      );
      runtime.observe("child-1");
      assert.isTrue(runtime.shouldDropDelta("item/agentMessage/delta", "child-1"));
      assert.isFalse(runtime.shouldDropDelta("turn/completed", "child-1"));
      assert.isTrue(yield* runtime.open("child-1"));
      assert.isFalse(runtime.shouldDropDelta("item/agentMessage/delta", "child-1"));
      runtime.clear("child-1");
      assert.isFalse(runtime.shouldDropDelta("item/agentMessage/delta", "child-1"));
    }),
  ),
);

it.effect(
  "evicts old background-only subagents instead of retaining an unbounded delta index",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = CodexThreadDirectory.of({
          materializeInCurrentLane: () => Effect.die("unused"),
          resolve: () => Effect.die("unused"),
          descendants: () => Effect.die("unused"),
          acceptRollbackResult: () => Effect.die("unused"),
          acceptImportResult: () => Effect.die("unused"),
          acceptForkResult: () => Effect.die("unused"),
          observeMetadata: () => Effect.die("unused"),
          acceptStandaloneStart: () => Effect.die("unused"),
          acceptResumeResult: () => Effect.die("unused"),
          acceptSessionStart: () => Effect.die("unused"),
        });
        const runtime = yield* make.pipe(
          Effect.provideService(CodexConversationRelationships, relationships),
          Effect.provideService(CodexThreadDirectory, directory),
        );

        for (let index = 0; index <= CODEX_SUBAGENT_CATALOG_MAX_ENTRIES; index += 1) {
          runtime.observe(`child-${index}`);
        }

        assert.isFalse(runtime.shouldDropDelta("item/agentMessage/delta", "child-0"));
        assert.isTrue(
          runtime.shouldDropDelta(
            "item/agentMessage/delta",
            `child-${CODEX_SUBAGENT_CATALOG_MAX_ENTRIES}`,
          ),
        );
        assert.isTrue(yield* runtime.open(`child-${CODEX_SUBAGENT_CATALOG_MAX_ENTRIES}`));
        assert.isFalse(
          runtime.shouldDropDelta(
            "item/agentMessage/delta",
            `child-${CODEX_SUBAGENT_CATALOG_MAX_ENTRIES}`,
          ),
        );
      }),
    ),
);

it.effect("owner Scope close interrupts active Directory hydration", () =>
  Effect.gen(function* () {
    const ownerScope = yield* Scope.make();
    let interrupted = false;
    const directory = CodexThreadDirectory.of({
      materializeInCurrentLane: () => Effect.die("unused"),
      resolve: () => Effect.die("unused"),
      descendants: () =>
        Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => (interrupted = true)))),
      acceptRollbackResult: () => Effect.die("unused"),
      acceptImportResult: () => Effect.die("unused"),
      acceptForkResult: () => Effect.die("unused"),
      observeMetadata: () => Effect.die("unused"),
      acceptStandaloneStart: () => Effect.die("unused"),
      acceptResumeResult: () => Effect.die("unused"),
      acceptSessionStart: () => Effect.die("unused"),
    });
    const runtime = yield* make.pipe(
      Effect.provideService(CodexConversationRelationships, relationships),
      Effect.provideService(CodexThreadDirectory, directory),
      Effect.provideService(Scope.Scope, ownerScope),
    );
    const hydration = yield* Effect.forkChild(
      runtime.hydrateBackground({ rootThreadId: "root", threadIds: ["child-1"] }),
      { startImmediately: true },
    );
    yield* Effect.yieldNow;
    yield* Scope.close(ownerScope, Exit.void);

    assert.strictEqual((yield* Fiber.await(hydration))._tag, "Failure");
    assert.isTrue(interrupted);
  }),
);
