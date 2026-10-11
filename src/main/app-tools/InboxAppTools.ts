import * as Effect from "effect/Effect";
import { sendToInboxSchema } from "../../shared/nodex-app-tools/inbox-schema";
import { CodexTurnAuthority } from "../codex-application/CodexTurnAuthority";
import { toCoreAgentTurnProvenance } from "../core-client/core-agent-execution-authorization";
import { CoreModuleResponseError } from "../core-client/core-client";
import { CoreAuthority } from "../core-runtime/CoreAuthority";
import { CoreModules } from "../core-runtime/CoreModules";
import { createStableOperationId } from "../core-runtime/operation-identity";
import { captureAppToolAuthority } from "./AppToolCaller";
import type { AppToolInvocation } from "./AppToolInvocationInbox";
import { toolFailure, toolSuccess } from "./app-tool-result";
import { deriveSessionDispatchIdentity } from "./session-dispatch-identity";

const sendFailure = (error: { readonly cause?: unknown }): string => {
  if (!(error.cause instanceof CoreModuleResponseError)) return "inbox_unavailable";
  const code = error.cause.coreError.code;
  if (code === "resource_exhausted") return "inbox_turn_limit";
  if (code === "unauthorized") return "inbox_unauthorized";
  return "inbox_unavailable";
};

/**
 * The Inbox is append-only for Agents: a Turn can leave a few messages, recorded by Core as
 * coming from its chat, and cannot read or route anything already there.
 */
export const make = Effect.gen(function* () {
  const turns = yield* CodexTurnAuthority;
  const identity = yield* CoreAuthority;
  const core = yield* CoreModules;

  return Effect.fn("InboxAppTools.execute")(function* (input: AppToolInvocation) {
    const parsed = sendToInboxSchema.safeParse(input.arguments);
    if (!parsed.success) return toolFailure("invalid_arguments");
    if (!input.caller.isActive()) return toolFailure("call_withdrawn");
    const authority = yield* captureAppToolAuthority(input.caller, turns);
    if (!authority) return toolFailure("authority_unavailable");
    if (authority.readOnly) return toolFailure("read_only_turn");
    const operationId =
      parsed.data.operationId ??
      createStableOperationId("app.send_to_inbox", authority.frozenAtMs, [
        identity.identity.profileId,
        input.caller.threadId,
        input.caller.turnId,
        input.caller.callId,
      ]);
    const pageId = deriveSessionDispatchIdentity(operationId, "inbox-page");
    const provenance = toCoreAgentTurnProvenance(identity.identity.profileId, authority);
    const sent = yield* core.workspace
      .apply(
        {
          operationId,
          intent: {
            kind: "agent_command",
            provenance,
            intent: {
              kind: "send_inbox_message",
              page_id: pageId,
              document_id: deriveSessionDispatchIdentity(operationId, "inbox-document"),
              text: parsed.data.text,
              ...(parsed.data.title ? { title: parsed.data.title } : {}),
            },
          },
        },
        undefined,
        provenance.authority.actor_project_id,
      )
      .pipe(
        Effect.map((applied) => ({ ok: true as const, replay: applied.receipt.duplicate })),
        Effect.catch((error) => Effect.succeed({ ok: false as const, code: sendFailure(error) })),
      );
    if (!sent.ok) return toolFailure(sent.code, undefined, { operationId });
    return toolSuccess({ operationId, pageId, ...(sent.replay ? { replay: true } : {}) });
  });
});
