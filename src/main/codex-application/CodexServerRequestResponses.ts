import type { CodexNativeUserResponseInput } from "../../shared/codex-native-server-response";
import type { RequestId } from "@nodex/codex-app-server-protocol";
import type { DynamicToolCallResponse } from "@nodex/codex-app-server-protocol/v2/DynamicToolCallResponse";
import { CodexAppServerNoResponse } from "@nodex/effect-codex-app-server/protocol";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type { CodexApprovalResponse } from "../../shared/codex-approval-response";
import { getCodexApprovalRequestMethod } from "../../shared/codex-approval";
import type {
  CodexCanonicalConversationState,
  CodexCanonicalOptionPickerResponse,
  CodexCanonicalSetupCodexStepResponse,
  CodexCanonicalSetupContextPickerResponse,
} from "../../shared/codex-conversation-state/codex-conversation-state";
import {
  reduceCodexConversationApprovalResponse,
  reduceCodexConversationMcpElicitationResponse,
  reduceCodexConversationOnboardingInputResponse,
  reduceCodexConversationOptionPickerResponse,
  reduceCodexConversationPermissionResponse,
  reduceCodexConversationSetupCodexStepResponse,
  reduceCodexConversationSetupContextPickerResponse,
  reduceCodexConversationUserInputResponse,
  reduceCodexServerRequestSetupCodexStepResponseRawState,
  type CodexServerRequestLifecycleResult,
  type CodexServerRequestRawLifecycleResult,
} from "../../shared/codex-conversation-state/codex-server-request-lifecycle";
import {
  CODEX_APP_TOOL_NAMESPACE,
  hasCodexDynamicToolIdentity,
} from "../../shared/codex-dynamic-tool-identity";
import { normalizeCodexMcpServerElicitationResponse } from "../../shared/codex-mcp-elicitation";
import type {
  CodexMcpServerElicitationAction,
  CodexMcpServerElicitationResponse,
  CodexPermissionRequestResponse,
} from "../../shared/types";
import { buildCodexAppDynamicToolSuccess } from "../codex/codex-app-meta-thread-tools";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { CodexApplicationEventHub } from "./CodexApplicationEventHub";
import {
  CodexPendingServerRequestRuntime,
  type CodexPendingServerRequest,
} from "./CodexPendingServerRequestRuntime";
import { CodexThreadReadState } from "./CodexThreadReadState";
import { CodexUserInputAutoResolution } from "./CodexUserInputAutoResolution";
import { ConversationEntityMap } from "./internal/ConversationEntityMap";

export class CodexServerRequestResponseProjectionError extends Data.TaggedError(
  "CodexServerRequestResponseProjectionError",
)<{
  readonly operation: "respond-follower-approval" | "transaction";
  readonly cause: unknown;
}> {}

export interface CodexApprovalResponseInput {
  readonly threadId: string;
  readonly requestId: RequestId;
  readonly response: CodexApprovalResponse;
}

export interface CodexUserInputResponseInput {
  readonly threadId: string;
  readonly requestId: RequestId;
  readonly answers: Readonly<Record<string, readonly string[]>>;
}

export interface CodexMcpElicitationResponseInput {
  readonly threadId: string;
  readonly requestId: RequestId;
  readonly response: CodexMcpServerElicitationAction | CodexMcpServerElicitationResponse;
}

export interface CodexPermissionResponseInput {
  readonly threadId: string;
  readonly requestId: RequestId;
  readonly response: CodexPermissionRequestResponse;
}

export interface CodexOptionPickerResponseInput {
  readonly threadId: string;
  readonly requestId: RequestId;
  readonly response: CodexCanonicalOptionPickerResponse;
}

export interface CodexSetupContextPickerResponseInput {
  readonly threadId: string;
  readonly requestId: RequestId;
  readonly response: CodexCanonicalSetupContextPickerResponse;
}

export interface CodexSetupCodexStepResponseInput {
  readonly threadId: string;
  readonly requestId: RequestId;
  readonly response: CodexCanonicalSetupCodexStepResponse;
}

export interface CodexServerRequestResponsesService {
  readonly native: (
    input: CodexNativeUserResponseInput,
  ) => Effect.Effect<boolean, CodexServerRequestResponseProjectionError>;
  readonly approval: (
    input: CodexApprovalResponseInput,
  ) => Effect.Effect<boolean, CodexServerRequestResponseProjectionError>;
  readonly userInput: (
    input: CodexUserInputResponseInput,
  ) => Effect.Effect<boolean, CodexServerRequestResponseProjectionError>;
  readonly mcpElicitation: (
    input: CodexMcpElicitationResponseInput,
  ) => Effect.Effect<boolean, CodexServerRequestResponseProjectionError>;
  readonly permission: (
    input: CodexPermissionResponseInput,
  ) => Effect.Effect<boolean, CodexServerRequestResponseProjectionError>;
  readonly optionPicker: (
    input: CodexOptionPickerResponseInput,
  ) => Effect.Effect<boolean, CodexServerRequestResponseProjectionError>;
  readonly setupContextPicker: (
    input: CodexSetupContextPickerResponseInput,
  ) => Effect.Effect<boolean, CodexServerRequestResponseProjectionError>;
  readonly setupCodexStep: (
    input: CodexSetupCodexStepResponseInput,
  ) => Effect.Effect<boolean, CodexServerRequestResponseProjectionError>;
  readonly declineAll: (
    threadId: string,
  ) => Effect.Effect<void, CodexServerRequestResponseProjectionError>;
  /** Internal composition step for a caller already holding the shared Thread command lane. */
  readonly declineAllInTransaction: (
    threadId: string,
  ) => Effect.Effect<void, CodexServerRequestResponseProjectionError>;
}

export class CodexServerRequestResponses extends Context.Service<
  CodexServerRequestResponses,
  CodexServerRequestResponsesService
>()("nodex/main/codex-application/CodexServerRequestResponses") {}

const transactionError = (cause: unknown): CodexServerRequestResponseProjectionError =>
  new CodexServerRequestResponseProjectionError({ operation: "transaction", cause });

const normalizeUserInputAnswers = (
  answers: Readonly<Record<string, readonly string[]>>,
): {
  readonly protocol: Readonly<Record<string, { readonly answers: readonly string[] }>>;
  readonly transcript: Readonly<Record<string, readonly string[]>>;
} => {
  const protocol: Record<string, { readonly answers: readonly string[] }> = {};
  const transcript: Record<string, readonly string[]> = {};
  for (const [questionId, values] of Object.entries(answers)) {
    const normalized = Array.isArray(values)
      ? values.filter((value): value is string => typeof value === "string")
      : [];
    protocol[questionId] = { answers: normalized };
    transcript[questionId] = normalized;
  }
  return { protocol, transcript };
};

const dynamicToolSuccess = (value: unknown): DynamicToolCallResponse =>
  buildCodexAppDynamicToolSuccess(value);

export const make: Effect.Effect<
  CodexServerRequestResponsesService,
  never,
  | CodexApplicationEventHub
  | CodexGateway
  | CodexPendingServerRequestRuntime
  | CodexThreadReadState
  | CodexUserInputAutoResolution
  | ConversationEntityMap
  | Scope.Scope
> = Effect.gen(function* () {
  const conversations = yield* ConversationEntityMap;
  const gateway = yield* CodexGateway;
  const inbox = yield* CodexPendingServerRequestRuntime;
  const readState = yield* CodexThreadReadState;
  const autoResolution = yield* CodexUserInputAutoResolution;
  const events = yield* CodexApplicationEventHub;
  const runSerial = <A, E>(threadId: string, operation: Effect.Effect<A, E>) =>
    conversations.runCommand(threadId, operation);
  const sync = <A>(
    evaluate: () => A,
  ): Effect.Effect<A, CodexServerRequestResponseProjectionError> =>
    Effect.try({ try: evaluate, catch: transactionError });
  const syncAtCurrentTime = <A>(
    evaluate: (observedAtMs: number) => A,
  ): Effect.Effect<A, CodexServerRequestResponseProjectionError> =>
    Clock.currentTimeMillis.pipe(
      Effect.flatMap((observedAtMs) => sync(() => evaluate(observedAtMs))),
    );
  const aggregate = (threadId: string) => conversations.current(threadId);
  const commit = (
    threadId: string,
    input:
      | {
          readonly kind: "canonical";
          readonly before: CodexCanonicalConversationState;
          readonly lifecycle: CodexServerRequestLifecycleResult;
        }
      | { readonly kind: "raw"; readonly lifecycle: CodexServerRequestRawLifecycleResult },
  ): Effect.Effect<void, CodexServerRequestResponseProjectionError> =>
    Clock.currentTimeMillis.pipe(
      Effect.flatMap((observedAtMs) =>
        sync(() => {
          const conversation = aggregate(threadId);
          if (!conversation) return null;
          return conversation.commitServerRequestLifecycle({
            ...input,
            observedAtMs,
          });
        }),
      ),
      Effect.flatMap((result) =>
        result?.unreadChanged
          ? readState.persistProjected({ threadId, hasUnreadTurn: result.hasUnreadTurn })
          : Effect.void,
      ),
    );
  const publishResolved = (
    event:
      | {
          readonly type: "approval";
          readonly requestId: RequestId;
          readonly decision: CodexApprovalResponse["decision"];
        }
      | { readonly type: "user-input"; readonly requestId: RequestId },
  ): void => {
    if (event.type === "approval") {
      events.publish({
        kind: "codex",
        value: { type: "approvalResolved", requestId: event.requestId, decision: event.decision },
      });
      return;
    }
    events.publish({
      kind: "codex",
      value: { type: "userInputResolved", requestId: event.requestId },
    });
  };
  const native: CodexServerRequestResponsesService["native"] = (input) =>
    sync(() => {
      const sameConnection = (entry: {
        readonly threadId: string;
        readonly hostId: string;
        readonly generation: number;
      }) =>
        entry.threadId === input.threadId &&
        entry.hostId === input.hostId &&
        entry.generation === input.generation;
      const matches = (entry: { readonly occurrenceToken: number }) =>
        entry.occurrenceToken === input.occurrenceToken;
      switch (input.method) {
        case "item/commandExecution/requestApproval":
        case "item/fileChange/requestApproval": {
          const first = inbox.find("approval", input.requestId, sameConnection);
          const kind =
            input.method === "item/commandExecution/requestApproval" ? "command" : "file";
          if (!first || !matches(first) || first.request.kind !== kind) return false;
          const selected = inbox.takeAll("approval", input.requestId, sameConnection);
          selected.forEach((entry, index) =>
            inbox.complete(
              entry,
              index === 0 ? input.response : CodexAppServerNoResponse,
              index === 0 ? input.trace : undefined,
            ),
          );
          publishResolved({
            type: "approval",
            requestId: input.requestId,
            decision: input.response.decision,
          });
          break;
        }
        case "item/tool/requestUserInput": {
          const first = inbox.find("user-input", input.requestId, sameConnection);
          if (!first || !matches(first)) return false;
          inbox.takeAll("user-input", input.requestId, sameConnection).forEach((entry, index) =>
            inbox.complete(
              entry,
              index === 0
                ? {
                    answers: Object.fromEntries(
                      Object.entries(input.response.answers).filter(
                        (entry): entry is [string, NonNullable<(typeof entry)[1]>] =>
                          entry[1] !== undefined,
                      ),
                    ),
                  }
                : CodexAppServerNoResponse,
              index === 0 ? input.trace : undefined,
            ),
          );
          publishResolved({ type: "user-input", requestId: input.requestId });
          break;
        }
        case "item/permissions/requestApproval": {
          const first = inbox.find("permission", input.requestId, sameConnection);
          if (!first || !matches(first)) return false;
          inbox
            .takeAll("permission", input.requestId, sameConnection)
            .forEach((entry, index) =>
              inbox.complete(
                entry,
                index === 0 ? input.response : CodexAppServerNoResponse,
                index === 0 ? input.trace : undefined,
              ),
            );
          break;
        }
        case "mcpServer/elicitation/request": {
          const first = inbox.find("mcp-elicitation", input.requestId, sameConnection);
          if (!first || !matches(first)) return false;
          inbox
            .takeAll("mcp-elicitation", input.requestId, sameConnection)
            .forEach((entry, index) =>
              inbox.complete(
                entry,
                index === 0 ? input.response : CodexAppServerNoResponse,
                index === 0 ? input.trace : undefined,
              ),
            );
          break;
        }
        case "item/tool/requestOptionPicker":
        case "item/tool/requestSetupCodexContextPicker": {
          const first = inbox.find("private", input.requestId, sameConnection);
          if (!first || !matches(first) || first.request.method !== input.method) return false;
          inbox
            .takeAll("private", input.requestId, sameConnection)
            .forEach((entry, index) =>
              inbox.complete(
                entry,
                index === 0 ? input.response : CodexAppServerNoResponse,
                index === 0 ? input.trace : undefined,
              ),
            );
          break;
        }
      }
      inbox.abandonIdentity(input.threadId, input.requestId, input);
      return true;
    });

  const approvalInTransaction = (input: CodexApprovalResponseInput) =>
    sync(() => {
      const pending = inbox.find(
        "approval",
        input.requestId,
        (candidate) =>
          candidate.threadId === input.threadId && candidate.request.kind === input.response.kind,
      );
      if (!pending) return null;
      const conversation = aggregate(input.threadId);
      const before = conversation?.readCanonicalState();
      if (!conversation || !before) return null;
      const lifecycle = reduceCodexConversationApprovalResponse(
        before,
        input.requestId,
        getCodexApprovalRequestMethod(input.response.kind),
      );
      return lifecycle.selectedRequests.length === 0 ? null : { before, conversation, lifecycle };
    }).pipe(
      Effect.flatMap((prepared) => {
        if (!prepared) return Effect.succeed(false);
        const follower = prepared.conversation.readStreamRole() === "follower";
        const respondFollower = follower
          ? gateway
              .requestRawForThread(
                input.threadId,
                input.response.kind === "command"
                  ? "thread-follower-command-approval-decision"
                  : "thread-follower-file-approval-decision",
                {
                  conversationId: input.threadId,
                  requestId: input.requestId,
                  decision: input.response.decision,
                },
              )
              .pipe(
                Effect.asVoid,
                Effect.mapError(
                  (cause) =>
                    new CodexServerRequestResponseProjectionError({
                      operation: "respond-follower-approval",
                      cause,
                    }),
                ),
              )
          : Effect.void;
        return respondFollower.pipe(
          Effect.andThen(
            sync(() => {
              const selected = inbox.takeAll(
                "approval",
                input.requestId,
                (candidate) => candidate.threadId === input.threadId,
              );
              for (const [index, entry] of selected.entries()) {
                inbox.complete(
                  entry,
                  follower || index > 0
                    ? CodexAppServerNoResponse
                    : { decision: input.response.decision },
                );
              }
              inbox.abandonIdentity(input.threadId, input.requestId);
              publishResolved({
                type: "approval",
                requestId: input.requestId,
                decision: input.response.decision,
              });
            }),
          ),
          Effect.andThen(
            commit(input.threadId, {
              kind: "canonical",
              before: prepared.before,
              lifecycle: prepared.lifecycle,
            }),
          ),
          Effect.as(true),
        );
      }),
    );
  const approval: CodexServerRequestResponsesService["approval"] = (input) =>
    runSerial(input.threadId, approvalInTransaction(input));

  const userInputInTransaction = (
    input: CodexUserInputResponseInput,
    connection?: Pick<CodexPendingServerRequest, "hostId" | "generation">,
  ) =>
    syncAtCurrentTime((observedAtMs) => {
      const conversation = aggregate(input.threadId);
      const before = conversation?.readCanonicalState();
      if (!conversation || !before) return null;
      const normalized = normalizeUserInputAnswers(input.answers);
      const matches = (entry: CodexPendingServerRequest) =>
        entry.threadId === input.threadId &&
        (!connection ||
          (entry.hostId === connection.hostId && entry.generation === connection.generation));
      const canonicalRequest = before.requests.find(
        (candidate) => candidate.id === input.requestId,
      );
      if (
        canonicalRequest?.method === "item/tool/call" &&
        hasCodexDynamicToolIdentity(canonicalRequest.params, {
          namespace: CODEX_APP_TOOL_NAMESPACE,
          tool: "request_onboarding_input",
        })
      ) {
        const pending = inbox.find(
          "dynamic-tool",
          input.requestId,
          (candidate) =>
            candidate.disposition === "stored" &&
            matches(candidate) &&
            hasCodexDynamicToolIdentity(candidate.request.params, {
              namespace: CODEX_APP_TOOL_NAMESPACE,
              tool: "request_onboarding_input",
            }),
        );
        if (!pending) return null;
        const lifecycle = reduceCodexConversationOnboardingInputResponse(before, input.requestId);
        return lifecycle.selectedRequests.length === 0
          ? null
          : { before, lifecycle, normalized, pending, onboarding: true as const };
      }
      const pending = inbox.find("user-input", input.requestId, matches);
      if (!pending) return null;
      const lifecycle = reduceCodexConversationUserInputResponse(
        before,
        input.requestId,
        normalized.transcript,
        { now: () => observedAtMs },
      );
      return lifecycle.selectedRequests.length === 0
        ? null
        : { before, lifecycle, normalized, pending, onboarding: false as const };
    }).pipe(
      Effect.flatMap((prepared) => {
        if (!prepared) return Effect.succeed(false);
        return sync(() => {
          const matches = (entry: CodexPendingServerRequest) =>
            entry.threadId === input.threadId &&
            entry.hostId === prepared.pending.hostId &&
            entry.generation === prepared.pending.generation;
          if (prepared.onboarding) {
            const selected = inbox.takeAll(
              "dynamic-tool",
              input.requestId,
              (candidate) => candidate.disposition === "stored" && matches(candidate),
            );
            let completed = false;
            for (const entry of selected) {
              const matches = hasCodexDynamicToolIdentity(entry.request.params, {
                namespace: CODEX_APP_TOOL_NAMESPACE,
                tool: "request_onboarding_input",
              });
              inbox.complete(
                entry,
                !completed && matches
                  ? dynamicToolSuccess({ answers: prepared.normalized.protocol })
                  : CodexAppServerNoResponse,
              );
              completed ||= matches;
            }
          } else {
            const selected = inbox.takeAll("user-input", input.requestId, matches);
            for (const [index, entry] of selected.entries()) {
              inbox.complete(
                entry,
                index === 0 ? { answers: prepared.normalized.protocol } : CodexAppServerNoResponse,
              );
            }
          }
          inbox.abandonIdentity(input.threadId, input.requestId, prepared.pending);
          publishResolved({ type: "user-input", requestId: input.requestId });
        }).pipe(
          Effect.andThen(
            commit(input.threadId, {
              kind: "canonical",
              before: prepared.before,
              lifecycle: prepared.lifecycle,
            }),
          ),
          Effect.andThen(
            prepared.onboarding
              ? Effect.void
              : autoResolution.observeResponse(input.threadId, input.requestId, prepared.pending),
          ),
          Effect.as(true),
        );
      }),
    );
  const userInput: CodexServerRequestResponsesService["userInput"] = (input) =>
    runSerial(input.threadId, userInputInTransaction(input));

  const mcpElicitationInTransaction = (
    input: CodexMcpElicitationResponseInput,
    connection?: Pick<CodexPendingServerRequest, "hostId" | "generation">,
  ) =>
    syncAtCurrentTime((observedAtMs) => {
      const conversation = aggregate(input.threadId);
      const before = conversation?.readCanonicalState();
      if (!conversation || !before) return null;
      const pending = inbox.find(
        "mcp-elicitation",
        input.requestId,
        (candidate) =>
          candidate.threadId === input.threadId &&
          (!connection ||
            (candidate.hostId === connection.hostId &&
              candidate.generation === connection.generation)),
      );
      if (!pending) return null;
      const response = normalizeCodexMcpServerElicitationResponse(input.response);
      const lifecycle = reduceCodexConversationMcpElicitationResponse(
        before,
        input.requestId,
        response,
        { now: () => observedAtMs },
      );
      if (lifecycle.selectedRequests.length === 0) return null;
      for (const request of lifecycle.selectedRequests) {
        const entry = inbox.takeFirst(
          "mcp-elicitation",
          request.id,
          (candidate) =>
            candidate.threadId === input.threadId &&
            candidate.hostId === pending.hostId &&
            candidate.generation === pending.generation,
        );
        if (entry) inbox.complete(entry, response);
      }
      for (const requestId of new Set(lifecycle.selectedRequests.map((request) => request.id))) {
        inbox.abandonIdentity(input.threadId, requestId, pending);
      }
      return { before, lifecycle, pending };
    }).pipe(
      Effect.flatMap((prepared) =>
        prepared
          ? commit(input.threadId, {
              kind: "canonical",
              before: prepared.before,
              lifecycle: prepared.lifecycle,
            }).pipe(
              Effect.andThen(
                autoResolution.observeResponse(input.threadId, input.requestId, prepared.pending),
              ),
              Effect.as(true),
            )
          : Effect.succeed(false),
      ),
    );
  const mcpElicitation: CodexServerRequestResponsesService["mcpElicitation"] = (input) =>
    runSerial(input.threadId, mcpElicitationInTransaction(input));

  const permissionInTransaction = (input: CodexPermissionResponseInput) =>
    syncAtCurrentTime((observedAtMs) => {
      const conversation = aggregate(input.threadId);
      const before = conversation?.readCanonicalState();
      if (!conversation || !before) return null;
      const pending = inbox.find(
        "permission",
        input.requestId,
        (candidate) => candidate.threadId === input.threadId,
      );
      if (!pending) return null;
      const lifecycle = reduceCodexConversationPermissionResponse(
        before,
        input.requestId,
        input.response,
        { now: () => observedAtMs },
      );
      if (lifecycle.selectedRequests.length === 0) return null;
      const selected = inbox.takeAll(
        "permission",
        input.requestId,
        (candidate) => candidate.threadId === input.threadId,
      );
      for (const [index, entry] of selected.entries()) {
        inbox.complete(entry, index === 0 ? input.response : CodexAppServerNoResponse);
      }
      inbox.abandonIdentity(input.threadId, input.requestId);
      return { before, lifecycle };
    }).pipe(
      Effect.flatMap((prepared) =>
        prepared
          ? commit(input.threadId, {
              kind: "canonical",
              before: prepared.before,
              lifecycle: prepared.lifecycle,
            }).pipe(Effect.as(true))
          : Effect.succeed(false),
      ),
    );
  const permission: CodexServerRequestResponsesService["permission"] = (input) =>
    runSerial(input.threadId, permissionInTransaction(input));

  const storedPickerInTransaction = (
    input:
      | (CodexOptionPickerResponseInput & { readonly kind: "option" })
      | (CodexSetupContextPickerResponseInput & { readonly kind: "context" }),
  ) =>
    sync(() => {
      const conversation = aggregate(input.threadId);
      const before = conversation?.readCanonicalState();
      if (!conversation || !before) return null;
      const lifecycle =
        input.kind === "option"
          ? reduceCodexConversationOptionPickerResponse(before, input.requestId)
          : reduceCodexConversationSetupContextPickerResponse(before, input.requestId);
      const request = lifecycle.selectedRequests[0];
      if (!request) return null;
      const directMethod =
        input.kind === "option"
          ? "item/tool/requestOptionPicker"
          : "item/tool/requestSetupCodexContextPicker";
      const dynamicTool =
        input.kind === "option" ? "request_option_picker" : "setup_codex_context_picker";
      const isDirect = request.method === directMethod;
      const isDynamic =
        request.method === "item/tool/call" &&
        hasCodexDynamicToolIdentity(request.params, {
          namespace: CODEX_APP_TOOL_NAMESPACE,
          tool: dynamicTool,
        });
      let completed = false;
      for (const entry of inbox.takeAll(
        "private",
        input.requestId,
        (candidate) => candidate.threadId === input.threadId,
      )) {
        const matches = isDirect && entry.request.method === directMethod;
        inbox.complete(entry, !completed && matches ? input.response : CodexAppServerNoResponse);
        completed ||= matches;
      }
      for (const entry of inbox.takeAll(
        "dynamic-tool",
        input.requestId,
        (candidate) => candidate.disposition === "stored" && candidate.threadId === input.threadId,
      )) {
        const matches =
          isDynamic &&
          hasCodexDynamicToolIdentity(entry.request.params, {
            namespace: CODEX_APP_TOOL_NAMESPACE,
            tool: dynamicTool,
          });
        inbox.complete(
          entry,
          !completed && matches ? dynamicToolSuccess(input.response) : CodexAppServerNoResponse,
        );
        completed ||= matches;
      }
      inbox.abandonIdentity(input.threadId, input.requestId);
      return { before, lifecycle };
    }).pipe(
      Effect.flatMap((prepared) =>
        prepared
          ? commit(input.threadId, {
              kind: "canonical",
              before: prepared.before,
              lifecycle: prepared.lifecycle,
            }).pipe(Effect.as(true))
          : Effect.succeed(false),
      ),
    );
  const optionPicker: CodexServerRequestResponsesService["optionPicker"] = (input) =>
    runSerial(input.threadId, storedPickerInTransaction({ ...input, kind: "option" }));
  const setupContextPicker: CodexServerRequestResponsesService["setupContextPicker"] = (input) =>
    runSerial(input.threadId, storedPickerInTransaction({ ...input, kind: "context" }));

  const setupCodexStepInTransaction = (input: CodexSetupCodexStepResponseInput) =>
    sync(() => {
      const conversation = aggregate(input.threadId);
      const projection = conversation?.readServerRequestState();
      if (!conversation || !projection) return null;
      const canonical = projection.canonicalState;
      const lifecycle = canonical
        ? reduceCodexConversationSetupCodexStepResponse(canonical, input.requestId, input.response)
        : reduceCodexServerRequestSetupCodexStepResponseRawState(
            projection.rawState,
            input.requestId,
            input.response,
          );
      if (lifecycle.selectedRequests.length === 0) return null;
      const result = (() => {
        switch (input.response.step) {
          case "role":
            return {
              action: input.response.action,
              selectedRoles: [...input.response.selectedRoles],
            };
          case "task":
            return { action: input.response.action, answers: input.response.answers };
          case "context":
            return {
              action: input.response.action,
              selectedSources: [...input.response.selectedSources],
            };
        }
      })();
      let completed = false;
      for (const entry of inbox.takeAll(
        "dynamic-tool",
        input.requestId,
        (candidate) => candidate.disposition === "stored" && candidate.threadId === input.threadId,
      )) {
        const matches = hasCodexDynamicToolIdentity(entry.request.params, {
          namespace: CODEX_APP_TOOL_NAMESPACE,
          tool: "setup_codex_step",
        });
        inbox.complete(
          entry,
          !completed && matches ? dynamicToolSuccess(result) : CodexAppServerNoResponse,
        );
        completed ||= matches;
      }
      inbox.abandonIdentity(input.threadId, input.requestId);
      return canonical
        ? {
            kind: "canonical" as const,
            before: canonical,
            lifecycle: lifecycle as CodexServerRequestLifecycleResult,
          }
        : {
            kind: "raw" as const,
            lifecycle: lifecycle as CodexServerRequestRawLifecycleResult,
          };
    }).pipe(
      Effect.flatMap((prepared) =>
        prepared ? commit(input.threadId, prepared).pipe(Effect.as(true)) : Effect.succeed(false),
      ),
    );
  const setupCodexStep: CodexServerRequestResponsesService["setupCodexStep"] = (input) =>
    runSerial(input.threadId, setupCodexStepInTransaction(input));

  const declineAllInTransaction = (
    threadId: string,
  ): Effect.Effect<void, CodexServerRequestResponseProjectionError> =>
    sync(() => [...(aggregate(threadId)?.readServerRequests() ?? [])]).pipe(
      Effect.flatMap((requests) =>
        Effect.forEach(
          requests,
          (request) => {
            switch (request.method) {
              case "item/commandExecution/requestApproval":
                return approvalInTransaction({
                  threadId,
                  requestId: request.id,
                  response: { kind: "command", decision: "decline" },
                }).pipe(Effect.asVoid);
              case "item/fileChange/requestApproval":
                return approvalInTransaction({
                  threadId,
                  requestId: request.id,
                  response: { kind: "file", decision: "decline" },
                }).pipe(Effect.asVoid);
              case "item/permissions/requestApproval":
                return permissionInTransaction({
                  threadId,
                  requestId: request.id,
                  response: { permissions: {}, scope: "turn" },
                }).pipe(Effect.asVoid);
              case "item/tool/requestUserInput":
                return userInputInTransaction({
                  threadId,
                  requestId: request.id,
                  answers: {},
                }).pipe(Effect.asVoid);
              case "item/tool/requestOptionPicker":
                return storedPickerInTransaction({
                  threadId,
                  requestId: request.id,
                  kind: "option",
                  response: {
                    action: "dismiss",
                    selectedOptions: [],
                    freeformAnswer: null,
                  },
                }).pipe(Effect.asVoid);
              case "item/tool/requestSetupCodexContextPicker":
                return storedPickerInTransaction({
                  threadId,
                  requestId: request.id,
                  kind: "context",
                  response: { action: "dismiss", selectedSources: [] },
                }).pipe(Effect.asVoid);
              case "mcpServer/elicitation/request":
                return mcpElicitationInTransaction({
                  threadId,
                  requestId: request.id,
                  response: "decline" as CodexMcpServerElicitationAction,
                }).pipe(Effect.asVoid);
              default:
                return Effect.void;
            }
          },
          { concurrency: 1, discard: true },
        ),
      ),
    );

  yield* autoResolution.timeouts.pipe(
    Stream.runForEach(({ conversationId, requestId, connection, responseKind }) =>
      runSerial(
        conversationId,
        Effect.gen(function* () {
          // Timeout delivery may wait behind another command while the native process reconnects.
          const current = yield* gateway
            .connection(connection.hostId)
            .pipe(Effect.mapError(transactionError));
          if (current.kind !== "ready" || current.generation !== connection.generation) return true;
          if (responseKind === "declineMcpElicitation") {
            return yield* mcpElicitationInTransaction(
              { threadId: conversationId, requestId, response: "decline" },
              connection,
            );
          }
          return yield* userInputInTransaction(
            { threadId: conversationId, requestId, answers: {} },
            connection,
          );
        }),
      ).pipe(
        Effect.flatMap((accepted) =>
          accepted
            ? Effect.void
            : Effect.logWarning("Could not auto-resolve Codex request").pipe(
                Effect.annotateLogs({
                  cause: "request-not-pending",
                  conversationId,
                  requestId: String(requestId),
                  responseKind,
                }),
              ),
        ),
        Effect.catch((error) =>
          Effect.logWarning("Could not auto-resolve Codex request").pipe(
            Effect.annotateLogs({
              cause: String(error.cause),
              conversationId,
              requestId: String(requestId),
              responseKind,
            }),
          ),
        ),
      ),
    ),
    Effect.forkScoped({ startImmediately: true }),
  );

  return CodexServerRequestResponses.of({
    native,
    approval,
    userInput,
    mcpElicitation,
    permission,
    optionPicker,
    setupContextPicker,
    setupCodexStep,
    declineAll: (threadId) => runSerial(threadId, declineAllInTransaction(threadId)),
    declineAllInTransaction,
  });
});
