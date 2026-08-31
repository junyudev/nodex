import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { assert, it } from "@effect/vitest";
import type {
  CodexBackgroundProcessRecord,
  CodexConversationSnapshot,
  TerminalSessionSnapshot,
} from "../../shared/types";
import type {
  ProjectWorkspaceApplyInput,
  ProjectWorkspaceApplyResult,
  ProjectWorkspaceReadSnapshot,
} from "../core-client/types";
import { CoreModules } from "../core-runtime/CoreModules";
import { ProjectRuntimeLifecycleRuntime } from "../host-runtime/ProjectRuntimeLifecycleRuntime";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { TerminalSessions } from "../terminal-runtime/TerminalSessions";
import { make } from "./CodexBackgroundProcesses";
import { CodexThreadDirectory, type CodexThreadDirectoryEntry } from "./CodexThreadDirectory";
import { ConversationEntityMap } from "./internal/ConversationEntityMap";

const terminalSessions = (
  overrides: Partial<TerminalSessions["Service"]> = {},
): TerminalSessions["Service"] =>
  TerminalSessions.of({
    refreshSessionProcessMetrics: () => Effect.void,
    getSessionSnapshot: () => Effect.succeed(null),
    runAction: () => Effect.void,
    ...overrides,
  } as unknown as TerminalSessions["Service"]);

const gateway = (
  requestForThread: CodexGateway["Service"]["requestForThread"],
): CodexGateway["Service"] => {
  const unsupported = () => Effect.die(new Error("Unsupported test operation"));
  return CodexGateway.of({
    localHostId: "local",
    requestRawOnHost: () => Effect.die(new Error("Unsupported raw host request")),
    requestRawForThread: () => Effect.die(new Error("Unsupported raw request")),
    events: Stream.empty,
    requestLocal: unsupported,
    requestOnHost: unsupported,
    requestForThread,
    notifyLocal: unsupported,
    connection: () => unsupported(),
    connectionChanges: () => Stream.empty,
    awaitReady: () => Effect.void,
    reconcileHost: unsupported,
    removeHost: unsupported,
    restartHost: unsupported,
  });
};

interface TerminalItem {
  readonly itemId: string;
  readonly processId: string | null;
  readonly turnId: string;
  readonly createdAt: number;
}

const directoryEntry = (input: {
  readonly threadId: string;
  readonly projectId: string | null;
  readonly title: string | null;
  readonly terminalItems?: readonly TerminalItem[];
}): CodexThreadDirectoryEntry => ({
  fidelity: "durable",
  historyMode: null,
  durable: {
    threadId: input.threadId,
    projectId: input.projectId,
    threadName: input.title,
    threadPreview: input.title ?? "",
  } as CodexThreadDirectoryEntry["durable"],
  summary: { threadId: input.threadId } as CodexThreadDirectoryEntry["summary"],
  canonical: null,
  snapshot: {
    threadId: input.threadId,
    threadName: input.title,
    threadPreview: input.title ?? "",
    turns: [
      {
        turnId: input.terminalItems?.[0]?.turnId ?? "turn-a",
        items:
          input.terminalItems?.map((item) => ({
            kind: "commandExecution",
            itemId: item.itemId,
            processId: item.processId,
            turnId: item.turnId,
            createdAt: item.createdAt,
          })) ?? [],
      },
    ],
  } as CodexConversationSnapshot,
});

const directory = (
  entry: CodexThreadDirectoryEntry,
  events: string[] = [],
): CodexThreadDirectory["Service"] => {
  const unsupported = () => Effect.die(new Error("Unsupported test operation"));
  return CodexThreadDirectory.of({
    resolve: ({ threadId }: Parameters<CodexThreadDirectory["Service"]["resolve"]>[0]) =>
      Effect.sync(() => {
        events.push(`thread:${threadId}`);
        return threadId === entry.durable.threadId ? entry : null;
      }),
    acceptRollbackResult: unsupported,
    acceptForkResult: unsupported,
    observeMetadata: () => Effect.die("unused"),
    acceptStandaloneStart: () => Effect.die("unused"),
    acceptResumeResult: () => Effect.die("unused"),
    acceptSessionStart: unsupported,
  } as unknown as CodexThreadDirectory["Service"]);
};

const conversationRuntimeMap = (events: string[] = []): ConversationEntityMap["Service"] => {
  const runCommand: ConversationEntityMap["Service"]["runCommand"] = (threadId, operation) =>
    Effect.sync(() => events.push(`lane:${threadId}:open`)).pipe(
      Effect.andThen(operation),
      Effect.ensuring(Effect.sync(() => events.push(`lane:${threadId}:close`))),
    );
  return ConversationEntityMap.of({
    runCommand,
  } as unknown as ConversationEntityMap["Service"]);
};

const fromCoreRecord = (
  process: Extract<
    ProjectWorkspaceApplyInput["intent"],
    { readonly kind: "upsert_background_process" }
  >["process"],
): CodexBackgroundProcessRecord => ({
  id: process.id,
  threadId: process.thread_id,
  threadTitle: process.thread_title ?? null,
  itemId: process.item_id,
  turnId: process.turn_id ?? null,
  command: process.command,
  cwd: process.cwd ?? null,
  processId: process.process_id ?? null,
  osPid: process.os_pid ?? null,
  terminalSessionId: process.terminal_session_id ?? null,
  source: process.source,
  startedAtMs: process.started_at_ms,
  updatedAtMs: process.updated_at_ms,
});

const toCoreRecord = (record: CodexBackgroundProcessRecord) => ({
  id: record.id,
  thread_id: record.threadId,
  thread_title: record.threadTitle,
  item_id: record.itemId,
  turn_id: record.turnId,
  command: record.command,
  cwd: record.cwd,
  process_id: record.processId,
  os_pid: record.osPid,
  terminal_session_id: record.terminalSessionId,
  source: record.source,
  started_at_ms: record.startedAtMs,
  updated_at_ms: record.updatedAtMs,
});

const coreModules = (input: {
  readonly records: CodexBackgroundProcessRecord[];
  readonly events?: string[];
  readonly pageSize?: number;
}): CoreModules["Service"] => {
  const events = input.events ?? [];
  const pageSize = input.pageSize ?? 200;
  return CoreModules.of({
    workspace: {
      read: (read: Parameters<CoreModules["Service"]["workspace"]["read"]>[0]) => {
        if (read.kind === "project") {
          events.push(`project:${read.project_id}`);
          return Effect.succeed({
            value: {
              kind: "project",
              project: { project_id: read.project_id, lifecycle: "active" },
            },
          } as unknown as ProjectWorkspaceReadSnapshot);
        }
        if (read.kind === "background_process_window") {
          const candidates = input.records.filter(
            (record) => record.threadId === (read.thread_id ?? null),
          );
          const after = read.window.after;
          const start = after
            ? Math.max(0, candidates.findIndex((record) => record.id === after) + 1)
            : 0;
          const page = candidates.slice(start, start + pageSize);
          return Effect.succeed({
            value: {
              kind: "background_process_window",
              processes: {
                items: page.map(toCoreRecord),
                next_cursor:
                  start + page.length < candidates.length ? (page.at(-1)?.id ?? null) : null,
              },
            },
          } as unknown as ProjectWorkspaceReadSnapshot);
        }
        return Effect.die(new Error(`Unsupported Core read '${read.kind}'`));
      },
      apply: (apply: ProjectWorkspaceApplyInput) => {
        const intent = apply.intent;
        if (intent.kind !== "upsert_background_process") {
          return Effect.die(new Error(`Unsupported Core apply '${intent.kind}'`));
        }
        return Effect.sync(() => {
          const next = fromCoreRecord(intent.process);
          const index = input.records.findIndex((record) => record.id === next.id);
          const previous = input.records[index];
          const accepted =
            intent.preserve_started_at !== false && previous
              ? { ...next, startedAtMs: previous.startedAtMs }
              : next;
          if (index === -1) input.records.push(accepted);
          else input.records[index] = accepted;
          events.push(`record:${accepted.itemId}`);
          return {} as unknown as ProjectWorkspaceApplyResult;
        });
      },
    },
  } as unknown as CoreModules["Service"]);
};

const makeService = (
  scope: Scope.Closeable,
  services: {
    readonly core: CoreModules["Service"];
    readonly directory: CodexThreadDirectory["Service"];
    readonly gateway: CodexGateway["Service"];
    readonly conversations?: ConversationEntityMap["Service"];
    readonly terminals?: TerminalSessions["Service"];
    readonly lifecycle?: ProjectRuntimeLifecycleRuntime["Service"];
  },
) =>
  make.pipe(
    Effect.provideService(CodexGateway, services.gateway),
    Effect.provideService(CodexThreadDirectory, services.directory),
    Effect.provideService(
      ConversationEntityMap,
      services.conversations ?? conversationRuntimeMap(),
    ),
    Effect.provideService(CoreModules, services.core),
    Effect.provideService(
      ProjectRuntimeLifecycleRuntime,
      services.lifecycle ??
        ProjectRuntimeLifecycleRuntime.of({ runExclusive: (_projectId, operation) => operation }),
    ),
    Effect.provideService(Scope.Scope, scope),
    Effect.provideService(TerminalSessions, services.terminals ?? terminalSessions()),
  );

it.effect("joins paged live terminals with the canonical Thread and durable catalog", () =>
  Effect.gen(function* () {
    const records: CodexBackgroundProcessRecord[] = [];
    const cursors: Array<string | null> = [];
    const scope = yield* Scope.make();
    const entry = directoryEntry({
      threadId: "thread-a",
      projectId: null,
      title: "Build release",
      terminalItems: [
        { itemId: "item-b", processId: "process-b", turnId: "turn-b", createdAt: 42 },
      ],
    });
    const service = yield* makeService(scope, {
      core: coreModules({ records, pageSize: 1 }),
      directory: directory(entry),
      gateway: gateway(((_threadId: string, method: string, params: unknown) => {
        assert.strictEqual(method, "thread/backgroundTerminals/list");
        const cursor = (params as { readonly cursor?: string | null }).cursor ?? null;
        cursors.push(cursor);
        return Effect.succeed({
          data: [
            {
              itemId: cursor === null ? "item-a" : "item-b",
              processId: cursor === null ? "process-a" : "process-b",
              command: cursor === null ? "vp run dev" : "vp run test",
              cwd: "/repo",
              osPid: cursor === null ? 101 : 202,
              cpuPercent: null,
              rssKb: cursor === null ? 1024 : 2048,
            },
          ],
          nextCursor: cursor === null ? "page-2" : null,
        });
      }) as CodexGateway["Service"]["requestForThread"]),
    });

    const rows = yield* service.list({ threadId: " thread-a " });

    assert.deepEqual(cursors, [null, "page-2"]);
    assert.deepEqual(
      rows.map(({ itemId, status }) => ({ itemId, status })),
      [
        { itemId: "item-a", status: "running" },
        { itemId: "item-b", status: "running" },
      ],
    );
    assert.strictEqual(rows[1]?.threadTitle, "Build release");
    assert.strictEqual(rows[1]?.turnId, "turn-b");
    assert.strictEqual(rows[1]?.startedAtMs, 42);
    assert.strictEqual(rows[1]?.terminal?.rssKb, 2048n);

    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("admits, persists, and launches a local terminal action as one semantic command", () =>
  Effect.gen(function* () {
    const events: string[] = [];
    const records: CodexBackgroundProcessRecord[] = [];
    const scope = yield* Scope.make();
    const entry = directoryEntry({
      threadId: "thread-a",
      projectId: "project-a",
      title: "Projected title",
    });
    const service = yield* makeService(scope, {
      core: coreModules({ records, events }),
      directory: directory(entry, events),
      conversations: conversationRuntimeMap(events),
      gateway: gateway((() => Effect.die("unused")) as CodexGateway["Service"]["requestForThread"]),
      lifecycle: ProjectRuntimeLifecycleRuntime.of({
        runExclusive: (projectId, operation) =>
          Effect.sync(() => events.push(`gate:${projectId}:open`)).pipe(
            Effect.andThen(operation),
            Effect.ensuring(Effect.sync(() => events.push(`gate:${projectId}:close`))),
          ),
      }),
      terminals: terminalSessions({
        runAction: (_owner, request) =>
          Effect.sync(() => events.push(`terminal:${request.sessionId}`)),
        getSessionSnapshot: (sessionId) =>
          Effect.succeed({
            sessionId,
            exited: false,
            osPid: 303,
            processMetricsSampledAtMs: null,
            childProcessCount: null,
          } as unknown as TerminalSessionSnapshot),
      }),
    });

    const rows = yield* service.runAction({
      owner: { webContentsId: 7, windowSessionId: "window-a" },
      action: {
        threadId: "thread-a",
        itemId: "item-a",
        command: "vp run test",
        cwd: "/repo",
        terminalSessionId: "terminal-a",
      },
    });

    assert.deepEqual(events, [
      "thread:thread-a",
      "project:project-a",
      "lane:thread-a:open",
      "gate:project-a:open",
      "project:project-a",
      "record:item-a",
      "terminal:terminal-a",
      "gate:project-a:close",
      "lane:thread-a:close",
    ]);
    assert.strictEqual(rows[0]?.threadTitle, "Projected title");
    assert.strictEqual(rows[0]?.status, "running");
    assert.strictEqual(rows[0]?.osPid, 303);

    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("interrupts an admitted terminal action when the owning Main Scope closes", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const interrupted = yield* Deferred.make<void>();
    const scope = yield* Scope.make();
    const records: CodexBackgroundProcessRecord[] = [];
    const entry = directoryEntry({
      threadId: "thread-a",
      projectId: "project-a",
      title: null,
    });
    const service = yield* makeService(scope, {
      core: coreModules({ records }),
      directory: directory(entry),
      gateway: gateway((() => Effect.die("unused")) as CodexGateway["Service"]["requestForThread"]),
      terminals: terminalSessions({
        runAction: () =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
          ),
      }),
    });
    const caller = yield* Effect.forkChild(
      service.runAction({
        owner: { webContentsId: 7, windowSessionId: "window-a" },
        action: {
          threadId: "thread-a",
          itemId: "item-a",
          command: "vp run test",
          cwd: "/repo",
          terminalSessionId: "terminal-a",
        },
      }),
    );

    yield* Deferred.await(started);
    yield* Scope.close(scope, Exit.void);
    yield* Deferred.await(interrupted);
    const exit = yield* Fiber.await(caller);
    assert.isTrue(Exit.isFailure(exit));
    if (Exit.isFailure(exit)) assert.isTrue(Cause.hasInterruptsOnly(exit.cause));
  }),
);
