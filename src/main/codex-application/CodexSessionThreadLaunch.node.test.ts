import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import type { CodexConversationSnapshot } from "../../shared/types";
import {
  CodexAppServerCapabilities,
  createCodexAppServerCapabilitySnapshot,
} from "../codex-runtime/CodexAppServerCapabilities";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { CoreModules } from "../core-runtime/CoreModules";
import { ProjectRuntimeLifecycleRuntime } from "../host-runtime/ProjectRuntimeLifecycleRuntime";
import { CodexAttachments } from "./CodexAttachments";
import { CodexFreshThreadLaunchRuntime } from "./CodexFreshThreadLaunchRuntime";
import { CodexPendingWorktreeRuntime } from "./CodexPendingWorktreeRuntime";
import { make, type CodexSessionThreadLaunchContext } from "./CodexSessionThreadLaunch";
import { CodexThreadDirectory } from "./CodexThreadDirectory";
import { CodexThreadLaunchCompletion } from "./CodexThreadLaunchCompletion";
import { ThreadCreationRuntime } from "./ThreadCreationRuntime";
import { transparentThreadCreationRuntime } from "./ThreadCreationRuntime.test-support";
import { CodexTurnCommands } from "./CodexTurnCommands";
import { CodexTurnPreparation } from "./CodexTurnPreparation";

const context: CodexSessionThreadLaunchContext = {
  browserViewScopeId: "window-a",
  ownerClientId: null,
};

const input = (sessionId = "session-a") => ({
  projectId: "project-a",
  sessionId,
  prompt: "Ship it",
});

const snapshot = (threadId: string) =>
  ({
    threadId,
    projectId: "project-a",
    turns: [],
    requests: [],
    queuedFollowUps: {
      status: "ready",
      ledgerRevision: 0,
      projectionRevision: 0,
      entries: [],
      inFlightFollowUpId: null,
      editingFollowUpId: null,
      error: null,
    },
  }) as unknown as CodexConversationSnapshot;

const harness = (
  scope: Scope.Scope,
  options: {
    readonly start?: Effect.Effect<unknown>;
    readonly commitFails?: boolean;
  } = {},
) => {
  const events: string[] = [];
  const threadStartParams: Array<Record<string, unknown>> = [];
  const requestScheduling: unknown[] = [];
  let attempt = 0;
  const capability = createCodexAppServerCapabilitySnapshot({
    hostId: "local",
    generation: 19,
    userAgent: "codex-app-server/0.145.0-alpha.15",
  });
  const gateway = CodexGateway.of({
    localHostId: "local",
    requestLocal: ((method: string, params: Record<string, unknown>, scheduling: unknown) => {
      requestScheduling.push(scheduling);
      if (method === "thread/delete") {
        events.push(`delete:${params.threadId}`);
        return Effect.succeed({});
      }
      attempt += 1;
      threadStartParams.push(params);
      events.push(`start:${attempt}`);
      return (options.start ?? Effect.void).pipe(
        Effect.as({ thread: { id: `thread-${attempt}` } }),
      );
    }) as CodexGateway["Service"]["requestLocal"],
  } as unknown as CodexGateway["Service"]);
  const core = CoreModules.of({
    workspace: {
      read: (request: { readonly kind: string }) =>
        request.kind === "session"
          ? Effect.succeed({
              value: {
                kind: "session",
                session: { project_id: "project-a", thread_id: null },
              },
            } as never)
          : Effect.succeed({
              value: {
                kind: "project",
                project: { lifecycle: "active", sources: [{ root: "/workspace" }] },
              },
            } as never),
    },
  } as unknown as CoreModules["Service"]);
  const directory = CodexThreadDirectory.of({
    acceptForkResult: () => Effect.die("unused"),
    observeMetadata: () => Effect.die("unused"),
    acceptStandaloneStart: () => Effect.die("unused"),
    acceptResumeResult: () => Effect.die("unused"),
    acceptSessionStart: (
      request: Parameters<CodexThreadDirectory["Service"]["acceptSessionStart"]>[0],
    ) =>
      options.commitFails
        ? Effect.fail({ _tag: "commit-failed" } as never)
        : Effect.sync(() => {
            events.push(`commit:${request.response.thread.id}`);
            const conversation = snapshot(request.response.thread.id);
            return {
              summary: conversation,
              snapshot: conversation,
            } as never;
          }),
  } as unknown as CodexThreadDirectory["Service"]);
  const turns = CodexTurnCommands.of({
    start: (threadId: string) =>
      Effect.sync(() => {
        events.push(`turn:${threadId}`);
        return { threadId, turnId: "turn-a", status: "inProgress", itemIds: [] } as const;
      }),
  } as unknown as CodexTurnCommands["Service"]);
  const completion = CodexThreadLaunchCompletion.of({
    accepted: ({ threadId }) => Effect.sync(() => events.push(`complete:${threadId}`)),
    failed: () => undefined,
  });
  return {
    events,
    requestScheduling,
    threadStartParams,
    effect: make.pipe(
      Effect.provideService(
        CodexAppServerCapabilities,
        CodexAppServerCapabilities.of({
          forHost: () => Effect.succeed(capability),
          forThread: () => Effect.succeed(capability),
          isCurrent: () => Effect.succeed(true),
        }),
      ),
      Effect.provideService(
        CodexAttachments,
        CodexAttachments.of({
          materializePastedText: () =>
            Effect.succeed({ attachments: [], createdAttachmentPaths: [] }),
          removePastedText: () => Effect.void,
        } as unknown as CodexAttachments["Service"]),
      ),
      Effect.provideService(CodexGateway, gateway),
      Effect.provideService(CoreModules, core),
      Effect.provideService(CodexThreadDirectory, directory),
      Effect.provideService(CodexTurnCommands, turns),
      Effect.provideService(CodexThreadLaunchCompletion, completion),
      Effect.provideService(ThreadCreationRuntime, transparentThreadCreationRuntime),
      Effect.provideService(
        ProjectRuntimeLifecycleRuntime,
        ProjectRuntimeLifecycleRuntime.of({ runExclusive: (_projectId, operation) => operation }),
      ),
      Effect.provideService(
        CodexPendingWorktreeRuntime,
        CodexPendingWorktreeRuntime.of({} as CodexPendingWorktreeRuntime["Service"]),
      ),
      Effect.provideService(
        CodexFreshThreadLaunchRuntime,
        CodexFreshThreadLaunchRuntime.of({} as CodexFreshThreadLaunchRuntime["Service"]),
      ),
      Effect.provideService(
        CodexTurnPreparation,
        CodexTurnPreparation.of({} as CodexTurnPreparation["Service"]),
      ),
      Effect.provideService(Scope.Scope, scope),
    ),
  };
};

it.effect("commits the Session link before admitting its first Turn", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const test = harness(scope);
    const service = yield* test.effect;

    const result = yield* service.start(input(), context);

    assert.strictEqual(result.kind, "started");
    assert.deepEqual(test.events, [
      "start:1",
      "commit:thread-1",
      "turn:thread-1",
      "complete:thread-1",
    ]);
    assert.deepEqual(test.requestScheduling, [{ expectedHostId: "local", expectedGeneration: 19 }]);
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("preserves the semantic source of protocol-created child Threads", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const test = harness(scope);
    const service = yield* test.effect;

    yield* service.start({ ...input(), threadSource: "subagent" }, context);

    assert.strictEqual(test.threadStartParams[0]?.threadSource, "subagent");
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("serializes a Session and compensates a Thread rejected before linking", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const test = harness(scope, {
      start: Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
      commitFails: true,
    });
    const service = yield* test.effect;
    const first = yield* service.start(input(), context).pipe(Effect.forkChild);
    yield* Deferred.await(entered);
    const second = yield* service.start(input(), context).pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    assert.deepEqual(test.events, ["start:1"]);
    yield* Deferred.succeed(release, undefined);
    assert.isTrue(Exit.isFailure(yield* Fiber.await(first)));
    assert.isTrue(Exit.isFailure(yield* Fiber.await(second)));
    assert.deepEqual(test.events, ["start:1", "delete:thread-1", "start:2", "delete:thread-2"]);
    yield* Scope.close(scope, Exit.void);
  }),
);
