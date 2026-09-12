import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import type { RequestId } from "@nodex/codex-app-server-protocol";
import type { CommandExecutionRequestApprovalResponse } from "@nodex/codex-app-server-protocol/v2/CommandExecutionRequestApprovalResponse";
import type { DynamicToolCallParams } from "@nodex/codex-app-server-protocol/v2/DynamicToolCallParams";
import type { DynamicToolCallResponse } from "@nodex/codex-app-server-protocol/v2/DynamicToolCallResponse";
import type { FileChangeRequestApprovalResponse } from "@nodex/codex-app-server-protocol/v2/FileChangeRequestApprovalResponse";
import type { McpServerElicitationRequestResponse } from "@nodex/codex-app-server-protocol/v2/McpServerElicitationRequestResponse";
import type { PermissionsRequestApprovalResponse } from "@nodex/codex-app-server-protocol/v2/PermissionsRequestApprovalResponse";
import { CodexAppServerNoResponse } from "@nodex/effect-codex-app-server/protocol";
import type {
  CodexApprovalRequest,
  CodexMcpServerElicitationRequest,
  CodexPermissionRequest,
  CodexUserInputRequest,
} from "../../shared/types";
import type { FrozenNodexAgentTurnAuthority } from "../../shared/nodex-agent-authority";
import type { CodexRequestTraceContext } from "../../shared/codex-request-lifecycle";
import type { CodexServerRequest } from "../codex-runtime/CodexApplicationProtocol";

export type CodexPendingServerRequestKind =
  | "approval"
  | "dynamic-tool"
  | "mcp-elicitation"
  | "permission"
  | "private"
  | "user-input";

interface PendingServerRequestBase<Kind extends CodexPendingServerRequestKind> {
  readonly hostId: string;
  readonly generation: number;
  readonly kind: Kind;
  readonly occurrenceToken: number;
  readonly requestId: RequestId;
  readonly threadId: string;
  readonly turnId: string;
}

export interface CodexPendingApproval extends PendingServerRequestBase<"approval"> {
  readonly request: CodexApprovalRequest;
}

export interface CodexPendingUserInput extends PendingServerRequestBase<"user-input"> {
  readonly request: CodexUserInputRequest;
}

export interface CodexPendingMcpServerElicitation extends PendingServerRequestBase<"mcp-elicitation"> {
  readonly request: CodexMcpServerElicitationRequest;
}

export interface CodexPendingPermissionRequest extends PendingServerRequestBase<"permission"> {
  readonly request: CodexPermissionRequest;
}

export interface CodexPendingPrivateServerRequest extends PendingServerRequestBase<"private"> {
  readonly request: Extract<
    CodexServerRequest,
    {
      method: "item/tool/requestOptionPicker" | "item/tool/requestSetupCodexContextPicker";
    }
  >;
}

export interface CodexPendingDynamicToolCall extends PendingServerRequestBase<"dynamic-tool"> {
  readonly request: CodexServerRequest & {
    readonly method: "item/tool/call";
    readonly params: DynamicToolCallParams;
  };
  readonly nodexAuthority: FrozenNodexAgentTurnAuthority | null;
  readonly disposition: "stored" | "dispatched";
}

export type CodexPendingServerRequest =
  | CodexPendingApproval
  | CodexPendingDynamicToolCall
  | CodexPendingMcpServerElicitation
  | CodexPendingPermissionRequest
  | CodexPendingPrivateServerRequest
  | CodexPendingUserInput;

export type CodexPendingServerRequestFor<Kind extends CodexPendingServerRequestKind> = Extract<
  CodexPendingServerRequest,
  { readonly kind: Kind }
>;

export type CodexPendingServerRequestResponse<Entry extends CodexPendingServerRequest> =
  Entry extends CodexPendingApproval
    ?
        | CommandExecutionRequestApprovalResponse
        | FileChangeRequestApprovalResponse
        | typeof CodexAppServerNoResponse
    : Entry extends CodexPendingUserInput
      ?
          | { readonly answers: Readonly<Record<string, { readonly answers: readonly string[] }>> }
          | typeof CodexAppServerNoResponse
      : Entry extends CodexPendingMcpServerElicitation
        ? McpServerElicitationRequestResponse | typeof CodexAppServerNoResponse
        : Entry extends CodexPendingPermissionRequest
          ? PermissionsRequestApprovalResponse | typeof CodexAppServerNoResponse
          : Entry extends CodexPendingDynamicToolCall
            ? DynamicToolCallResponse | typeof CodexAppServerNoResponse
            : unknown;

export type CodexPendingServerRequestRegistration = {
  readonly hostId: string;
  readonly generation: number;
} & (
  | {
      readonly kind: "approval";
      readonly occurrenceToken: number | undefined;
      readonly request: CodexApprovalRequest;
    }
  | {
      readonly kind: "dynamic-tool";
      readonly occurrenceToken: number | undefined;
      readonly request: CodexPendingDynamicToolCall["request"];
      readonly nodexAuthority: FrozenNodexAgentTurnAuthority | null;
      readonly disposition: CodexPendingDynamicToolCall["disposition"];
    }
  | {
      readonly kind: "mcp-elicitation";
      readonly occurrenceToken: number | undefined;
      readonly request: CodexMcpServerElicitationRequest;
    }
  | {
      readonly kind: "permission";
      readonly occurrenceToken: number | undefined;
      readonly request: CodexPermissionRequest;
    }
  | {
      readonly kind: "private";
      readonly occurrenceToken: number | undefined;
      readonly request: CodexPendingPrivateServerRequest["request"];
    }
  | {
      readonly kind: "user-input";
      readonly occurrenceToken: number | undefined;
      readonly request: CodexUserInputRequest;
    }
);

export interface CodexPendingServerRequestCounts {
  readonly approvals: number;
  readonly dynamicToolCalls: number;
  readonly mcpElicitations: number;
  readonly permissionRequests: number;
  readonly privateServerRequests: number;
  readonly total: number;
  readonly userInputs: number;
}

export interface CodexPendingServerRequestIdentity {
  readonly requestId: RequestId;
  readonly threadId: string;
  readonly generation: number;
}

export interface CodexServerRequestOccurrenceCompletion {
  readonly resolve: (response: unknown) => void;
  readonly reject: (reason: unknown) => void;
}

export class CodexPendingServerRequestRuntimeClosedError extends Schema.TaggedError<CodexPendingServerRequestRuntimeClosedError>()(
  "CodexPendingServerRequestRuntimeClosedError",
  {},
) {}

export interface CodexPendingServerRequestRuntimeService {
  readonly register: <Registration extends CodexPendingServerRequestRegistration>(
    registration: Registration,
  ) => CodexPendingServerRequestFor<Registration["kind"]>;
  /** A one-shot completion for requests fenced before they enter the application inbox. */
  readonly completion: (
    threadId: string,
    requestId: RequestId,
    occurrenceToken: number | undefined,
  ) => CodexServerRequestOccurrenceCompletion;
  readonly find: <Kind extends CodexPendingServerRequestKind>(
    kind: Kind,
    requestId: RequestId,
    predicate?: (entry: CodexPendingServerRequestFor<Kind>) => boolean,
  ) => CodexPendingServerRequestFor<Kind> | undefined;
  readonly takeFirst: <Kind extends CodexPendingServerRequestKind>(
    kind: Kind,
    requestId: RequestId,
    predicate?: (entry: CodexPendingServerRequestFor<Kind>) => boolean,
  ) => CodexPendingServerRequestFor<Kind> | undefined;
  readonly takeAll: <Kind extends CodexPendingServerRequestKind>(
    kind: Kind,
    requestId: RequestId,
    predicate?: (entry: CodexPendingServerRequestFor<Kind>) => boolean,
  ) => readonly CodexPendingServerRequestFor<Kind>[];
  readonly has: (kind: CodexPendingServerRequestKind, requestId: RequestId) => boolean;
  readonly counts: () => CodexPendingServerRequestCounts;
  readonly complete: <Entry extends CodexPendingServerRequest>(
    entry: Entry,
    response: CodexPendingServerRequestResponse<Entry>,
    trace?: CodexRequestTraceContext | null,
  ) => void;
  readonly reject: (entry: CodexPendingServerRequest, reason: unknown) => void;
  /** Consume a claimed application entry when the dispatcher itself returns the response. */
  readonly discard: (entry: CodexPendingServerRequest) => void;
  readonly disconnectIdentities: (
    hostId: string,
    generation?: number,
  ) => readonly CodexPendingServerRequestIdentity[];
  readonly abandonIdentity: (
    threadId: string,
    requestId: RequestId,
    connection?: Pick<CodexPendingServerRequest, "hostId" | "generation">,
  ) => void;
  readonly rejectRemovedTurns: (
    threadId: string,
    retainedTurnIds: ReadonlySet<string>,
    options?: { readonly retainTurnless?: boolean },
  ) => void;
  readonly rejectDispatchedDynamicForThread: (threadId: string, reason: unknown) => void;
}

export class CodexPendingServerRequestRuntime extends Context.Service<
  CodexPendingServerRequestRuntime,
  CodexPendingServerRequestRuntimeService
>()("nodex/main/codex-application/CodexPendingServerRequestRuntime") {}

export interface CodexPendingServerRequestRuntimeOptions {
  readonly abandon: (
    threadId: string,
    requestId: RequestId,
    occurrenceToken: number,
  ) => Effect.Effect<boolean>;
  readonly respond: (
    threadId: string,
    requestId: RequestId,
    occurrenceToken: number,
    response: unknown,
    trace?: CodexRequestTraceContext | null,
  ) => Effect.Effect<boolean>;
  readonly reject: (
    threadId: string,
    requestId: RequestId,
    occurrenceToken: number,
    reason: unknown,
  ) => Effect.Effect<boolean>;
}

type EntryState = "claimed" | "queued" | "settled";

interface PendingState {
  readonly all: Set<CodexPendingServerRequest>;
  readonly entriesByKind: Map<
    CodexPendingServerRequestKind,
    Map<RequestId, CodexPendingServerRequest[]>
  >;
  readonly stateByEntry: WeakMap<CodexPendingServerRequest, EntryState>;
}

const emptyPendingState = (): PendingState => ({
  all: new Set(),
  entriesByKind: new Map(),
  stateByEntry: new WeakMap(),
});

const requestIdentity = (
  registration: CodexPendingServerRequestRegistration,
): Omit<PendingServerRequestBase<CodexPendingServerRequestKind>, "kind"> => {
  const occurrenceToken = registration.occurrenceToken;
  if (occurrenceToken === undefined) {
    throw new Error("Codex application request is missing its Effect occurrence token");
  }
  if (registration.kind === "private" || registration.kind === "dynamic-tool") {
    const request = registration.request;
    return {
      hostId: registration.hostId,
      generation: registration.generation,
      occurrenceToken,
      requestId: request.id,
      threadId: request.params.threadId,
      turnId: request.params.turnId,
    };
  }
  const request = registration.request;
  return {
    hostId: registration.hostId,
    generation: registration.generation,
    occurrenceToken,
    requestId: request.requestId,
    threadId: request.threadId,
    turnId: request.turnId,
  };
};

const buildCodexPendingServerRequestEntry = (
  registration: CodexPendingServerRequestRegistration,
): CodexPendingServerRequest => {
  const identity = requestIdentity(registration);
  switch (registration.kind) {
    case "approval":
    case "mcp-elicitation":
    case "permission":
    case "private":
    case "user-input":
      return { ...registration, ...identity, occurrenceToken: identity.occurrenceToken };
    case "dynamic-tool":
      return { ...registration, ...identity, occurrenceToken: identity.occurrenceToken };
  }
};

const identityKey = (threadId: string, requestId: RequestId): string =>
  `${threadId}\u0000${typeof requestId}:${String(requestId)}`;

/**
 * Mutable only inside one Main Scope. JSON-RPC ids index FIFO lanes while `all`
 * retains claimed entries until their physical transport occurrence is settled.
 */
export const make = (
  options: CodexPendingServerRequestRuntimeOptions,
): Effect.Effect<CodexPendingServerRequestRuntimeService, never, Scope.Scope> =>
  Effect.gen(function* () {
    const state = emptyPendingState();
    const runCompletion = yield* FiberSet.makeRuntime<never, void, never>();
    let closed = false;

    const queueFor = (kind: CodexPendingServerRequestKind, requestId: RequestId) => {
      const byId =
        state.entriesByKind.get(kind) ?? new Map<RequestId, CodexPendingServerRequest[]>();
      state.entriesByKind.set(kind, byId);
      const queue = byId.get(requestId) ?? [];
      byId.set(requestId, queue);
      return queue;
    };

    const removeQueued = (entry: CodexPendingServerRequest): void => {
      const byId = state.entriesByKind.get(entry.kind);
      const queue = byId?.get(entry.requestId);
      if (!queue) return;
      const index = queue.indexOf(entry);
      if (index >= 0) queue.splice(index, 1);
      if (queue.length === 0) byId?.delete(entry.requestId);
      if (byId?.size === 0) state.entriesByKind.delete(entry.kind);
    };

    const settle = (entry: CodexPendingServerRequest): boolean => {
      if (state.stateByEntry.get(entry) === "settled") return false;
      removeQueued(entry);
      state.stateByEntry.set(entry, "settled");
      state.all.delete(entry);
      return true;
    };

    const claim = <Kind extends CodexPendingServerRequestKind>(
      kind: Kind,
      requestId: RequestId,
      predicate: (entry: CodexPendingServerRequestFor<Kind>) => boolean,
      all: boolean,
    ): readonly CodexPendingServerRequestFor<Kind>[] => {
      const byId = state.entriesByKind.get(kind);
      const queue = byId?.get(requestId) ?? [];
      const selected: CodexPendingServerRequestFor<Kind>[] = [];
      for (const candidate of [...queue]) {
        const entry = candidate as CodexPendingServerRequestFor<Kind>;
        if (!predicate(entry)) continue;
        removeQueued(entry);
        state.stateByEntry.set(entry, "claimed");
        selected.push(entry);
        if (!all) break;
      }
      return selected;
    };

    const dispatch = (effect: Effect.Effect<unknown>): void => {
      runCompletion(effect.pipe(Effect.asVoid));
    };

    const complete = <Entry extends CodexPendingServerRequest>(
      entry: Entry,
      response: CodexPendingServerRequestResponse<Entry>,
      trace?: CodexRequestTraceContext | null,
    ): void => {
      if (!settle(entry)) return;
      if (response === CodexAppServerNoResponse) {
        dispatch(options.abandon(entry.threadId, entry.requestId, entry.occurrenceToken));
        return;
      }
      dispatch(
        options.respond(entry.threadId, entry.requestId, entry.occurrenceToken, response, trace),
      );
    };

    const reject = (entry: CodexPendingServerRequest, reason: unknown): void => {
      if (!settle(entry)) return;
      dispatch(options.reject(entry.threadId, entry.requestId, entry.occurrenceToken, reason));
    };

    const entriesMatching = (
      predicate: (entry: CodexPendingServerRequest) => boolean,
    ): readonly CodexPendingServerRequest[] => [...state.all].filter(predicate);

    const queuedMatching = (
      predicate: (entry: CodexPendingServerRequest) => boolean,
    ): readonly CodexPendingServerRequest[] =>
      [...state.all].filter(
        (entry) => state.stateByEntry.get(entry) === "queued" && predicate(entry),
      );

    const abandonIdentity: CodexPendingServerRequestRuntimeService["abandonIdentity"] = (
      threadId,
      requestId,
      connection,
    ) => {
      for (const entry of queuedMatching(
        (candidate) =>
          candidate.threadId === threadId &&
          candidate.requestId === requestId &&
          (!connection ||
            (candidate.hostId === connection.hostId &&
              candidate.generation === connection.generation)) &&
          (candidate.kind !== "dynamic-tool" || candidate.disposition === "stored"),
      )) {
        complete(entry, CodexAppServerNoResponse);
      }
    };

    const release = Effect.fn("CodexPendingServerRequestRuntime.release")((reason: unknown) =>
      Effect.gen(function* () {
        if (closed) return;
        closed = true;
        const outstanding = [...state.all];
        for (const entry of outstanding) settle(entry);
        yield* Effect.forEach(
          outstanding,
          (entry) => options.reject(entry.threadId, entry.requestId, entry.occurrenceToken, reason),
          { concurrency: "unbounded", discard: true },
        );
      }),
    );

    yield* Effect.addFinalizer(() =>
      release(new Error("Codex pending server-request runtime is closing")),
    );

    return CodexPendingServerRequestRuntime.of({
      completion: (threadId, requestId, occurrenceToken) => {
        if (occurrenceToken === undefined) {
          throw new Error("Codex application request is missing its Effect occurrence token");
        }
        let settled = false;
        return {
          resolve: (response) => {
            if (settled) return;
            settled = true;
            dispatch(options.respond(threadId, requestId, occurrenceToken, response));
          },
          reject: (reason) => {
            if (settled) return;
            settled = true;
            dispatch(options.reject(threadId, requestId, occurrenceToken, reason));
          },
        };
      },
      register: <Registration extends CodexPendingServerRequestRegistration>(
        registration: Registration,
      ) => {
        if (closed) throw new CodexPendingServerRequestRuntimeClosedError();
        const entry = buildCodexPendingServerRequestEntry(registration);
        queueFor(entry.kind, entry.requestId).push(entry);
        state.all.add(entry);
        state.stateByEntry.set(entry, "queued");
        return entry as CodexPendingServerRequestFor<Registration["kind"]>;
      },
      find: (kind, requestId, predicate = () => true) => {
        const queue = state.entriesByKind.get(kind)?.get(requestId) ?? [];
        return queue.find((entry) =>
          predicate(entry as CodexPendingServerRequestFor<typeof kind>),
        ) as CodexPendingServerRequestFor<typeof kind> | undefined;
      },
      takeFirst: (kind, requestId, predicate = () => true) =>
        claim(kind, requestId, predicate, false)[0],
      takeAll: (kind, requestId, predicate = () => true) => claim(kind, requestId, predicate, true),
      has: (kind, requestId) => (state.entriesByKind.get(kind)?.get(requestId)?.length ?? 0) > 0,
      counts: () => {
        const count = (kind: CodexPendingServerRequestKind): number =>
          [...state.all].filter((entry) => entry.kind === kind).length;
        const counts = {
          approvals: count("approval"),
          dynamicToolCalls: count("dynamic-tool"),
          mcpElicitations: count("mcp-elicitation"),
          permissionRequests: count("permission"),
          privateServerRequests: count("private"),
          userInputs: count("user-input"),
        };
        return { ...counts, total: Object.values(counts).reduce((sum, value) => sum + value, 0) };
      },
      complete,
      reject,
      discard: (entry) => {
        settle(entry);
      },
      disconnectIdentities: (hostId, generation) => {
        const byIdentity = new Map<string, CodexPendingServerRequestIdentity>();
        for (const entry of queuedMatching(
          (candidate) =>
            candidate.hostId === hostId &&
            (generation === undefined || candidate.generation === generation) &&
            (candidate.kind !== "dynamic-tool" || candidate.disposition === "stored"),
        )) {
          byIdentity.set(`${entry.generation}:${identityKey(entry.threadId, entry.requestId)}`, {
            threadId: entry.threadId,
            requestId: entry.requestId,
            generation: entry.generation,
          });
        }
        return [...byIdentity.values()];
      },
      abandonIdentity,
      rejectRemovedTurns: (threadId, retainedTurnIds, options = {}) => {
        const retainTurnless = options.retainTurnless ?? true;
        for (const entry of entriesMatching((candidate) => candidate.threadId === threadId)) {
          if ((retainTurnless && entry.turnId.length === 0) || retainedTurnIds.has(entry.turnId)) {
            continue;
          }
          reject(entry, new Error(`${entry.kind} request cleared after thread history changed`));
        }
      },
      rejectDispatchedDynamicForThread: (threadId, reason) => {
        for (const entry of entriesMatching(
          (candidate) =>
            candidate.kind === "dynamic-tool" &&
            candidate.disposition === "dispatched" &&
            candidate.threadId === threadId,
        )) {
          reject(entry, reason);
        }
      },
    });
  });
