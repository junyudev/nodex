import {
  CommandId,
  ModelSelection,
  OrchestrationV2Command,
  OrchestrationV2StoredEvent,
  OrchestrationV2ThreadHistoryPage,
  OrchestrationV2ThreadShellSnapshot,
  OrchestrationV2ThreadStreamItem,
  OrchestrationV2TurnItem,
  ProjectId,
  ThreadId,
  TurnItemId,
  RunId,
  ServerProvider,
  OrchestrationV2ThreadShell,
  OrchestrationV2DomainEvent,
  PersistChatAttachmentsInput,
  PersistChatAttachmentsResult,
  ProviderInstanceConfigMap,
  OrchestrationV2Subagent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as NetAddress from "effect/net/NetAddress";
import { HttpServer } from "effect/http";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import {
  ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION,
  ProjectionStoreV2,
} from "../orchestration-v2/ProjectionStore.ts";
import * as Projects from "../project/ProjectService.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import { HostBridge } from "./HostBridge.ts";
import * as Authority from "./Authority.ts";
import * as Providers from "../provider/ProviderRegistry.ts";
import * as Configuration from "../config.ts";
import { persistChatAttachments } from "../assets/PersistChatAttachments.ts";
import * as ProviderConfiguration from "./ProviderConfiguration.ts";
import * as StorageSnapshot from "./StorageSnapshot.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import { buildBoundedThreadStreamSnapshot } from "../orchestration-v2/ThreadStream.ts";
import {
  projectDomainEventForWire,
  projectTurnItemForDetail,
} from "../orchestration-v2/WireProjection.ts";
import {
  THREAD_HISTORY_PAGE_POLICY,
  THREAD_HISTORY_SNAPSHOT_ROW_LIMIT,
} from "../orchestration-v2/threadHistoryPaging.ts";
import type {
  AgentEvent,
  AgentRuntimeIdentity,
  AgentRuntimeNotification,
  AgentRuntimeConfiguration,
} from "./Interface.ts";

const request = <Method extends string, Input extends Schema.Constraint>(
  method: Method,
  input: Input,
) => Schema.Struct({ id: Schema.String, method: Schema.Literal(method), input });
const EventType = Schema.Literals(
  OrchestrationV2DomainEvent.members.flatMap((member) => {
    const type = member.fields.type;
    return "literals" in type ? type.literals : [type.literal];
  }),
);
const AgentRequest = Schema.Union([
  request(
    "tasks.overview",
    Schema.Struct({
      threadId: ThreadId,
      activeCursor: Schema.optional(Schema.String),
      terminalCursor: Schema.optional(Schema.String),
    }),
  ),
  request("storage.snapshot.acquire", Schema.Struct({})),
  request("storage.snapshot.release", Schema.Struct({ leaseId: Schema.String })),
  request("providers.configure", Schema.Struct({ providers: ProviderInstanceConfigMap })),
  request("attachments.persist", PersistChatAttachmentsInput),
  request("thread.read", Schema.Struct({ threadId: ThreadId })),
  request("providers.read", Schema.Struct({ refresh: Schema.optional(Schema.Boolean) })),
  request("thread.authority", Schema.Struct({ threadId: ThreadId, runId: RunId })),
  request("command.dispatch", OrchestrationV2Command),
  request(
    "project.upsert",
    Schema.Struct({
      id: ProjectId,
      title: Schema.String,
      workspaceRoot: Schema.String,
      defaultModelSelection: Schema.optional(ModelSelection),
    }),
  ),
  request("project.read", Schema.Struct({ projectId: ProjectId })),
  request(
    "shell.read",
    Schema.Struct({
      projectId: Schema.optional(ProjectId),
      location: Schema.optional(Schema.Literals(["active", "archive"])),
    }),
  ),
  request("thread.snapshot", Schema.Struct({ threadId: ThreadId })),
  request(
    "thread.history",
    Schema.Struct({
      threadId: ThreadId,
      cursor: Schema.String,
      throughEntryId: Schema.optional(Schema.String),
      conversationOnly: Schema.optional(Schema.Boolean),
    }),
  ),
  request(
    "thread.item",
    Schema.Struct({
      threadId: ThreadId,
      itemId: TurnItemId,
      sourceThreadId: Schema.optional(ThreadId),
    }),
  ),
  request(
    "thread.item.full",
    Schema.Struct({
      threadId: ThreadId,
      itemId: TurnItemId,
      sourceThreadId: Schema.optional(ThreadId),
    }),
  ),
  request(
    "events.observe",
    Schema.Struct({
      threadId: Schema.optional(ThreadId),
      afterSequence: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
      eventTypes: Schema.optional(Schema.Array(EventType).check(Schema.isMaxLength(64))),
    }),
  ),
  request(
    "execution.observe",
    Schema.Struct({
      threadId: Schema.optional(ThreadId),
      afterSequence: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
    }),
  ),
  request("events.unobserve", Schema.Struct({ subscriptionId: Schema.String })),
  request("runtime.identity", Schema.Struct({})),
  request("shutdown", Schema.Struct({})),
]);
const decodeRequest = Schema.decodeUnknownEffect(Schema.toCodecJson(AgentRequest));
const encodeShell = Schema.encodeEffect(Schema.toCodecJson(OrchestrationV2ThreadShellSnapshot));
const encodeProviders = Schema.encodeEffect(Schema.toCodecJson(Schema.Array(ServerProvider)));
const encodeThreadShell = Schema.encodeEffect(
  Schema.toCodecJson(Schema.NullOr(OrchestrationV2ThreadShell)),
);
const encodeSnapshot = Schema.encodeEffect(Schema.toCodecJson(OrchestrationV2ThreadStreamItem));
const encodeHistory = Schema.encodeEffect(Schema.toCodecJson(OrchestrationV2ThreadHistoryPage));
const encodeItem = Schema.encodeEffect(Schema.toCodecJson(Schema.NullOr(OrchestrationV2TurnItem)));
const encodeEvent = Schema.encodeEffect(Schema.toCodecJson(OrchestrationV2StoredEvent));
const encodeAttachments = Schema.encodeEffect(Schema.toCodecJson(PersistChatAttachmentsResult));
const overviewFields = OrchestrationV2Subagent.fields;
const OverviewItem = Schema.Struct({
  id: overviewFields.id,
  threadId: overviewFields.threadId,
  runId: overviewFields.runId,
  parentNodeId: overviewFields.parentNodeId,
  origin: overviewFields.origin,
  driver: overviewFields.driver,
  providerInstanceId: overviewFields.providerInstanceId,
  providerThreadId: overviewFields.providerThreadId,
  childThreadId: overviewFields.childThreadId,
  title: overviewFields.title,
  model: overviewFields.model,
  modelSelection: overviewFields.modelSelection,
  status: overviewFields.status,
  startedAt: overviewFields.startedAt,
  completedAt: overviewFields.completedAt,
  updatedAt: overviewFields.updatedAt,
  childRunId: Schema.NullOr(RunId),
  resultAvailable: Schema.Boolean,
});
const OverviewPage = Schema.Struct({
  items: Schema.Array(OverviewItem),
  nextCursor: Schema.NullOr(Schema.String),
  hasMore: Schema.Boolean,
});
const encodeOverview = Schema.encodeEffect(
  Schema.toCodecJson(Schema.Struct({ active: OverviewPage, terminal: OverviewPage })),
);

/** Runtime identity is persisted by the engine and never derived from the current process ID. */
export const readIdentity = Effect.gen(function* () {
  const configuration = yield* Configuration.ServerConfig;
  const environment = yield* Environment.ServerEnvironmentIdentity;
  const server = yield* HttpServer.HttpServer;
  const eventSink = yield* EventSink.EventSinkV2;
  const bridge = yield* HostBridge;
  const mcpEndpoint = NetAddress.isInetAddress(server.address)
    ? `http://127.0.0.1:${server.address.port}/mcp`
    : "http://127.0.0.1/mcp";
  return {
    runtimeId: yield* environment.getEnvironmentId,
    runtimeGeneration: bridge.runtimeGeneration,
    schemaVersion: ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION,
    databasePath: configuration.dbPath,
    mcpEndpoint,
    lastSequence: yield* eventSink.latestSequence(),
  } satisfies AgentRuntimeIdentity;
});

/** Validates commands once at the transport boundary and only exposes bounded reads. */
export const make = Effect.fn("AgentRuntime.makeService")(function* (
  notify: (notification: AgentRuntimeNotification) => Effect.Effect<void>,
  initialProviders: AgentRuntimeConfiguration["providers"],
) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projects = yield* Projects.ProjectService;
  const projections = yield* ProjectionStoreV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const identity = yield* readIdentity;
  const providers = yield* Providers.ProviderRegistry;
  const providerConfiguration = yield* ProviderConfiguration.make(
    yield* Schema.decodeUnknownEffect(ProviderInstanceConfigMap)(initialProviders),
  );
  // SQL waiters cannot delay interruption of the lease fiber that releases their connection.
  const processScope = yield* Scope.make("parallel");
  yield* Effect.addFinalizer((exit) => Scope.close(processScope, exit));
  const storageSnapshot = yield* StorageSnapshot.make(identity, providerConfiguration).pipe(
    Effect.provideService(Scope.Scope, processScope),
  );
  const readAuthority = yield* Authority.make;
  const configuration = yield* Configuration.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const subscriptions = yield* Ref.make<ReadonlyMap<string, Fiber.Fiber<void>>>(new Map());
  const unobserve = Effect.fn("AgentRuntime.unobserve")(function* (id: string) {
    const fiber = yield* Ref.modify(subscriptions, (current) => {
      const next = new Map(current);
      next.delete(id);
      return [current.get(id), next];
    });
    if (fiber !== undefined) yield* Fiber.interrupt(fiber);
  });

  const execute = Effect.fn("AgentRuntime.executeRequest")(function* (
    input: typeof AgentRequest.Type,
  ) {
    switch (input.method) {
      case "tasks.overview":
        return yield* projections
          .getThreadSubagentOverview({
            threadId: input.input.threadId,
            ...(input.input.activeCursor === undefined
              ? {}
              : { activeCursor: input.input.activeCursor }),
            ...(input.input.terminalCursor === undefined
              ? {}
              : { terminalCursor: input.input.terminalCursor }),
          })
          .pipe(Effect.flatMap(encodeOverview));
      case "storage.snapshot.acquire":
        return yield* storageSnapshot.acquire;
      case "storage.snapshot.release":
        return yield* storageSnapshot.release(input.input.leaseId);
      case "providers.configure":
        return yield* providerConfiguration.configure(input.input.providers);
      case "attachments.persist": {
        const shell = yield* orchestrator.getThreadShell(input.input.threadId);
        if (shell === null)
          return yield* Effect.fail(new Error("The attachment target Thread does not exist."));
        const attachments = yield* persistChatAttachments(input.input).pipe(
          Effect.provideService(Configuration.ServerConfig, configuration),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        );
        return yield* encodeAttachments({ attachments });
      }
      case "thread.read":
        return yield* orchestrator
          .getThreadShell(input.input.threadId)
          .pipe(Effect.flatMap(encodeThreadShell));
      case "providers.read":
        return yield* (input.input.refresh ? providers.refresh() : providers.getProviders).pipe(
          Effect.flatMap(encodeProviders),
        );
      case "thread.authority":
        return yield* readAuthority(input.input);
      case "runtime.identity":
        return { ...identity, lastSequence: yield* eventSink.latestSequence() };
      case "shutdown":
        return { stopped: true };
      case "command.dispatch": {
        const result = yield* orchestrator.dispatch(input.input);
        return { sequence: result.sequence };
      }
      case "project.upsert": {
        const { id, ...properties } = input.input;
        const existing = yield* projects.getById(id);
        const mutation = {
          ...properties,
          projectId: id,
          commandId: CommandId.make(`host:project:${input.id}`),
        };
        if (Option.isNone(existing)) yield* projects.create(mutation);
        else yield* projects.update(mutation);
        return { id };
      }
      case "project.read": {
        const project = yield* projects.getById(input.input.projectId);
        return Option.isNone(project)
          ? null
          : {
              id: project.value.id,
              title: project.value.title,
              workspaceRoot: project.value.workspaceRoot,
            };
      }
      case "shell.read":
        return yield* orchestrator
          .getShellSnapshot({
            ...(input.input.projectId === undefined ? {} : { projectId: input.input.projectId }),
            ...(input.input.location === undefined ? {} : { location: input.input.location }),
          })
          .pipe(Effect.flatMap(encodeShell));
      case "thread.snapshot": {
        const snapshot = yield* orchestrator.getThreadSnapshotWindow(input.input.threadId, {
          rowLimit: THREAD_HISTORY_SNAPSHOT_ROW_LIMIT,
          userTurnLimit: THREAD_HISTORY_PAGE_POLICY.maxUserTurns,
        });
        return yield* encodeSnapshot(
          buildBoundedThreadStreamSnapshot({
            ...snapshot,
            compactTurnItems: true,
          }),
        );
      }
      case "thread.history":
        return yield* orchestrator
          .getThreadHistoryPage(
            input.input.threadId,
            input.input.cursor,
            input.input.throughEntryId,
            input.input.conversationOnly,
          )
          .pipe(Effect.flatMap(encodeHistory));
      case "thread.item":
        return yield* projections
          .getVisibleTurnItem({
            threadId: input.input.threadId,
            itemId: input.input.itemId,
            ...(input.input.sourceThreadId === undefined
              ? {}
              : { sourceThreadId: input.input.sourceThreadId }),
          })
          .pipe(
            Effect.map((item) => (item === null ? null : projectTurnItemForDetail(item))),
            Effect.flatMap(encodeItem),
          );
      case "thread.item.full": {
        const item = yield* projections
          .getVisibleTurnItem({
            threadId: input.input.threadId,
            itemId: input.input.itemId,
            ...(input.input.sourceThreadId === undefined
              ? {}
              : { sourceThreadId: input.input.sourceThreadId }),
          })
          .pipe(Effect.flatMap(encodeItem));
        if (new TextEncoder().encode(JSON.stringify(item)).byteLength > 15 * 1024 * 1024)
          return yield* Effect.fail(
            new Error("The full item exceeds the single-response transport budget."),
          );
        return item;
      }
      case "events.unobserve": {
        yield* unobserve(input.input.subscriptionId);
        return { unsubscribed: true };
      }
      case "execution.observe":
      case "events.observe": {
        yield* unobserve(input.id);
        const afterSequence = input.input.afterSequence ?? (yield* eventSink.latestSequence());
        const cursor = {
          afterSequence,
          ...(input.input.threadId === undefined ? {} : { threadId: input.input.threadId }),
        };
        const eventTypes =
          input.method === "execution.observe"
            ? ["run.updated", "thread.deleted"]
            : input.input.eventTypes;
        // Type-specific channels filter before retaining live events or decoding SQL replay.
        const stream =
          eventTypes === undefined
            ? orchestrator.streamStoredEventsFrom(cursor)
            : Stream.mergeAll(
                [...new Set(eventTypes)].map((eventType) =>
                  orchestrator.streamStoredEventsFrom({
                    ...cursor,
                    eventType: eventType as OrchestrationV2DomainEvent["type"],
                  }),
                ),
                { concurrency: "unbounded", bufferSize: 16 },
              );
        const fiber = yield* stream.pipe(
          Stream.runForEach((event) =>
            input.method === "execution.observe"
              ? notify({
                  type: "execution.lifecycle",
                  subscriptionId: input.id,
                  runtimeGeneration: identity.runtimeGeneration,
                  sequence: event.sequence,
                  threadId: event.event.threadId,
                  eventType: event.event.type as "run.updated" | "thread.deleted",
                  ...(event.event.type === "run.updated"
                    ? { runId: event.event.payload.id, runStatus: event.event.payload.status }
                    : {}),
                })
              : encodeEvent({
                  ...event,
                  event: projectDomainEventForWire(event.event),
                }).pipe(
                  Effect.flatMap((encoded) =>
                    notify({
                      type: "event",
                      subscriptionId: input.id,
                      event: encoded as AgentEvent,
                    }),
                  ),
                ),
          ),
          Effect.catchCause((cause) =>
            notify({
              type: "event.error",
              subscriptionId: input.id,
              message: String(cause),
            }),
          ),
          Effect.forkIn(processScope),
        );
        yield* Ref.update(subscriptions, (current) => new Map(current).set(input.id, fiber));
        return { subscribed: true, subscriptionId: input.id, afterSequence };
      }
    }
  });

  const handle = Effect.fn("AgentRuntime.handleRequest")(function* (value: unknown) {
    const input = yield* decodeRequest(value);
    // New operations participate in the writer fence unless explicitly proven read-only.
    switch (input.method) {
      case "storage.snapshot.acquire":
      case "storage.snapshot.release":
      case "thread.read":
      case "tasks.overview":
      case "thread.authority":
      case "project.read":
      case "shell.read":
      case "thread.snapshot":
      case "thread.history":
      case "thread.item":
      case "thread.item.full":
      case "events.observe":
      case "execution.observe":
      case "events.unobserve":
      case "runtime.identity":
      case "shutdown":
        return yield* execute(input);
      case "providers.read":
        if (input.input.refresh !== true) return yield* execute(input);
        return yield* storageSnapshot.withWriter(execute(input));
      default:
        return yield* storageSnapshot.withWriter(execute(input));
    }
  });
  return {
    identity,
    handle: (value: unknown) =>
      handle(value).pipe(Effect.forkIn(processScope), Effect.flatMap(Fiber.join)),
  };
});

export class AgentRuntime extends Context.Service<
  AgentRuntime,
  Effect.Success<ReturnType<typeof make>>
>()("@nodex/agent-runtime/Service") {}

export const layer = (
  notify: (notification: AgentRuntimeNotification) => Effect.Effect<void>,
  initialProviders: AgentRuntimeConfiguration["providers"],
) => Layer.effect(AgentRuntime, make(notify, initialProviders));
