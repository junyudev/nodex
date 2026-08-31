import type { ThreadItem, Turn } from "@nodex/codex-app-server-protocol/v2";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type {
  CodexConversationSnapshot,
  CodexConversationTurn,
  CodexTranscriptEntry,
} from "../../shared/types";
import { getCodexFileChangeList } from "../../shared/codex-file-change";
import {
  CODEX_APP_READ_THREAD_DEFAULT_MAX_OUTPUT_CHARS,
  CODEX_APP_READ_THREAD_DEFAULT_TURN_LIMIT,
  CODEX_APP_READ_THREAD_MAX_OUTPUT_CHARS,
  CODEX_APP_READ_THREAD_MAX_TURN_LIMIT,
} from "../codex/codex-app-meta-thread-tools";
import { CodexAppServerCapabilities } from "../codex-runtime/CodexAppServerCapabilities";
import { CODEX_HISTORY_TURN_PAGE_SIZE, CodexHistoryPageAdapter } from "./CodexHistoryPageAdapter";
import { CodexThreadDirectory } from "./CodexThreadDirectory";

const CURSOR_RETENTION_MS = 10 * 60 * 1_000;
const MAX_RETAINED_CURSORS = 512;

interface ReadThreadCursorEntry {
  readonly threadId: string;
  readonly publicCursor: string;
  readonly appServerCursor: string;
  readonly hostId: string;
  readonly hostGeneration: number;
  readonly expiresAtMs: number;
}

export interface CodexReadThreadHistoryInput {
  readonly threadId: string;
  readonly cursor?: string | null;
  readonly turnLimit?: number | null;
  readonly includeOutputs?: boolean;
  readonly maxOutputCharsPerItem?: number | null;
}

export interface CodexReadThreadHistoryResult {
  readonly schemaVersion: 1;
  readonly thread: {
    readonly id: string;
    readonly hostId: string;
    readonly title: string | null;
    readonly preview: string;
    readonly status: {
      readonly type: string;
      readonly activeFlags?: readonly string[];
    };
    readonly cwd: string | null;
    readonly createdAt: number;
    readonly updatedAt: number;
  };
  readonly page: {
    readonly order: "newest_first";
    readonly limit: number;
    readonly nextCursor: string | null;
    readonly hasMore: boolean;
  };
  readonly turns: readonly Record<string, unknown>[];
}

export class CodexReadThreadHistoryError extends Data.TaggedError("CodexReadThreadHistoryError")<{
  readonly threadId: string;
  readonly reason: "thread-missing" | "snapshot-missing" | "unknown-cursor" | "request-failed";
  readonly cause: unknown;
}> {}

export class CodexReadThreadHistory extends Context.Service<
  CodexReadThreadHistory,
  {
    readonly read: (
      input: CodexReadThreadHistoryInput,
    ) => Effect.Effect<CodexReadThreadHistoryResult, CodexReadThreadHistoryError>;
  }
>()("nodex/main/codex-application/CodexReadThreadHistory") {}

const boundedInteger = (
  value: number | null | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number =>
  typeof value === "number" && Number.isInteger(value)
    ? Math.min(maximum, Math.max(minimum, value))
    : fallback;

const truncate = (value: string, maxChars: number): string => {
  if (maxChars <= 0) return "";
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 3))}...`;
};

const userInputText = (item: Extract<ThreadItem, { readonly type: "userMessage" }>): string =>
  item.content.flatMap((input) => (input.type === "text" ? [input.text] : [])).join("\n");

export function serializeCodexReadThreadProtocolItem(
  item: ThreadItem,
  includeOutputs: boolean,
  maxOutputCharsPerItem: number,
): Record<string, unknown> {
  switch (item.type) {
    case "userMessage":
      return {
        type: item.type,
        id: item.id,
        text: truncate(userInputText(item), maxOutputCharsPerItem),
      };
    case "agentMessage":
      return {
        type: item.type,
        id: item.id,
        text: truncate(item.text, maxOutputCharsPerItem),
        phase: item.phase,
      };
    case "reasoning":
      return {
        type: item.type,
        id: item.id,
        summary: truncate(item.summary.join("\n"), maxOutputCharsPerItem),
        ...(includeOutputs
          ? { content: truncate(item.content.join("\n"), maxOutputCharsPerItem) }
          : {}),
      };
    case "commandExecution":
      return {
        type: item.type,
        id: item.id,
        command: item.command,
        cwd: item.cwd,
        status: item.status,
        exitCode: item.exitCode,
        durationMs: item.durationMs,
        ...(includeOutputs && item.aggregatedOutput !== null
          ? { output: truncate(item.aggregatedOutput, maxOutputCharsPerItem) }
          : {}),
      };
    case "fileChange":
      return {
        type: item.type,
        id: item.id,
        status: item.status,
        changes: item.changes.map((change) => ({
          path: change.path,
          kind: change.kind,
          ...(includeOutputs ? { diff: truncate(change.diff, maxOutputCharsPerItem) } : {}),
        })),
      };
    case "plan":
      return {
        type: item.type,
        id: item.id,
        text: truncate(item.text, maxOutputCharsPerItem),
      };
    default:
      return {
        type: item.type,
        id: "id" in item ? item.id : null,
        status: "status" in item ? item.status : null,
        text: "text" in item ? truncate(String(item.text), maxOutputCharsPerItem) : null,
      };
  }
}

export function serializeCodexReadThreadResidentItem(
  item: CodexTranscriptEntry,
  includeOutputs: boolean,
  maxOutputCharsPerItem: number,
): Record<string, unknown> {
  if (item.semanticKind === "userMessage" || item.kind === "userMessage") {
    return {
      type: "userMessage",
      id: item.itemId,
      text: truncate(item.markdownText ?? "", maxOutputCharsPerItem),
    };
  }
  if (item.semanticKind === "assistantMessage" || item.kind === "assistantMessage") {
    return {
      type: "agentMessage",
      id: item.itemId,
      text: truncate(item.markdownText ?? "", maxOutputCharsPerItem),
      phase: item.assistantPhase ?? null,
    };
  }
  if (item.semanticKind === "reasoning") {
    return {
      type: "reasoning",
      id: item.itemId,
      summary: truncate(item.markdownText ?? "", maxOutputCharsPerItem),
      ...(includeOutputs
        ? { content: truncate(item.markdownText ?? "", maxOutputCharsPerItem) }
        : {}),
    };
  }
  if (item.kind === "commandExecution") {
    return {
      type: item.kind,
      id: item.itemId,
      command: item.command ?? null,
      cwd: item.cwd ?? null,
      status: item.status ?? null,
      exitCode: item.exitCode ?? null,
      durationMs: item.durationMs ?? null,
      ...(includeOutputs && item.aggregatedOutput != null
        ? { output: truncate(item.aggregatedOutput, maxOutputCharsPerItem) }
        : {}),
    };
  }
  if (item.kind === "fileChange") {
    return {
      type: item.kind,
      id: item.itemId,
      status: item.status ?? null,
      changes: getCodexFileChangeList(item.fileChange?.changes).map((change) => ({
        path: change.path,
        kind: change.type === "nonRenderable" ? change.originalType : change.type,
        ...(includeOutputs
          ? {
              diff: truncate(
                change.type === "update"
                  ? change.unifiedDiff
                  : change.type === "nonRenderable"
                    ? ""
                    : change.content,
                maxOutputCharsPerItem,
              ),
            }
          : {}),
      })),
    };
  }
  return {
    type: item.semanticKind ?? item.kind,
    id: item.itemId,
    status: item.status ?? null,
    text:
      item.markdownText === undefined || item.markdownText === null
        ? null
        : truncate(item.markdownText, maxOutputCharsPerItem),
  };
}

const serializeResidentTurn = (
  turn: CodexConversationTurn,
  includeOutputs: boolean,
  maxOutputCharsPerItem: number,
): Record<string, unknown> => ({
  id: turn.turnId,
  status: turn.status,
  error: turn.errorMessage ? { message: turn.errorMessage, additionalDetails: null } : null,
  startedAt: turn.startedAt ?? turn.turnStartedAtMs ?? null,
  firstTurnWorkItemStartedAtMs: turn.firstTurnWorkItemStartedAtMs ?? null,
  completedAt: turn.completedAt ?? null,
  durationMs: turn.durationMs ?? null,
  items: turn.items.map((item) =>
    serializeCodexReadThreadResidentItem(item, includeOutputs, maxOutputCharsPerItem),
  ),
});

const serializeProtocolTurn = (
  turn: Turn,
  includeOutputs: boolean,
  maxOutputCharsPerItem: number,
): Record<string, unknown> => ({
  id: turn.id,
  status: turn.status,
  error: turn.error,
  startedAt: turn.startedAt,
  firstTurnWorkItemStartedAtMs: null,
  completedAt: turn.completedAt,
  durationMs: turn.durationMs,
  items: turn.items.map((item) =>
    serializeCodexReadThreadProtocolItem(item, includeOutputs, maxOutputCharsPerItem),
  ),
});

const cursorKey = (threadId: string, publicCursor: string): string =>
  JSON.stringify([threadId, publicCursor]);

/** Bounded, generation-scoped bridge from the public Turn-id cursor to app-server opaque state. */
export class CodexReadThreadCursorRegistry {
  readonly #entries = new Map<string, ReadThreadCursorEntry>();

  constructor(
    readonly now: () => number = Date.now,
    readonly maxRetained: number = MAX_RETAINED_CURSORS,
    readonly retentionMs: number = CURSOR_RETENTION_MS,
  ) {}

  #pruneExpired(): void {
    const now = this.now();
    for (const [key, entry] of this.#entries) {
      if (entry.expiresAtMs <= now) this.#entries.delete(key);
    }
  }

  #makeRoomForInsert(): void {
    const maximum = Math.max(1, this.maxRetained);
    while (this.#entries.size >= maximum) {
      const oldest = this.#entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
  }

  set(input: Omit<ReadThreadCursorEntry, "expiresAtMs">): void {
    this.#pruneExpired();
    const key = cursorKey(input.threadId, input.publicCursor);
    this.#entries.delete(key);
    this.#makeRoomForInsert();
    this.#entries.set(key, { ...input, expiresAtMs: this.now() + this.retentionMs });
  }

  get(input: {
    readonly threadId: string;
    readonly publicCursor: string;
    readonly hostId: string;
    readonly hostGeneration: number;
  }): string | null {
    this.#pruneExpired();
    const key = cursorKey(input.threadId, input.publicCursor);
    const entry = this.#entries.get(key);
    if (!entry) return null;
    if (entry.hostId !== input.hostId || entry.hostGeneration !== input.hostGeneration) {
      this.#entries.delete(key);
      return null;
    }
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return entry.appServerCursor;
  }
}

const readError = (
  threadId: string,
  reason: CodexReadThreadHistoryError["reason"],
  cause: unknown,
): CodexReadThreadHistoryError => new CodexReadThreadHistoryError({ threadId, reason, cause });

const publicThread = (
  snapshot: CodexConversationSnapshot,
  hostId: string,
): CodexReadThreadHistoryResult["thread"] => ({
  id: snapshot.threadId,
  hostId,
  title: snapshot.threadName,
  preview: snapshot.threadPreview,
  status: {
    type: snapshot.statusType,
    ...(snapshot.statusActiveFlags.length > 0
      ? { activeFlags: [...snapshot.statusActiveFlags] }
      : {}),
  },
  cwd: snapshot.cwd,
  createdAt: snapshot.createdAt,
  updatedAt: snapshot.updatedAt,
});

export const make: Effect.Effect<
  CodexReadThreadHistory["Service"],
  never,
  CodexAppServerCapabilities | CodexHistoryPageAdapter | CodexThreadDirectory
> = Effect.gen(function* () {
  const capabilities = yield* CodexAppServerCapabilities;
  const pages = yield* CodexHistoryPageAdapter;
  const directory = yield* CodexThreadDirectory;
  const cursors = new CodexReadThreadCursorRegistry();

  const read = Effect.fn("CodexReadThreadHistory.read")(function* (
    input: CodexReadThreadHistoryInput,
  ) {
    const entry = yield* directory
      .resolve({ threadId: input.threadId, fidelity: "tail" })
      .pipe(Effect.mapError((cause) => readError(input.threadId, "request-failed", cause)));
    if (!entry) {
      return yield* readError(
        input.threadId,
        "thread-missing",
        new Error(`Thread '${input.threadId}' was not found`),
      );
    }
    const snapshot = entry.snapshot;
    if (!snapshot) {
      return yield* readError(
        input.threadId,
        "snapshot-missing",
        new Error(`Thread '${input.threadId}' has no snapshot`),
      );
    }
    const limit = boundedInteger(
      input.turnLimit,
      CODEX_APP_READ_THREAD_DEFAULT_TURN_LIMIT,
      1,
      CODEX_APP_READ_THREAD_MAX_TURN_LIMIT,
    );
    const maxOutputChars = boundedInteger(
      input.maxOutputCharsPerItem,
      CODEX_APP_READ_THREAD_DEFAULT_MAX_OUTPUT_CHARS,
      0,
      CODEX_APP_READ_THREAD_MAX_OUTPUT_CHARS,
    );
    const includeOutputs = input.includeOutputs === true;
    const cursor = input.cursor?.trim() || null;
    const residentCursorIndex = cursor
      ? snapshot.turns.findIndex((turn) => turn.turnId === cursor)
      : snapshot.turns.length;

    if (residentCursorIndex > 0 || cursor === null) {
      const preceding = snapshot.turns.slice(0, residentCursorIndex);
      const page = preceding
        .filter((turn): turn is typeof turn & { readonly turnId: string } => turn.turnId !== null)
        .slice(-limit)
        .reverse();
      const hasResidentMore = preceding.length > page.length;
      const appServerCursor = snapshot.turnPagination?.olderCursor ?? null;
      const hasMore = hasResidentMore || appServerCursor !== null;
      const nextCursor = hasMore ? (page.at(-1)?.turnId ?? null) : null;
      if (!hasResidentMore && nextCursor !== null && appServerCursor !== null) {
        const host = yield* capabilities
          .forThread(input.threadId)
          .pipe(Effect.mapError((cause) => readError(input.threadId, "request-failed", cause)));
        cursors.set({
          threadId: input.threadId,
          publicCursor: nextCursor,
          appServerCursor,
          hostId: host.hostId,
          hostGeneration: host.generation,
        });
      }
      return {
        schemaVersion: 1,
        thread: publicThread(snapshot, entry.durable.executionHostId),
        page: { order: "newest_first", limit, nextCursor, hasMore: nextCursor !== null },
        turns: page.map((turn) => serializeResidentTurn(turn, includeOutputs, maxOutputChars)),
      } satisfies CodexReadThreadHistoryResult;
    }

    const host = yield* capabilities
      .forThread(input.threadId)
      .pipe(Effect.mapError((cause) => readError(input.threadId, "request-failed", cause)));
    const appServerCursor =
      cursor === null
        ? null
        : cursors.get({
            threadId: input.threadId,
            publicCursor: cursor,
            hostId: host.hostId,
            hostGeneration: host.generation,
          });
    if (cursor === null || appServerCursor === null) {
      return yield* readError(
        input.threadId,
        "unknown-cursor",
        new Error(`Unknown cursor for thread ${input.threadId}: ${cursor ?? "<none>"}`),
      );
    }

    const loaded = yield* pages
      .loadTurnPage({
        capability: host,
        threadId: input.threadId,
        cursor: appServerCursor,
        initialItemsCursor: null,
        limit: Math.min(limit, CODEX_HISTORY_TURN_PAGE_SIZE),
        purpose: "tool",
      })
      .pipe(Effect.mapError((cause) => readError(input.threadId, "request-failed", cause)));
    if (!(yield* capabilities.isCurrent(host).pipe(Effect.orElseSucceed(() => false)))) {
      return yield* readError(
        input.threadId,
        "request-failed",
        new Error("Codex app-server generation changed while reading Thread history"),
      );
    }
    const page = [...loaded.turns].reverse();
    if (page.length === 0 && loaded.nextCursor !== null) {
      return yield* readError(
        input.threadId,
        "request-failed",
        new Error("The app-server history cursor advanced without returning a Turn"),
      );
    }
    const nextCursor = loaded.nextCursor === null ? null : (page.at(-1)?.id ?? null);
    if (nextCursor !== null && loaded.nextCursor !== null) {
      cursors.set({
        threadId: input.threadId,
        publicCursor: nextCursor,
        appServerCursor: loaded.nextCursor,
        hostId: host.hostId,
        hostGeneration: host.generation,
      });
    }
    return {
      schemaVersion: 1,
      thread: publicThread(snapshot, entry.durable.executionHostId),
      page: {
        order: "newest_first",
        limit,
        nextCursor,
        hasMore: nextCursor !== null,
      },
      turns: page.map((turn) => serializeProtocolTurn(turn, includeOutputs, maxOutputChars)),
    } satisfies CodexReadThreadHistoryResult;
  });

  return CodexReadThreadHistory.of({ read });
});
