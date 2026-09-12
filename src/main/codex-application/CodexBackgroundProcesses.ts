import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import type { ThreadBackgroundTerminal } from "@nodex/codex-app-server-protocol/v2/ThreadBackgroundTerminal";
import type { ClientRequestResponsesByMethod } from "@nodex/effect-codex-app-server/rpc";
import type {
  CodexConversationSnapshot,
  CodexBackgroundProcessRecord,
  CodexBackgroundProcessRow,
  CodexBackgroundProcessRunActionInput,
  TerminalRunActionRequest,
} from "../../shared/types";
import { makeCodexBackgroundProcessRecordId } from "../../shared/codex-background-processes";
import { resolveCodexElectronDisplayThreadTitle } from "../../shared/codex-thread-title";
import { buildCodexBackgroundProcessRow } from "../codex/background-process-rows";
import type { ProjectWorkspaceReadSnapshot } from "../core-client/types";
import { CoreModules } from "../core-runtime/CoreModules";
import { createOperationId } from "../core-runtime/operation-identity";
import { ProjectRuntimeLifecycleRuntime } from "../host-runtime/ProjectRuntimeLifecycleRuntime";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { TerminalSessions, type TerminalOwner } from "../terminal-runtime/TerminalSessions";
import { CodexThreadDirectory, type CodexThreadDirectoryEntry } from "./CodexThreadDirectory";
import { ConversationEntityMap } from "./internal/ConversationEntityMap";

interface CodexBackgroundProcessConversationProjection {
  readonly threadTitle: string | null;
  readonly terminalItems: readonly {
    readonly itemId: string;
    readonly processId: string | null;
    readonly turnId: string | null;
    readonly createdAt: number;
  }[];
}

export class CodexBackgroundProcessesError extends Data.TaggedError(
  "CodexBackgroundProcessesError",
)<{
  readonly operation: "list" | "run-action";
  readonly cause: unknown;
}> {}

export class CodexBackgroundProcesses extends Context.Service<
  CodexBackgroundProcesses,
  {
    readonly list: (input: {
      readonly threadId: string;
      readonly observedTerminals?: readonly ThreadBackgroundTerminal[];
    }) => Effect.Effect<CodexBackgroundProcessRow[], CodexBackgroundProcessesError>;
    readonly runAction: (input: {
      readonly action: CodexBackgroundProcessRunActionInput;
      readonly owner: TerminalOwner;
    }) => Effect.Effect<CodexBackgroundProcessRow[], CodexBackgroundProcessesError>;
  }
>()("nodex/main/codex-application/CodexBackgroundProcesses") {}

interface NormalizedRunAction {
  readonly threadId: string;
  readonly threadTitle: string | null;
  readonly itemId: string;
  readonly turnId: string | null;
  readonly command: string;
  readonly cwd: string;
  readonly terminalSessionId: string;
}

const normalizeRunAction = (input: CodexBackgroundProcessRunActionInput): NormalizedRunAction => {
  const action = {
    threadId: input.threadId.trim(),
    threadTitle: input.threadTitle?.trim() || null,
    itemId: input.itemId.trim(),
    turnId: input.turnId?.trim() || null,
    command: input.command.trim(),
    cwd: input.cwd.trim(),
    terminalSessionId: input.terminalSessionId.trim(),
  };
  if (
    !action.threadId ||
    !action.itemId ||
    !action.command ||
    !action.cwd ||
    !action.terminalSessionId
  ) {
    throw new Error("Background process action requires thread, item, command, cwd, and terminal");
  }
  return action;
};

const terminalRequest = (action: NormalizedRunAction): TerminalRunActionRequest => ({
  sessionId: action.terminalSessionId,
  conversationId: action.threadId,
  cwd: action.cwd,
  command: action.command,
  title: action.command,
});

type GatewayTerminal =
  ClientRequestResponsesByMethod["thread/backgroundTerminals/list"]["data"][number];

const projectGatewayTerminal = (terminal: GatewayTerminal): ThreadBackgroundTerminal => ({
  itemId: terminal.itemId,
  processId: terminal.processId,
  command: terminal.command,
  cwd: terminal.cwd,
  osPid: terminal.osPid ?? null,
  cpuPercent: terminal.cpuPercent ?? null,
  rssKb: terminal.rssKb == null ? null : BigInt(Math.trunc(terminal.rssKb)),
});

type CoreBackgroundProcess = Extract<
  ProjectWorkspaceReadSnapshot["value"],
  { readonly kind: "background_process_window" }
>["processes"]["items"][number];

const projectCoreBackgroundProcess = (
  record: CoreBackgroundProcess,
): CodexBackgroundProcessRecord => ({
  id: record.id,
  threadId: record.thread_id,
  threadTitle: record.thread_title ?? null,
  itemId: record.item_id,
  turnId: record.turn_id ?? null,
  command: record.command,
  cwd: record.cwd ?? null,
  processId: record.process_id ?? null,
  osPid: record.os_pid ?? null,
  terminalSessionId: record.terminal_session_id ?? null,
  source: record.source,
  startedAtMs: record.started_at_ms,
  updatedAtMs: record.updated_at_ms,
});

const projectConversation = (
  entry: CodexThreadDirectoryEntry,
): CodexBackgroundProcessConversationProjection => {
  const conversation: CodexConversationSnapshot | null = entry.snapshot;
  const threadName = conversation?.threadName?.trim()
    ? conversation.threadName
    : entry.durable.threadName;
  const threadPreview = conversation?.threadPreview?.trim()
    ? conversation.threadPreview
    : entry.durable.threadPreview;
  return {
    threadTitle:
      resolveCodexElectronDisplayThreadTitle({
        threadName,
        threadPreview,
        fallback: "",
      }) || null,
    terminalItems:
      conversation?.turns.flatMap((turn) =>
        turn.items.flatMap((item) =>
          item.kind === "commandExecution"
            ? [
                {
                  itemId: item.itemId,
                  processId:
                    item.processId === null || item.processId === undefined
                      ? null
                      : String(item.processId),
                  turnId: item.turnId,
                  createdAt: item.createdAt,
                },
              ]
            : [],
        ),
      ) ?? [],
  };
};

export const make: Effect.Effect<
  CodexBackgroundProcesses["Service"],
  never,
  | CodexGateway
  | CodexThreadDirectory
  | ConversationEntityMap
  | CoreModules
  | ProjectRuntimeLifecycleRuntime
  | Scope.Scope
  | TerminalSessions
> = Effect.gen(function* () {
  const gateway = yield* CodexGateway;
  const directory = yield* CodexThreadDirectory;
  const conversations = yield* ConversationEntityMap;
  const core = yield* CoreModules;
  const projectLifecycle = yield* ProjectRuntimeLifecycleRuntime;
  const terminals = yield* TerminalSessions;
  const ownerScope = yield* Scope.Scope;

  const fail = (
    operation: CodexBackgroundProcessesError["operation"],
    cause: unknown,
  ): CodexBackgroundProcessesError => new CodexBackgroundProcessesError({ operation, cause });
  const runOwned = <A, E>(operation: Effect.Effect<A, E>): Effect.Effect<A, E> =>
    Effect.acquireUseRelease(
      operation.pipe(Effect.forkIn(ownerScope, { startImmediately: true })),
      Fiber.join,
      Fiber.interrupt,
    );
  const runThreadOwned = <A, E>(
    threadId: string,
    operation: Effect.Effect<A, E>,
  ): Effect.Effect<A, E> => runOwned(conversations.runCommand(threadId, operation));
  const readThread = (
    operation: CodexBackgroundProcessesError["operation"],
    threadId: string,
  ): Effect.Effect<CodexThreadDirectoryEntry, CodexBackgroundProcessesError> =>
    directory.resolve({ threadId, fidelity: "durable" }).pipe(
      Effect.mapError((cause) => fail(operation, cause)),
      Effect.flatMap((entry) =>
        entry
          ? Effect.succeed(entry)
          : Effect.fail(fail(operation, new Error("Unknown Codex Thread"))),
      ),
    );

  const listRegistered = Effect.fn("CodexBackgroundProcesses.listRegistered")(function* (
    operation: CodexBackgroundProcessesError["operation"],
    threadId: string,
  ): Effect.fn.Return<readonly CodexBackgroundProcessRecord[], CodexBackgroundProcessesError> {
    const records: CodexBackgroundProcessRecord[] = [];
    const seen = new Set<string>();
    let cursor: string | null = null;
    do {
      const snapshot: ProjectWorkspaceReadSnapshot = yield* core.workspace
        .read({
          kind: "background_process_window",
          thread_id: threadId,
          window: { after: cursor, first: 200 },
        })
        .pipe(Effect.mapError((cause) => fail(operation, cause)));
      if (snapshot.value.kind !== "background_process_window") {
        return yield* fail(
          operation,
          new Error("Core returned the wrong background-process read variant"),
        );
      }
      records.push(...snapshot.value.processes.items.map(projectCoreBackgroundProcess));
      const next: string | null = snapshot.value.processes.next_cursor ?? null;
      if (!next || seen.has(next)) return records;
      seen.add(next);
      cursor = next;
    } while (cursor);
    return records;
  });

  const persist = (
    operation: CodexBackgroundProcessesError["operation"],
    record: CodexBackgroundProcessRecord,
    preserveStartedAt = true,
  ): Effect.Effect<void, CodexBackgroundProcessesError> =>
    core.workspace
      .apply({
        operationId: createOperationId("background-process.update"),
        intent: {
          kind: "upsert_background_process",
          process: {
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
          },
          preserve_started_at: preserveStartedAt,
        },
      })
      .pipe(
        Effect.mapError((cause) => fail(operation, cause)),
        Effect.asVoid,
      );

  const listLiveTerminals = (
    threadId: string,
    cursor: string | null = null,
    collected: readonly ThreadBackgroundTerminal[] = [],
  ): Effect.Effect<readonly ThreadBackgroundTerminal[]> =>
    gateway
      .requestForThread(threadId, "thread/backgroundTerminals/list", {
        threadId,
        cursor,
        limit: 100,
      })
      .pipe(
        Effect.flatMap((response) => {
          const next = [...collected, ...response.data.map(projectGatewayTerminal)];
          return response.nextCursor
            ? listLiveTerminals(threadId, response.nextCursor, next)
            : Effect.succeed(next);
        }),
        Effect.catch((cause) =>
          Effect.logWarning(
            "Falling back to registered background processes without live terminal snapshots",
          ).pipe(
            Effect.annotateLogs({ threadId, errorTag: cause._tag }),
            Effect.as<readonly ThreadBackgroundTerminal[]>([]),
          ),
        ),
      );

  const observe = (
    operation: CodexBackgroundProcessesError["operation"],
    threadId: string,
    thread: CodexThreadDirectoryEntry,
    observed: readonly ThreadBackgroundTerminal[],
  ): Effect.Effect<void, CodexBackgroundProcessesError> => {
    if (observed.length === 0) return Effect.void;
    return Effect.gen(function* () {
      const projection = projectConversation(thread);
      const itemByTerminalKey = new Map<
        string,
        CodexBackgroundProcessConversationProjection["terminalItems"][number]
      >();
      for (const item of projection.terminalItems) {
        itemByTerminalKey.set(item.itemId, item);
        if (item.processId) itemByTerminalKey.set(item.processId, item);
      }

      const now = yield* Clock.currentTimeMillis;
      yield* Effect.forEach(
        observed,
        (terminal) => {
          const command = terminal.command.trim();
          if (!command) return Effect.void;
          const item =
            itemByTerminalKey.get(terminal.itemId) ??
            itemByTerminalKey.get(String(terminal.processId));
          return persist(operation, {
            id: makeCodexBackgroundProcessRecordId({
              threadId,
              itemId: terminal.itemId,
            }),
            threadId,
            threadTitle: projection.threadTitle,
            itemId: terminal.itemId,
            turnId: item?.turnId ?? null,
            command,
            cwd: terminal.cwd,
            processId: terminal.processId.trim() || null,
            osPid: terminal.osPid,
            terminalSessionId: null,
            source: "app-server",
            startedAtMs: item?.createdAt ?? now,
            updatedAtMs: now,
          });
        },
        { discard: true },
      );
    });
  };

  const buildRows = (
    operation: CodexBackgroundProcessesError["operation"],
    threadId: string,
    observed: readonly ThreadBackgroundTerminal[],
  ): Effect.Effect<CodexBackgroundProcessRow[], CodexBackgroundProcessesError> =>
    Effect.gen(function* () {
      const records = yield* listRegistered(operation, threadId);
      const terminalSessionIds = records
        .map((record) => record.terminalSessionId)
        .filter((sessionId): sessionId is string => sessionId !== null);
      yield* terminals.refreshSessionProcessMetrics(terminalSessionIds);

      const observedByRecordId = new Map<string, ThreadBackgroundTerminal>();
      for (const terminal of observed) {
        observedByRecordId.set(
          makeCodexBackgroundProcessRecordId({ threadId, itemId: terminal.itemId }),
          terminal,
        );
      }
      return yield* Effect.forEach(
        records,
        (record) =>
          (record.terminalSessionId
            ? terminals.getSessionSnapshot(record.terminalSessionId)
            : Effect.succeed(null)
          ).pipe(
            Effect.map((terminalSession) =>
              buildCodexBackgroundProcessRow({
                record,
                terminal: observedByRecordId.get(record.id) ?? null,
                terminalSession,
              }),
            ),
          ),
        { concurrency: "unbounded" },
      );
    });

  const list = (input: {
    readonly threadId: string;
    readonly observedTerminals?: readonly ThreadBackgroundTerminal[];
  }): Effect.Effect<CodexBackgroundProcessRow[], CodexBackgroundProcessesError> => {
    const threadId = input.threadId.trim();
    if (!threadId) return Effect.succeed([]);
    return readThread("list", threadId).pipe(
      Effect.flatMap((thread) =>
        runThreadOwned(
          threadId,
          Effect.gen(function* () {
            const observed = input.observedTerminals ?? (yield* listLiveTerminals(threadId));
            yield* observe("list", threadId, thread, observed);
            return yield* buildRows("list", threadId, observed);
          }),
        ),
      ),
    );
  };

  const verifyAdmission = (
    operation: CodexBackgroundProcessesError["operation"],
    thread: CodexThreadDirectoryEntry,
  ): Effect.Effect<
    { readonly projectId: string | null; readonly thread: CodexThreadDirectoryEntry },
    CodexBackgroundProcessesError
  > =>
    Effect.gen(function* () {
      const projectId = thread.durable.projectId;
      if (!projectId) return { projectId: null, thread };
      const project = yield* core.workspace
        .read({ kind: "project", project_id: projectId }, undefined, projectId)
        .pipe(Effect.mapError((cause) => fail(operation, cause)));
      if (project.value.kind === "project" && project.value.project.lifecycle === "active") {
        return { projectId, thread };
      }
      return yield* Effect.fail(
        fail(operation, new Error("Terminals require an active Project owner")),
      );
    });

  const readAdmission = (
    operation: CodexBackgroundProcessesError["operation"],
    threadId: string,
  ): Effect.Effect<
    { readonly projectId: string | null; readonly thread: CodexThreadDirectoryEntry },
    CodexBackgroundProcessesError
  > =>
    readThread(operation, threadId).pipe(
      Effect.flatMap((thread) => verifyAdmission(operation, thread)),
    );

  const register = (
    action: NormalizedRunAction,
    thread: CodexThreadDirectoryEntry,
  ): Effect.Effect<void, CodexBackgroundProcessesError> =>
    Clock.currentTimeMillis.pipe(
      Effect.flatMap((now) => {
        const projection = projectConversation(thread);
        return persist(
          "run-action",
          {
            id: makeCodexBackgroundProcessRecordId({
              threadId: action.threadId,
              itemId: action.itemId,
            }),
            threadId: action.threadId,
            threadTitle: action.threadTitle ?? projection.threadTitle,
            itemId: action.itemId,
            turnId: action.turnId,
            command: action.command,
            cwd: action.cwd,
            processId: null,
            osPid: null,
            terminalSessionId: action.terminalSessionId,
            source: "terminal-action",
            startedAtMs: now,
            updatedAtMs: now,
          },
          false,
        );
      }),
    );

  return CodexBackgroundProcesses.of({
    list,
    runAction: ({ action: rawAction, owner }) =>
      Effect.try({
        try: () => normalizeRunAction(rawAction),
        catch: (cause) => fail("run-action", cause),
      }).pipe(
        Effect.flatMap((action) =>
          readAdmission("run-action", action.threadId).pipe(
            Effect.flatMap((initial) =>
              runThreadOwned(
                action.threadId,
                Effect.gen(function* () {
                  yield* projectLifecycle.runExclusive(
                    initial.projectId,
                    Effect.gen(function* () {
                      const admitted = yield* verifyAdmission("run-action", initial.thread);
                      yield* register(action, admitted.thread);
                      yield* terminals
                        .runAction(owner, terminalRequest(action))
                        .pipe(Effect.mapError((cause) => fail("run-action", cause)));
                    }),
                  );
                  return yield* buildRows("run-action", action.threadId, []);
                }),
              ),
            ),
          ),
        ),
      ),
  });
});
