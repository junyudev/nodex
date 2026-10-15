import * as path from "node:path";
import { createHash } from "node:crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { CodexGitProbe } from "../codex-application/CodexGitProbe";
import { ExecutionHostRuntime } from "../codex-application/ExecutionHostRuntime";
import type { ManagedWorktreeHandoffPreparation } from "../codex-application/ManagedWorktreeHandoff";
import type { CodexThreadExecutionLocation } from "../codex/codex-thread-handoff-journal";
import { ProjectWorkspace } from "../project-application/ProjectWorkspace";
import { AgentRuntimeApplication } from "./AgentRuntimeApplication";
import { AgentRuntimeSupervisor } from "./AgentRuntimeSupervisor";

export class AgentRuntimeThreadExecutionError extends Schema.TaggedError<AgentRuntimeThreadExecutionError>()(
  "AgentRuntimeThreadExecutionError",
  { operation: Schema.String, threadId: Schema.String, cause: Schema.Defect() },
) {}

/** Coordinates physical handoff with the Runtime's durable execution hold and writer. */
export const make = Effect.gen(function* () {
  const application = yield* AgentRuntimeApplication;
  const supervisor = yield* AgentRuntimeSupervisor;
  const workspace = yield* ProjectWorkspace;
  const git = yield* CodexGitProbe;
  const hosts = yield* ExecutionHostRuntime;
  const fs = yield* FileSystem.FileSystem;
  const error = (operation: string, threadId: string, cause: unknown) =>
    new AgentRuntimeThreadExecutionError({ operation, threadId, cause });
  const fail = (operation: string, threadId: string, message: string) =>
    Effect.fail(error(operation, threadId, new Error(message)));
  const load = Effect.fn("AgentRuntimeThreadExecution.load")(function* (threadId: string) {
    const found = yield* application
      .nativeThread(threadId)
      .pipe(Effect.mapError((cause) => error("read", threadId, cause)));
    if (!found || found.thread.lineage.rootThreadId !== threadId)
      return yield* fail("read", threadId, "A live Runtime Session root is required");
    return found;
  });
  type Captured = Effect.Success<ReturnType<typeof load>>;
  const request = <
    M extends "execution.handoff.hold" | "execution.handoff.quiesce" | "execution.handoff.commit",
  >(
    captured: Captured,
    method: M,
    input: import("@nodex/agent-runtime/contracts").AgentRuntimeOperations[M]["input"],
  ) =>
    captured.connection
      .request(method, input)
      .pipe(Effect.mapError((cause) => error(method, captured.thread.id, cause)));
  const location = Effect.fn("AgentRuntimeThreadExecution.location")(function* (
    captured: Captured,
  ) {
    if (captured.thread.executionLocation) return captured.thread.executionLocation;
    const cwd = captured.thread.worktreePath;
    if (!cwd || !path.isAbsolute(cwd))
      return yield* fail(
        "read",
        captured.thread.id,
        "The Session has no absolute execution folder",
      );
    const session = yield* workspace
      .getProjectSession(captured.sessionId)
      .pipe(Effect.mapError((cause) => error("read-session", captured.thread.id, cause)));
    if (!session) return yield* fail("read-session", captured.thread.id, "Session was removed");
    const project = session.projectId
      ? yield* workspace
          .getProject(session.projectId)
          .pipe(Effect.mapError((cause) => error("read-project", captured.thread.id, cause)))
      : null;
    const root = yield* git.readPath(cwd, ["rev-parse", "--show-toplevel"]);
    const host = yield* hosts
      .get("local")
      .pipe(Effect.mapError((cause) => error("read-host", captured.thread.id, cause)));
    if (!host)
      return yield* fail("read-host", captured.thread.id, "Local execution host is unavailable");
    const canonical = yield* Effect.all([
      fs
        .realPath(host.descriptor.managedRoot)
        .pipe(Effect.orElseSucceed(() => path.resolve(host.descriptor.managedRoot))),
      root
        ? fs.realPath(root).pipe(Effect.orElseSucceed(() => path.resolve(root)))
        : Effect.succeed(null),
    ]);
    const relative = canonical[1] === null ? null : path.relative(canonical[0], canonical[1]);
    const managed =
      relative !== null &&
      relative !== "" &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative)
        ? root
        : null;
    return {
      hostId: "local",
      cwd,
      workspaceRoots: [
        ...new Set([root ?? cwd, ...(project?.sources.map((source) => source.root) ?? [])]),
      ],
      managedWorktreePath: managed,
      projectId: session.projectId,
      projectlessOutputDirectory: null,
      projectlessWorkspaceBrowserRoot: null,
    } satisfies CodexThreadExecutionLocation;
  });
  const operation = (captured: Captured, operationId?: string) => {
    const id = operationId ?? captured.thread.executionHandoff?.operationId;
    return id
      ? Effect.succeed(id)
      : fail("handoff", captured.thread.id, "A handoff operation identity is required");
  };
  const local = (threadId: string, destinationHostId?: string | null) =>
    destinationHostId && destinationHostId !== "local"
      ? fail("read", threadId, "Runtime handoff supports the local execution host")
      : Effect.void;
  const owns = (threadId: string) =>
    application.nativeThread(threadId).pipe(
      Effect.map((value) => value !== null),
      Effect.mapError((cause) => error("resolve", threadId, cause)),
    );
  return {
    owns,
    read: Effect.fn("AgentRuntimeThreadExecution.read")(function* (
      threadId: string,
      destinationHostId?: string | null,
    ) {
      yield* local(threadId, destinationHostId);
      return yield* location(yield* load(threadId));
    }),
    setRecoveryRequired: Effect.fn("AgentRuntimeThreadExecution.recovery")(function* (
      threadId: string,
      required: boolean,
      operationId?: string,
    ) {
      const captured = yield* load(threadId);
      const id = yield* operation(captured, operationId);
      if (!required)
        yield* request(captured, "execution.handoff.quiesce", { threadId, operationId: id });
      yield* request(captured, "execution.handoff.hold", {
        threadId,
        operationId: id,
        action: "recovery",
        recoveryRequired: required,
        ...(!captured.thread.executionHandoff ? { sourceLocation: yield* location(captured) } : {}),
      });
    }),
    withHandoff: <A, E, R>(threadId: string, use: Effect.Effect<A, E, R>, operationId?: string) =>
      load(threadId).pipe(
        Effect.flatMap((initial) =>
          application.withExecutionLocationWriter(
            initial.sessionId,
            Effect.acquireUseRelease(
              Effect.gen(function* () {
                const captured = yield* load(threadId);
                if (captured.sessionId !== initial.sessionId)
                  return yield* fail(
                    "handoff",
                    threadId,
                    "The Session binding changed before handoff admission",
                  );
                const id = yield* operation(captured, operationId);
                yield* request(captured, "execution.handoff.hold", {
                  threadId,
                  operationId: id,
                  action: "acquire",
                  sourceLocation: yield* location(captured),
                });
                return { captured, id };
              }),
              ({ captured, id }) =>
                use.pipe(
                  Effect.onError(() =>
                    request(captured, "execution.handoff.hold", {
                      threadId,
                      operationId: id,
                      action: "recovery",
                      recoveryRequired: true,
                    }).pipe(Effect.ignore),
                  ),
                ),
              ({ captured, id }) =>
                Effect.gen(function* () {
                  const current = yield* captured.connection
                    .request("thread.read", { threadId })
                    .pipe(Effect.mapError((cause) => error("release", threadId, cause)));
                  if (
                    current?.executionHandoff?.operationId !== id ||
                    current.executionHandoff.recoveryRequired
                  )
                    return;
                  yield* request(captured, "execution.handoff.hold", {
                    threadId,
                    operationId: id,
                    action: "release",
                  });
                }),
            ),
          ),
        ),
        Effect.mapError((cause) => error("handoff", threadId, cause)),
      ),
    stop: Effect.fn("AgentRuntimeThreadExecution.stop")(function* (threadId: string) {
      const captured = yield* load(threadId);
      yield* request(captured, "execution.handoff.quiesce", {
        threadId,
        operationId: yield* operation(captured),
      });
    }),
    withRuntimeLocation: <A, E, R>(
      threadId: string,
      destination: CodexThreadExecutionLocation,
      preparation: ManagedWorktreeHandoffPreparation | null,
      use: Effect.Effect<A, E, R>,
    ) =>
      Effect.gen(function* () {
        yield* local(threadId, destination.hostId);
        const captured = yield* load(threadId);
        const operationId = yield* operation(captured);
        if (
          !path.isAbsolute(destination.cwd) ||
          destination.workspaceRoots.some((root) => !path.isAbsolute(root))
        )
          return yield* fail(
            "switch-runtime",
            threadId,
            "An absolute local execution location is required",
          );
        if (preparation) {
          const { sourceWorkspaceRoot, destinationWorkspaceRoot } = preparation.prepared;
          yield* request(captured, "execution.handoff.commit", {
            threadId,
            operationId,
            location: destination,
            childrenOnly: true,
            sourceWorkspaceRoot:
              destination.workspaceRoots[0] === sourceWorkspaceRoot
                ? destinationWorkspaceRoot
                : sourceWorkspaceRoot,
          });
        }
        return yield* use;
      }),
    commit: Effect.fn("AgentRuntimeThreadExecution.commit")(function* (
      threadId: string,
      destination: CodexThreadExecutionLocation,
    ) {
      yield* local(threadId, destination.hostId);
      const captured = yield* load(threadId);
      yield* request(captured, "execution.handoff.commit", {
        threadId,
        operationId: yield* operation(captured),
        location: destination,
      });
    }),
    followUp: Effect.fn("AgentRuntimeThreadExecution.followUp")(function* (
      threadId: string,
      prompt: string,
      operationId?: string,
    ) {
      if (!operationId)
        return yield* fail("follow-up", threadId, "A handoff operation identity is required");
      const captured = yield* load(threadId);
      yield* application
        .message({
          sessionId: captured.sessionId,
          message: {
            messageId: `handoff-follow-up:${createHash("sha256").update(operationId).digest("hex")}`,
            text: prompt,
          },
        })
        .pipe(Effect.mapError((cause) => error("follow-up", threadId, cause)));
    }),
    reconcileRecovery: Effect.fn("AgentRuntimeThreadExecution.reconcileRecovery")(function* (
      operations: readonly { readonly threadId: string; readonly operationId: string }[],
    ) {
      // Evidence of a quiet stop proves the store holds no handoff to settle.
      const connection = yield* supervisor.getUnlessQuiet.pipe(
        Effect.mapError((cause) => error("recover", "", cause)),
      );
      if (!connection) return;
      const retained = new Set(
        operations.map((entry) => JSON.stringify([entry.threadId, entry.operationId])),
      );
      let cursor: string | undefined;
      do {
        const page = yield* connection
          .request("execution.handoff.pending", cursor ? { cursor } : {})
          .pipe(Effect.mapError((cause) => error("recover", "", cause)));
        for (const pending of page.items) {
          if (retained.has(JSON.stringify([pending.threadId, pending.operationId]))) continue;
          yield* connection
            .request("execution.handoff.quiesce", {
              threadId: pending.threadId,
              operationId: pending.operationId,
            })
            .pipe(Effect.mapError((cause) => error("recover", pending.threadId, cause)));
          yield* connection
            .request("execution.handoff.hold", {
              ...pending,
              action: "recovery",
              recoveryRequired: false,
            })
            .pipe(Effect.mapError((cause) => error("recover", pending.threadId, cause)));
          yield* connection
            .request("execution.handoff.hold", {
              threadId: pending.threadId,
              operationId: pending.operationId,
              action: "release",
            })
            .pipe(Effect.mapError((cause) => error("recover", pending.threadId, cause)));
        }
        cursor = page.nextCursor ?? undefined;
      } while (cursor !== undefined);
    }),
  };
});

export class AgentRuntimeThreadExecution extends Context.Service<
  AgentRuntimeThreadExecution,
  Effect.Success<typeof make>
>()("nodex/main/agent-runtime/AgentRuntimeThreadExecution") {}
export const live = Layer.effect(AgentRuntimeThreadExecution, make);
