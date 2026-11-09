import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { parseBase64DataUrl } from "@nodex/agent-runtime/image-mime";
import type { components } from "@nodex/core-protocol";
import { handBackMessageSchema } from "../../shared/nodex-app-tools/work-schema";
import { AgentRuntimeApplication } from "../agent-runtime/AgentRuntimeApplication";
import { CoreAuthority, CoreSessionAccess } from "../core-runtime/CoreAuthority";
import { CoreModules } from "../core-runtime/CoreModules";
import { CoreApplicationAgent } from "../core-runtime/CoreApplicationAgent";
import { CoreModuleResponseError } from "../core-client/core-client";
import { toCoreAgentTurnProvenance } from "../core-client/core-agent-execution-authorization";
import { CodexTurnAuthority } from "../codex-application/CodexTurnAuthority";
import {
  captureAppToolAuthority,
  readHostedAppToolSessionContext,
  type AppToolCaller,
} from "./AppToolCaller";
import { make as makeAppToolOperation } from "./AppToolOperation";
import { deriveSessionDispatchIdentity } from "./session-dispatch-identity";
import { parseAppToolArguments, toolFailure, toolSuccess } from "./app-tool-result";
import type { AppToolInvocation } from "./AppToolInvocationInbox";
import type { NodexAgentTurnContext } from "../../shared/nodex-agent-authority";

type BinaryAttachment = Extract<
  NonNullable<import("../../shared/agent-runtime-api").AgentRuntimeMessage["attachments"]>[number],
  { readonly type: "image" | "file" }
>;
export const makeWithCapture = (
  capture: (caller: AppToolCaller) => Effect.Effect<NodexAgentTurnContext | null>,
) =>
  Effect.gen(function* () {
    const core = yield* CoreModules;
    const identity = yield* CoreAuthority;
    const sessions = yield* CoreSessionAccess;
    const runtime = yield* AgentRuntimeApplication;
    const fs = yield* FileSystem.FileSystem;
    const admit = yield* makeAppToolOperation;
    return Effect.fn("MessageHandbackAppTools.execute")(
      function* (input: AppToolInvocation) {
        const parsed = parseAppToolArguments(handBackMessageSchema, input.arguments);
        if (!parsed.success) return parsed.result;
        const context = readHostedAppToolSessionContext(input.caller);
        const authority = yield* capture(input.caller);
        if (
          !authority ||
          !context?.runId ||
          !context.inboundMessageId ||
          authority.runtime?.sessionId !== context.sessionId
        )
          return toolFailure(
            "inbound_unavailable",
            "Handback requires a managed chat with a trusted current inbound message.",
          );
        const current = yield* core.workspace.read(
          { kind: "chat_message_inbound", session_id: context.sessionId, run_id: context.runId },
          undefined,
          null,
        );
        const inbound =
          current.value.kind === "chat_message_inbound" ? current.value.inbound : null;
        if (!inbound || inbound.delivery_id !== context.inboundMessageId)
          return toolFailure(
            "inbound_unavailable",
            "The current inbound delivery could not be proved; nothing was returned to the Inbox.",
          );
        if (inbound.question_answered && !inbound.receipt)
          return toolFailure(
            "question_answered",
            "An already-answered question cannot be handed back.",
          );
        const operation = yield* admit(input, authority, identity.identity.profileId, parsed.data);
        if (!operation.success) return operation.result;
        let message: components["schemas"]["HandbackMessage"] | null = null;
        if (!inbound.receipt && inbound.original_page_ids.length === 0) {
          const original = yield* runtime.readRunMessage({
            sessionId: context.sessionId,
            threadId: context.threadId,
            runId: context.runId,
          });
          if (!original || original.id !== inbound.delivery_id)
            return toolFailure(
              "message_unavailable",
              "The original inbound message is unavailable; nothing was returned to the Inbox.",
            );
          const attachments = original.attachments.filter(
            (attachment): attachment is BinaryAttachment =>
              attachment.type === "image" || attachment.type === "file",
          );
          const files: components["schemas"]["LibraryFileChange"][] = [];
          for (const attachment of attachments) {
            const resource = yield* runtime.messageAttachment({
              sessionId: context.sessionId,
              threadId: context.threadId,
              messageId: original.id,
              attachmentId: attachment.id,
            });
            if (!resource)
              return toolFailure(
                "attachment_unavailable",
                "An inbound attachment is unavailable; nothing was returned to the Inbox.",
              );
            const bytes =
              "path" in resource
                ? yield* fs.readFile(resource.path)
                : Buffer.from(parseBase64DataUrl(resource.dataUrl)?.base64 ?? "", "base64");
            if (bytes.byteLength !== attachment.sizeBytes)
              return toolFailure(
                "attachment_changed",
                "An inbound attachment changed; nothing was returned to the Inbox.",
              );
            const blob = yield* sessions.use(
              "handback.prepare-file",
              (client, signal) =>
                client.prepareFileBlob(
                  { operationId: operation.operationId, idempotencySlot: attachment.id, bytes },
                  { signal },
                ),
              { projectId: null },
            );
            files.push({
              kind: "create",
              file_id: deriveSessionDispatchIdentity(
                operation.operationId,
                `inbound-file:${attachment.id}`,
                operation.acceptedAtMs,
              ),
              default_name: attachment.name,
              mime_type: attachment.mimeType,
              prepared_blob_receipt_id: blob.receipt_id,
            });
          }
          message = { text: original.text, files };
        }
        if (!input.caller.isActive()) return toolFailure("call_withdrawn");
        const stillCurrent = yield* capture(input.caller);
        if (
          !stillCurrent ||
          stillCurrent.turnId !== authority.turnId ||
          stillCurrent.storeEpoch !== authority.storeEpoch
        )
          return toolFailure(
            "authority_unavailable",
            "The inbound execution changed; nothing was returned to the Inbox.",
          );
        const provenance = toCoreAgentTurnProvenance(identity.identity.profileId, authority);
        yield* core.workspace
          .apply(
            {
              operationId: operation.operationId,
              intent: {
                kind: "agent_command",
                provenance,
                intent: {
                  kind: "hand_back_message",
                  reason: parsed.data.reason,
                  page_id: deriveSessionDispatchIdentity(
                    operation.operationId,
                    "handback-page",
                    operation.acceptedAtMs,
                  ),
                  document_id: deriveSessionDispatchIdentity(
                    operation.operationId,
                    "handback-document",
                    operation.acceptedAtMs,
                  ),
                  message,
                },
              },
            },
            undefined,
            authority.actorProjectId,
          )
          .pipe(Effect.provideService(CoreApplicationAgent, null));
        const result = yield* core.workspace.read(
          { kind: "chat_message_inbound", session_id: context.sessionId, run_id: context.runId },
          undefined,
          null,
        );
        const receipt =
          result.value.kind === "chat_message_inbound" ? result.value.inbound?.receipt : null;
        return receipt
          ? toolSuccess({
              recorded: true,
              receiptId: receipt.receipt_id,
              pageIds: receipt.page_ids,
            })
          : toolFailure("handback_unavailable", "The handback receipt is unavailable.");
      },
      Effect.catch((error) =>
        Effect.succeed(
          toolFailure(
            "handback_unavailable",
            error instanceof Object &&
              "cause" in error &&
              error.cause instanceof CoreModuleResponseError
              ? error.cause.coreError.message
              : "The message could not be handed back.",
          ),
        ),
      ),
    );
  });
export const make = Effect.gen(function* () {
  const turns = yield* CodexTurnAuthority;
  return yield* makeWithCapture((caller) => captureAppToolAuthority(caller, turns));
});
