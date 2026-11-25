import { ChatSearch } from "../chat-search/ChatSearch";
import { makeFindService, findBlockSource } from "../find/FindService";
import { LibraryModule } from "../library-application/LibraryModule";
import { CoreModules } from "../core-runtime/CoreModules";
import { toCoreAgentExecutionAuthorization } from "../core-client/core-agent-execution-authorization";
import { searchInputSchema } from "../../shared/nodex-app-tools/find-contract";
import { buildPageDeepLink, buildSessionDeepLink } from "../../shared/nodex-deeplink";
import { pageBlockUrl } from "../../shared/nodex-app-tools/reference-urls";
import type { FindHit } from "../../shared/find";
import { toolResultBytes } from "./app-tool-result";
import { captureAppToolAuthority } from "./AppToolCaller";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import { nodexAgentAuthorityFingerprint } from "../../shared/nodex-agent-authority";
import {
  appContentToolContracts,
  isContentTool,
} from "../../shared/nodex-app-tools/content-catalog";
import { CodexTurnAuthority } from "../codex-application/CodexTurnAuthority";
import { createStableOperationId } from "../core-runtime/operation-identity";
import { executeNodexAgentV3Tool } from "../nodex-agent-application/NodexAgentDynamicExecution";
import { NodexAgentApplication } from "../nodex-agent-application/NodexAgentApplication";
import { NodexAgentDynamicToolFailure } from "../nodex-agent-application/NodexAgentDynamicExecutionContext";
import { CoreAuthority } from "../core-runtime/CoreAuthority";
import { make as makeAppToolOperation } from "./AppToolOperation";
import type { AppToolInvocation } from "./AppToolInvocationInbox";
import { NodexAppToolAuthority } from "./NodexAppToolAuthority";
import { parseAppToolArguments, toolFailure, toolSuccess } from "./app-tool-result";
import type { AppToolCaller } from "./AppToolCaller";
import type { NodexAgentTurnContext } from "../../shared/nodex-agent-authority";

const resultUrl = (hit: FindHit): string => {
  switch (hit.kind) {
    case "block":
      return pageBlockUrl(hit.pageId, hit.identity);
    case "chat":
      return buildSessionDeepLink({ sessionId: hit.identity });
    case "page":
      return buildPageDeepLink({ pageId: hit.identity });
  }
};

export const makeWithCapture = (
  captureCaller: (caller: AppToolCaller) => Effect.Effect<NodexAgentTurnContext | null>,
) =>
  Effect.gen(function* () {
    const authorities = yield* NodexAppToolAuthority;
    const application = yield* NodexAgentApplication;
    const core = yield* CoreAuthority;
    const admit = yield* makeAppToolOperation;
    const chats = yield* ChatSearch;
    const library = yield* LibraryModule;
    const modules = yield* CoreModules;
    const find = makeFindService({
      ...chats,
      searchPages: library.searchPages,
      searchBlocks: findBlockSource(modules),
    });
    return Effect.fn("ContentAppTools.execute")(function* (input: AppToolInvocation) {
      if (!isContentTool(input.name)) return toolFailure("unknown_tool");
      const parsed = parseAppToolArguments(
        appContentToolContracts[input.name].inputSchema,
        input.arguments,
      );
      if (!parsed.success) return parsed.result;
      if (!input.caller.isActive()) return toolFailure("call_withdrawn");
      const capture = captureCaller(input.caller);
      const authority = yield* capture;
      if (!authority) return toolFailure("authority_unavailable");
      const fingerprint = nodexAgentAuthorityFingerprint(authority);
      const isCurrent = Effect.gen(function* () {
        if (!input.caller.isActive()) return false;
        const current = yield* capture;
        return (
          current !== null &&
          nodexAgentAuthorityFingerprint(current) === fingerprint &&
          input.caller.isActive()
        );
      });
      const bound = yield* authorities.bind({
        authority,

        isCurrent,
      });
      const callerAuthority = bound.authority;
      if (!callerAuthority) return toolFailure("authority_unavailable");
      if (input.name === "search") {
        return yield* Effect.gen(function* () {
          const request = searchInputSchema.parse(parsed.data);
          const authorization = toCoreAgentExecutionAuthorization(
            core.identity.profileId,
            callerAuthority,
            input.caller.callId,
          );
          yield* modules.library.read({ kind: "authorize_agent_search", authorization });
          const limit = request.limit ?? 20;
          for (let count = limit; count > 0; count = Math.floor(count / 2)) {
            const result = yield* find(
              {
                ...request,
                query: request.query.trim(),
                kinds: request.kinds ?? ["page", "chat"],
                place: request.place ?? { kind: "everywhere" },
                preferredProjectId: authority.actorProjectId ?? undefined,
                limit: count,
              },
              "complete",
            );
            if (!(yield* isCurrent)) return toolFailure("call_withdrawn");
            const output = {
              data: {
                results: result.hits.map((hit) => ({
                  kind: hit.kind,
                  identity: hit.identity,
                  url: resultUrl(hit),
                  title: hit.title,
                  location: hit.location,
                  evidence: hit.evidence,
                  rank: hit.rank,
                  archived: hit.archived,
                })),
                truncated: result.truncated,
                coverage: result.coverage,
              },
              page: {
                hasMore: result.nextCursor !== null,
                ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
              },
            };
            if (toolResultBytes(output) <= 32 * 1024)
              return toolSuccess(
                appContentToolContracts.search.outputSchema.parse(output),
                32 * 1024,
              );
          }
          return toolFailure("source_limit", "The search result exceeds the response budget.");
        }).pipe(Effect.catch(() => Effect.succeed(toolFailure("search_unavailable"))));
      }
      const contract = appContentToolContracts[input.name];
      const { idempotencyKey, ...args } = parsed.data as Record<string, unknown>;
      let operationId = createStableOperationId(`app.${input.name}`, authority.admittedAtMs, [
        input.caller.threadId,
        input.caller.turnId,
        input.caller.callId,
      ]);
      if (typeof idempotencyKey === "string") {
        const operation = yield* admit(input, authority, core.identity.profileId, {
          ...args,
          idempotencyKey,
        });
        if (!operation.success) return operation.result;
        if (!(yield* isCurrent)) return toolFailure("call_withdrawn");
        operationId = operation.operationId;
      }
      return yield* executeNodexAgentV3Tool(input.name, args, {
        ...bound,
        threadId: input.caller.threadId,
        callId: input.caller.callId,
        operationId,
      }).pipe(
        Effect.provideService(NodexAgentApplication, application),
        Effect.map((output) => {
          const validated = contract.serializeOutput(output);
          if (!validated.success) return toolFailure("invalid_result", undefined, { operationId });
          if (!input.caller.isActive())
            return toolFailure("call_withdrawn", undefined, { operationId });
          return toolSuccess(validated.data);
        }),
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt;
          const error = Cause.squash(cause);
          return Effect.succeed(
            error instanceof NodexAgentDynamicToolFailure
              ? toolFailure(error.failure.error.code, error.failure.error.message, {
                  ...error.failure.error,
                  operationId,
                })
              : toolFailure("content_command_failed", undefined, { operationId }),
          );
        }),
      );
    });
  });

export const make = Effect.gen(function* () {
  const turns = yield* CodexTurnAuthority;
  return yield* makeWithCapture((caller) => captureAppToolAuthority(caller, turns));
});
