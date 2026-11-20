import * as Effect from "effect/Effect";
import { discussionCommandSchema } from "../../shared/discussions";
import {
  discussionToolSchemas,
  isDiscussionTool,
} from "../../shared/nodex-app-tools/discussion-schemas";
import { CodexTurnAuthority } from "../codex-application/CodexTurnAuthority";
import { toCoreAgentExecutionAuthorization } from "../core-client/core-agent-execution-authorization";
import { CoreModuleResponseError } from "../core-client/core-client";
import { CoreAuthority } from "../core-runtime/CoreAuthority";
import { CoreModules } from "../core-runtime/CoreModules";
import { captureAppToolAuthority } from "./AppToolCaller";
import type { NodexAgentTurnContext } from "../../shared/nodex-agent-authority";
import type { AppToolCaller } from "./AppToolCaller";
import type { AppToolInvocation } from "./AppToolInvocationInbox";
import { make as makeAppToolOperation } from "./AppToolOperation";
import { parseAppToolArguments, toolFailure, toolSuccess } from "./app-tool-result";

const failure = (error: { cause?: unknown }) =>
  error.cause instanceof CoreModuleResponseError
    ? toolFailure(error.cause.coreError.code, error.cause.coreError.message)
    : toolFailure("discussion_unavailable");

export const makeWithCapture = (
  capture: (caller: AppToolCaller) => Effect.Effect<NodexAgentTurnContext | null>,
) =>
  Effect.gen(function* () {
    const root = yield* CoreAuthority;
    const core = yield* CoreModules;
    const admit = yield* makeAppToolOperation;
    return Effect.fn("DiscussionAppTools.execute")(function* (input: AppToolInvocation) {
      const { name, caller, arguments: args } = input;
      if (!isDiscussionTool(name)) return toolFailure("unknown_tool");
      const authority = yield* capture(caller);
      if (!authority || !caller.isActive()) return toolFailure("authority_unavailable");
      const authorization = toCoreAgentExecutionAuthorization(
        root.identity.profileId,
        authority,
        caller.callId,
      );
      const project = authority.actorProjectId;
      if (name === "discussions_list") {
        const parsed = parseAppToolArguments(discussionToolSchemas.discussions_list, args);
        if (!parsed.success) return parsed.result;
        const { pageId, status, waiting, cursor, limit } = parsed.data;
        return yield* core.library
          .read(
            {
              kind: "discussions",
              provenance: authorization.provenance,
              page_id: pageId ?? null,
              status: status === "all" ? null : (status ?? null),
              waiting: waiting ?? null,
              cursor: cursor ?? null,
              limit: limit ?? null,
            },
            undefined,
            project,
          )
          .pipe(
            Effect.map(({ value }) =>
              value.kind === "discussions" && caller.isActive()
                ? toolSuccess(value.value)
                : toolFailure("discussion_unavailable"),
            ),
            Effect.catch((error) => Effect.succeed(failure(error))),
          );
      }
      if (name === "discussions_show") {
        const parsed = parseAppToolArguments(discussionToolSchemas.discussions_show, args);
        if (!parsed.success) return parsed.result;
        return yield* core.library
          .read(
            {
              kind: "discussion",
              discussion_id: parsed.data.discussionId,
              provenance: authorization.provenance,
            },
            undefined,
            project,
          )
          .pipe(
            Effect.map(({ value }) =>
              value.kind === "discussion" && caller.isActive()
                ? toolSuccess(value.value)
                : toolFailure("discussion_unavailable"),
            ),
            Effect.catch((error) => Effect.succeed(failure(error))),
          );
      }
      const parsed = parseAppToolArguments(discussionToolSchemas[name], args);
      if (!parsed.success) return parsed.result;
      const { idempotencyKey, ...fields } = parsed.data;
      const command = discussionCommandSchema.parse({
        ...fields,
        kind: name.slice("discussions_".length),
      });
      const identity = yield* admit(input, authority, root.identity.profileId, {
        idempotencyKey,
        ...command,
      });
      if (!identity.success) return identity.result;
      if (!caller.isActive()) return toolFailure("call_withdrawn");
      return yield* core.library
        .apply(
          {
            operationId: identity.operationId,
            intent: { kind: "discussion", command, authorization },
          },
          project,
        )
        .pipe(
          Effect.map(({ outcome }) =>
            outcome.discussion && caller.isActive()
              ? toolSuccess(outcome.discussion)
              : toolFailure("discussion_unavailable"),
          ),
          Effect.catch((error) => Effect.succeed(failure(error))),
        );
    });
  });

export const make = Effect.gen(function* () {
  const turns = yield* CodexTurnAuthority;
  return yield* makeWithCapture((caller) => captureAppToolAuthority(caller, turns));
});
