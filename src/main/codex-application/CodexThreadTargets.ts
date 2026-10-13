import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { Thread } from "@nodex/codex-app-server-protocol/v2";
import {
  selectCodexChildThreadReply,
  type CodexChildThreadSummary,
  type CodexChildThreadSummaryInput,
  type CodexCreatedThreadResolution,
} from "../../shared/codex-child-thread-summary";
import { projectCodexMarkdownLabel } from "../../shared/codex-markdown-text";
import { createUuidV7 } from "../../shared/uuid-v7";
import type { ProjectSession } from "../../shared/types";
import { readCodexLinkedRootSession } from "./CodexLinkedRootSession";
import { CoreModuleResponseError } from "../core-client/core-client";
import type { ProjectWorkspaceReadSnapshot } from "../core-client/types";
import { CoreModules } from "../core-runtime/CoreModules";
import { CoreRuntimeError } from "../core-runtime/CoreRuntimeError";
import { createOperationId } from "../core-runtime/operation-identity";
import { CodexGateway, codexGatewayGenerationFence } from "../codex-runtime/CodexGateway";
import {
  projectCodexGatewayThreadItemsList,
  projectCodexGatewayThreadReadThread,
} from "../codex-runtime/CodexGatewayProtocolProjection";
import {
  CodexAppServerCapabilities,
  type CodexAppServerCapabilitySnapshot,
} from "../codex-runtime/CodexAppServerCapabilities";
import { CodexMainConversationManagers } from "./CodexMainConversationManagers";
import { MainConfig } from "../app/MainConfig";
import {
  isNonSidebarThreadWithoutParent,
  projectCoreWorkspaceProject,
  resolveSidebarProjectIdForCwd,
} from "./CodexThreadCatalogProjection";
import {
  projectCodexThreadDirectoryMaterialization,
  projectCoreWorkspaceThread,
  projectCodexThreadTargetObservation,
} from "./CodexThreadDirectoryProjection";

const inputSchema = Schema.Struct({
  hostId: Schema.Trimmed.check(Schema.isMinLength(1)),
  threadId: Schema.Trimmed.check(Schema.isMinLength(1)),
});

type CoreThread = Extract<ProjectWorkspaceReadSnapshot["value"], { kind: "thread" }>["thread"];

export class CodexThreadTargetError extends Data.TaggedError("CodexThreadTargetError")<{
  readonly operation: "read" | "open";
  readonly cause: unknown;
}> {}

/** Explicit host targets never discover a different endpoint or transfer execution ownership. */
export class CodexThreadTargets extends Context.Service<
  CodexThreadTargets,
  {
    readonly readSummary: (
      input: CodexChildThreadSummaryInput,
    ) => Effect.Effect<CodexChildThreadSummary, CodexThreadTargetError>;
    readonly ensureOpen: (
      input: CodexChildThreadSummaryInput,
    ) => Effect.Effect<ProjectSession | null, CodexThreadTargetError>;
    readonly resolveKnown: (
      threadId: string,
      expectedHostId?: string,
    ) => Effect.Effect<CodexCreatedThreadResolution | null, CodexThreadTargetError>;
  }
>()("nodex/main/codex-application/CodexThreadTargets") {}

const missing = (cause: unknown): boolean =>
  cause instanceof CoreRuntimeError &&
  cause.cause instanceof CoreModuleResponseError &&
  cause.cause.coreError.code === "not_found";

export const make = Effect.gen(function* () {
  const core = yield* CoreModules;
  const gateway = yield* CodexGateway;
  const managers = yield* CodexMainConversationManagers;
  const capabilities = yield* CodexAppServerCapabilities;
  const config = yield* MainConfig;
  const fail = (operation: "read" | "open", cause: unknown) =>
    new CodexThreadTargetError({ operation, cause });
  const decode = (input: CodexChildThreadSummaryInput, operation: "read" | "open") =>
    Schema.decodeUnknownEffect(inputSchema, { onExcessProperty: "error" })(input).pipe(
      Effect.mapError((cause) => fail(operation, cause)),
    );

  const readBinding = Effect.fn("CodexThreadTargets.readBinding")(function* (
    input: CodexChildThreadSummaryInput,
    operation: "read" | "open",
  ) {
    const result = yield* core.workspace.read({ kind: "thread", thread_id: input.threadId }).pipe(
      Effect.catch((cause) => (missing(cause) ? Effect.succeed(null) : Effect.fail(cause))),
      Effect.mapError((cause) => fail(operation, cause)),
    );
    if (result === null) return null;
    if (result.value.kind !== "thread")
      return yield* fail(operation, new Error("Core returned a non-Thread target"));
    const thread = result.value.thread;
    if (thread.backend_binding.kind !== "codex" || thread.execution_host_id !== input.hostId)
      return yield* fail(operation, new Error("Conversation execution binding changed"));
    return thread;
  });

  const readLinkedSession = Effect.fn("CodexThreadTargets.readLinkedSession")(function* (
    input: CodexChildThreadSummaryInput,
  ) {
    const session = yield* readCodexLinkedRootSession(core, input).pipe(
      Effect.mapError((cause) => fail("open", cause)),
    );
    if (!session)
      return yield* fail("open", new Error("Core returned an unconfirmed root Session"));
    return session;
  });

  const withHost = <A>(
    input: CodexChildThreadSummaryInput,
    operation: "read" | "open",
    execute: (
      capability: CodexAppServerCapabilitySnapshot,
      assertCurrent: () => Effect.Effect<void, CodexThreadTargetError>,
    ) => Effect.Effect<A, CodexThreadTargetError>,
  ): Effect.Effect<A, CodexThreadTargetError> =>
    Effect.gen(function* () {
      const manager = managers.current(input.hostId);
      if (manager === null)
        return yield* fail(operation, new Error("Conversation host is unavailable"));
      const connection = yield* gateway
        .connection(input.hostId)
        .pipe(Effect.mapError((cause) => fail(operation, cause)));
      if (connection.kind !== "ready")
        return yield* fail(operation, new Error("Conversation host is disconnected"));
      const capability = yield* capabilities
        .forHost(input.hostId)
        .pipe(Effect.mapError((cause) => fail(operation, cause)));
      const assertCurrent = Effect.fn("CodexThreadTargets.assertCurrent")(function* () {
        yield* Effect.try({
          try: () => {
            if (managers.current(input.hostId) !== manager || capability.hostId !== input.hostId)
              throw new Error("Conversation host was replaced");
            manager.assertCurrent(capability.generation);
          },
          catch: (cause) => fail(operation, cause),
        });
        const current = yield* capabilities
          .isCurrent(capability)
          .pipe(Effect.mapError((cause) => fail(operation, cause)));
        if (!current) return yield* fail(operation, new Error("Conversation source was replaced"));
      });
      const listeners: Disposable[] = [];
      const retired = Effect.callback<never, CodexThreadTargetError>((resume) => {
        const invalidate = () =>
          resume(Effect.fail(fail(operation, new Error("Conversation source retired"))));
        try {
          listeners.push(manager.onDispose(invalidate));
          listeners.push(manager.onConnectionReset(invalidate));
        } catch (cause) {
          resume(Effect.fail(fail(operation, cause)));
        }
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            for (const listener of listeners) listener[Symbol.dispose]();
          }),
        ),
      );
      return yield* Effect.raceFirst(
        retired,
        assertCurrent().pipe(Effect.flatMap(() => execute(capability, assertCurrent))),
      );
    });

  const readHeader = Effect.fn("CodexThreadTargets.readHeader")(function* (
    input: CodexChildThreadSummaryInput,
    operation: "read" | "open",
    capability: CodexAppServerCapabilitySnapshot,
    assertCurrent: () => Effect.Effect<void, CodexThreadTargetError>,
  ) {
    const result = yield* gateway
      .requestOnHost(
        input.hostId,
        "thread/read",
        { threadId: input.threadId, includeTurns: false },
        {
          ...codexGatewayGenerationFence(capability),
          priority: "background",
          source: "thread_hydration",
        },
      )
      .pipe(Effect.mapError((cause) => fail(operation, cause)));
    yield* assertCurrent();
    const thread = projectCodexGatewayThreadReadThread(result.thread);
    if (thread.id !== input.threadId || thread.turns.length !== 0)
      return yield* fail(
        operation,
        new Error("Thread metadata does not match its explicit target"),
      );
    return thread;
  });

  const applyOpen = Effect.fn("CodexThreadTargets.applyOpen")(function* (
    input: CodexChildThreadSummaryInput,
    current: CoreThread | null,
    observed: Thread | null,
    assertCurrent?: () => Effect.Effect<void, CodexThreadTargetError>,
  ) {
    const binding =
      current === null
        ? { kind: "absent" as const }
        : {
            kind: "existing" as const,
            project_id: current.project_id,
            session_id: current.session_id,
          };
    let projectId = current?.project_id ?? null;
    if (current === null && observed) {
      const projects = yield* core.workspace
        .read({
          kind: "project_window",
          include_archived: false,
          window: { first: 200, after: null },
        })
        .pipe(Effect.mapError((cause) => fail("open", cause)));
      if (projects.value.kind !== "project_window" || projects.value.projects.next_cursor !== null)
        return yield* fail("open", new Error("Project catalog exceeded its navigation bound"));
      projectId = resolveSidebarProjectIdForCwd(
        observed.cwd,
        projects.value.projects.items.map(projectCoreWorkspaceProject),
        config.platform === "win32",
      );
    }
    const metadata = observed
      ? projectCodexThreadDirectoryMaterialization({
          thread: observed,
          existing: current ? projectCoreWorkspaceThread(current) : null,
          parent: null,
          inferredInitialProjectId: projectId,
          observedExecutionHostId: input.hostId,
          nowMs: observed.updatedAt * 1_000,
        })
      : null;
    if (observed && !metadata)
      return yield* fail("open", new Error("Conversation metadata is unavailable"));
    const observation = metadata
      ? projectCodexThreadTargetObservation(
          metadata,
          current ? projectCoreWorkspaceThread(current) : null,
          projectId,
        )
      : null;
    if (observed && !observation)
      return yield* fail("open", new Error("Conversation metadata is incomplete"));
    if (assertCurrent) yield* assertCurrent();
    const result = yield* core.workspace
      .apply({
        operationId: createOperationId("thread-target.ensure-open"),
        intent: {
          kind: "ensure_codex_thread_session",
          thread_id: input.threadId,
          expected_execution_host_id: input.hostId,
          expected_binding: binding,
          session_id: createUuidV7(),
          title: projectCodexMarkdownLabel(observed?.name ?? current?.thread_name) ?? "New chat",
          observation,
        },
      })
      .pipe(Effect.mapError((cause) => fail("open", cause)));
    if (assertCurrent) yield* assertCurrent();
    const session = yield* readLinkedSession(input);
    if (
      result.outcome.affected_session_ids.length !== 1 ||
      result.outcome.affected_session_ids[0] !== session.id
    )
      return yield* fail("open", new Error("Conversation Session link changed after navigation"));
    return session;
  });

  return CodexThreadTargets.of({
    resolveKnown: Effect.fn("CodexThreadTargets.resolveKnown")(
      function* (rawThreadId, expectedHostId) {
        const threadId = rawThreadId.trim();
        if (!threadId) return null;
        const result = yield* core.workspace.read({ kind: "thread", thread_id: threadId }).pipe(
          Effect.catch((cause) => (missing(cause) ? Effect.succeed(null) : Effect.fail(cause))),
          Effect.mapError((cause) => fail("read", cause)),
        );
        if (result === null) return null;
        if (result.value.kind !== "thread")
          return yield* fail("read", new Error("Core returned a non-Thread target"));
        const thread = result.value.thread;
        if (
          thread.backend_binding.kind !== "codex" ||
          (expectedHostId !== undefined && thread.execution_host_id !== expectedHostId)
        )
          return null;
        return {
          hostId: thread.execution_host_id,
          threadId,
          ready: true,
          parentThreadId: thread.parent_thread_id ?? null,
        };
      },
    ),
    readSummary: Effect.fn("CodexThreadTargets.readSummary")(function* (raw) {
      const input = yield* decode(raw, "read");
      yield* readBinding(input, "read");
      return yield* withHost(input, "read", (capability, assertCurrent) =>
        Effect.gen(function* () {
          const thread = yield* readHeader(input, "read", capability, assertCurrent);
          let latestReply: string | null = null;
          if (capability.flags.paginatedHistory) {
            const page = yield* gateway
              .requestOnHost(
                input.hostId,
                "thread/items/list",
                { threadId: input.threadId, limit: 100, sortDirection: "desc" },
                {
                  ...codexGatewayGenerationFence(capability),
                  priority: "background",
                  source: "thread_hydration",
                },
              )
              .pipe(Effect.mapError((cause) => fail("read", cause)));
            yield* assertCurrent();
            latestReply = selectCodexChildThreadReply(
              projectCodexGatewayThreadItemsList(page).data,
            );
          }
          yield* readBinding(input, "read");
          yield* assertCurrent();
          return {
            ...input,
            title: projectCodexMarkdownLabel(thread.name),
            status: thread.status,
            latestReply,
          };
        }),
      );
    }),
    ensureOpen: Effect.fn("CodexThreadTargets.ensureOpen")(function* (raw) {
      const input = yield* decode(raw, "open");
      const current = yield* readBinding(input, "open");
      if (current?.parent_thread_id) return null;
      // A real linked root may have a subagent source; discovery policy does not retire its link.
      if (current?.session_id) {
        const session = yield* readLinkedSession(input);
        if (session.id !== current.session_id)
          return yield* fail("open", new Error("Conversation Session changed during navigation"));
        return session;
      }
      if (current?.archived) return null;
      return yield* withHost(input, "open", (capability, assertCurrent) =>
        Effect.gen(function* () {
          const observed = yield* readHeader(input, "open", capability, assertCurrent);
          if (
            observed.parentThreadId ||
            observed.ephemeral ||
            isNonSidebarThreadWithoutParent(observed as unknown as Record<string, unknown>)
          )
            return null;
          return yield* applyOpen(input, current, observed, assertCurrent);
        }),
      );
    }),
  });
});

export const live = Layer.effect(CodexThreadTargets, make);
