import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ThreadId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunId,
  RunAttemptId,
  NodeId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as Projections from "../orchestration-v2/ProjectionStore.ts";
import * as Sessions from "../orchestration-v2/ProviderSessionManager.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { HostBridge } from "./HostBridge.ts";
import { make } from "./Authority.ts";

it.effect(
  "uses the Thread workspace subfolder and current Run without loading conversation bodies",
  () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:authority");
      const runId = RunId.make("run:authority");
      const attemptId = RunAttemptId.make("attempt:authority");
      const providerThreadId = ProviderThreadId.make("native-thread:authority");
      const providerSessionId = ProviderSessionId.make("native-session:authority");
      const providerInstanceId = ProviderInstanceId.make("codex");
      const driver = ProviderDriverKind.make("codex");
      const lineage = { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId };
      const shell = yield* Ref.make<OrchestrationV2ThreadShell>({
        id: threadId,
        projectId: ProjectId.make("project:authority"),
        title: "Authority",
        providerInstanceId,
        modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
        createdBy: "user",
        creationSource: "web",
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: "feature",
        worktreePath: "/managed-worktree/packages/frontend",
        lineage,
        forkedFrom: null,
        activeProviderThreadId: providerThreadId,
        latestRunId: runId,
        activeRunId: runId,
        status: "running",
        pendingRuntimeRequest: null,
        latestVisibleMessage: null,
        latestUserMessageAt: null,
        hasActionableProposedPlan: false,
        itemCount: 500_000,
        visibleItemCount: 500_000,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        deletedAt: null,
      });
      const unused = () =>
        Effect.die("Authority must not execute native commands or read conversation bodies.");
      const layers = Layer.mergeAll(
        Layer.mock(Projections.ProjectionStoreV2)({
          getThreadShell: () => Ref.get(shell),
          getThreadProjection: unused,
          getHostToolAuthorityContext: (target, selectedRun) =>
            Effect.gen(function* () {
              expect(target).toBe(threadId);
              expect(selectedRun).toBe(runId);
              const metadata = yield* Ref.get(shell);
              return {
                thread: { ...metadata, deletedAt: null },
                runs: [
                  {
                    id: runId,
                    ordinal: 1,
                    activeAttemptId: attemptId,
                    providerThreadId,
                    providerInstanceId,
                    rootNodeId: NodeId.make("node:authority"),
                    status: "starting",
                  },
                ],
                providerThreads: [
                  {
                    id: providerThreadId,
                    driver,
                    providerInstanceId,
                    providerSessionId,
                    appThreadId: threadId,
                    ownerNodeId: null,
                    nativeThreadRef: null,
                    nativeConversationHeadRef: null,
                    status: "active",
                    firstRunOrdinal: 1,
                    lastRunOrdinal: 1,
                    handoffIds: [],
                    forkedFrom: null,
                    createdAt: now,
                    updatedAt: now,
                  },
                ],
                providerTurns: [],
                subagents: [],
                directParent: null,
              };
            }),
        }),
        Layer.mock(Sessions.ProviderSessionManagerV2)({
          get: () =>
            Effect.succeed(
              Option.some({
                instanceId: providerInstanceId,
                driver,
                providerSessionId,
                nativeGeneration: 9,
                providerSession: {
                  id: providerSessionId,
                  driver,
                  providerInstanceId,
                  status: "ready",
                  cwd: "/managed-worktree",
                  model: "gpt-5.4",
                  capabilities: CodexProviderCapabilitiesV2,
                  createdAt: now,
                  updatedAt: now,
                  lastError: null,
                },
                events: Stream.empty,
                hasPendingBackgroundWork: Effect.succeed(false),
                ensureThread: unused,
                resumeThread: unused,
                startTurn: unused,
                steerTurn: unused,
                interruptTurn: unused,
                respondToRuntimeRequest: unused,
                readThreadSnapshot: unused,
                rollbackThread: unused,
                forkThread: unused,
              }),
            ),
        }),
        Layer.mock(HostBridge)({
          runtimeId: EnvironmentId.make("runtime:authority"),
          runtimeGeneration: "generation:authority",
        }),
      );
      yield* Effect.gen(function* () {
        const read = yield* make;
        expect(yield* read({ threadId, runId })).toMatchObject({
          cwd: "/managed-worktree/packages/frontend",
          branch: "feature",
          worktreePath: "/managed-worktree/packages/frontend",
          nativeGeneration: 9,
          status: "starting",
        });
        yield* Ref.update(shell, (current) => ({ ...current, worktreePath: null }));
        expect((yield* read({ threadId, runId }))?.cwd).toBe("/managed-worktree");
        expect(yield* read({ threadId, runId: RunId.make("run:stale") })).toBeNull();
      }).pipe(Effect.provide(layers));
    }),
);
