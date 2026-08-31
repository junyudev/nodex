import { CodexAppServerNoResponse } from "@nodex/effect-codex-app-server/protocol";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  reduceCodexServerRequestRawState,
  type CodexServerRequestRawState,
} from "../../shared/codex-conversation-state/codex-server-request-lifecycle";
import type { CodexServerRequest } from "../codex-runtime/CodexApplicationProtocol";

export type CodexOneShotServerRequest = Extract<
  CodexServerRequest,
  {
    readonly method:
      | "account/chatgptAuthTokens/refresh"
      | "applyPatchApproval"
      | "attestation/generate"
      | "currentTime/read"
      | "execCommandApproval";
  }
>;

const methods: ReadonlySet<CodexOneShotServerRequest["method"]> = new Set([
  "account/chatgptAuthTokens/refresh",
  "applyPatchApproval",
  "attestation/generate",
  "currentTime/read",
  "execCommandApproval",
]);

export const isCodexOneShotServerRequestMethod = (method: string): boolean =>
  methods.has(method as CodexOneShotServerRequest["method"]);

export const isCodexOneShotServerRequest = (
  request: CodexServerRequest,
): request is CodexOneShotServerRequest => isCodexOneShotServerRequestMethod(request.method);

export class CodexOneShotServerRequests extends Context.Service<
  CodexOneShotServerRequests,
  {
    readonly handle: (request: CodexOneShotServerRequest) => Effect.Effect<unknown>;
  }
>()("nodex/main/codex-application/CodexOneShotServerRequests") {}

const requestThreadId = (request: CodexOneShotServerRequest): string => {
  if ("threadId" in request.params && typeof request.params.threadId === "string") {
    return request.params.threadId;
  }
  if ("conversationId" in request.params && typeof request.params.conversationId === "string") {
    return request.params.conversationId;
  }
  return "";
};

/** Pure protocol-owned responses that never enter a conversation command lane. */
export const live: Layer.Layer<CodexOneShotServerRequests> = Layer.succeed(
  CodexOneShotServerRequests,
  CodexOneShotServerRequests.of({
    handle: (request) =>
      Clock.currentTimeMillis.pipe(
        Effect.map((observedAtMs) => {
          const initial: CodexServerRequestRawState = {
            threadId: requestThreadId(request),
            turns: [],
            requests: [],
            hasUnreadTurn: false,
          };
          const lifecycle = reduceCodexServerRequestRawState(initial, request, {
            now: () => observedAtMs,
            isOpenAIFormElicitationsEnabled: true,
          });
          const response = lifecycle.effects.find((effect) => effect.type === "respond");
          return response?.type === "respond" ? response.response : CodexAppServerNoResponse;
        }),
      ),
  }),
);
