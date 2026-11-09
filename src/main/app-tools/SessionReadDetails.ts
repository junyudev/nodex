import type { AgentRuntimeOperations } from "@nodex/agent-runtime/contracts";
import * as Effect from "effect/Effect";
import { z } from "zod";
import type { AgentRuntimeApplication } from "../agent-runtime/AgentRuntimeApplication";
import type { Thread, Turn } from "@nodex/codex-app-server-protocol/v2";
import { SessionHistoryReadError, SESSION_READ_MAX_BYTES } from "./SessionHistoryRead";
import { toolResultBytes } from "./app-tool-result";

type Metadata = AgentRuntimeOperations["sessions.metadata"]["output"][number];
type Details = AgentRuntimeOperations["thread.read-details"]["output"];
export interface RuntimeSessionReadExecution {
  readonly source: "runtime";
  readonly metadata: Metadata | null;
  readonly runCount: number;
  readonly pendingRequestCount: number;
  readonly recentRuns: Details["recentRuns"];
  readonly runsPage: { readonly nextCursor: string | null };
}
export interface NativeSessionReadExecution {
  readonly source: "codex";
  readonly metadata: Pick<
    Thread,
    | "id"
    | "source"
    | "originator"
    | "model"
    | "modelProvider"
    | "forkedFromId"
    | "parentThreadId"
    | "gitInfo"
    | "createdAt"
    | "updatedAt"
    | "status"
  >;
  readonly runCount: null;
  readonly pendingRequestCount: null;
  readonly recentRuns: readonly ({ readonly runId: string } & Pick<
    Turn,
    "status" | "startedAt" | "completedAt" | "durationMs"
  >)[];
  readonly runsPage: { readonly nextCursor: string | null };
}
export type SessionReadExecution = RuntimeSessionReadExecution | NativeSessionReadExecution;
const cursorSchema = z.strictObject({
  version: z.literal(1),
  sessionId: z.string(),
  binding: z.string(),
  beforeOrdinal: z.number().int().positive(),
});
const encode = (value: z.infer<typeof cursorSchema>) =>
  `nxr1.${Buffer.from(JSON.stringify(value), "utf8").toString("base64url")}`;

/** Run pagination is independent of item and content cursors and retains every omitted Run. */
export const readSessionExecutionDetails = Effect.fn("SessionReadDetails.read")(function* (input: {
  readonly application: AgentRuntimeApplication["Service"];
  readonly sessionId: string;
  readonly threadId: string;
  readonly runtimeId: string;
  readonly binding: string;
  readonly runLimit: number;
  readonly runCursor?: string;
  readonly base: Record<string, unknown>;
}) {
  const beforeOrdinal =
    input.runCursor === undefined
      ? undefined
      : yield* Effect.try({
          try: () => {
            if (!input.runCursor!.startsWith("nxr1.")) throw new Error("Unknown Run cursor");
            const cursor = cursorSchema.parse(
              JSON.parse(Buffer.from(input.runCursor!.slice(5), "base64url").toString("utf8")),
            );
            if (cursor.sessionId !== input.sessionId || cursor.binding !== input.binding)
              throw new Error("Run cursor belongs to another Session binding");
            return cursor.beforeOrdinal;
          },
          catch: (cause) => new SessionHistoryReadError({ reason: "invalid_cursor", cause }),
        });
  const [metadata, details] = yield* Effect.all([
    input.application.sessionMetadata({ threadIds: [input.threadId], runtimeId: input.runtimeId }),
    input.application.readDetails({
      sessionId: input.sessionId,
      threadId: input.threadId,
      runLimit: input.runLimit,
      ...(beforeOrdinal === undefined ? {} : { beforeOrdinal }),
    }),
  ]).pipe(
    Effect.mapError(
      (cause) => new SessionHistoryReadError({ reason: "history_unavailable", cause }),
    ),
  );
  const result = (count: number): RuntimeSessionReadExecution => {
    const recentRuns = details.recentRuns.slice(0, count);
    const nextOrdinal =
      count < details.recentRuns.length
        ? (recentRuns.at(-1)?.ordinal ?? beforeOrdinal)
        : details.nextOrdinal;
    return {
      source: "runtime",
      metadata: metadata[0] ?? null,
      runCount: details.runCount,
      pendingRequestCount: details.pendingRequestCount,
      recentRuns,
      runsPage: {
        nextCursor:
          nextOrdinal == null
            ? null
            : encode({
                version: 1,
                sessionId: input.sessionId,
                binding: input.binding,
                beforeOrdinal: nextOrdinal,
              }),
      },
    };
  };
  let count = details.recentRuns.length;
  // Reserve half of the complete envelope for item identities and resumable content.
  while (
    count > 1 &&
    toolResultBytes({ ...input.base, execution: result(count) }) > SESSION_READ_MAX_BYTES / 2
  )
    count--;
  return result(count);
});
