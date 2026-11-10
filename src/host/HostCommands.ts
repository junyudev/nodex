import { InboxSkillAvailabilityInputSchema } from "../shared/schemas/inbox";
import * as Effect from "effect/Effect";
import { z } from "zod";
import type { components } from "@nodex/core-protocol";
import * as Inputs from "../shared/schemas/agent-runtime-api";
import {
  InboxChatTargetsInputSchema,
  InboxConfirmationDraftSchema,
  InboxConfirmInputSchema,
  InboxDispatchInputSchema,
  InboxProposalInputSchema,
  InboxSendInputSchema,
  InboxSuggestionRequestInputSchema,
  InboxSuggestionStopInputSchema,
} from "../shared/schemas/inbox";
import {
  ProjectSessionArchiveCommandSchema,
  ProjectSessionRenameCommandSchema,
} from "../shared/schemas/project-session-commands";
import { startWorkInputSchema } from "../shared/work-application";
import {
  ChatMessageSearchInputSchema,
  ChatSearchInputSchema,
} from "../main/chat-search/ChatSearch";
import { rendererLocalCommitApply } from "../main/core-client/types";
import type { HeadlessHost } from "./HeadlessApplicationLive";
import { HostInvocation } from "./HostInvocation";
import { hostLocalCommit } from "./host-local-commit";

const response = Inputs.AgentRuntimeResponseSchema.omit({ attachmentsByQuestionId: true }).strict();
const replyDestination = z.strictObject({
  pageId: z.string().min(1).max(512),
  body: z.string().max(120_000),
});
const page = z.strictObject({ pageId: z.string().min(1).max(512) });

/** The same application owners serve desktop and headless execution; only this admitted surface crosses HTTPS. */
export const executeHostCommand = (
  host: HeadlessHost["Service"],
  invocation: components["schemas"]["HostInvocation"],
) =>
  Effect.gen(function* () {
    const { operation, input } = invocation.call;
    const { sessions, work, inbox } = host;
    switch (operation) {
      case "coordinator_open":
        z.strictObject({}).parse(input);
        return yield* host.coordinator.ensure();
      // What the host's Inbox runs on; a Member's own consent to start their requests is Core's.
      case "inbox_settings":
        z.strictObject({}).parse(input);
        return (yield* host.settings.snapshot()).inbox;
      case "activity":
        return yield* host.activity.read;
      case "connection":
        return yield* host.activity.connection;
      case "providers":
        return yield* sessions.catalog(Inputs.AgentRuntimeCatalogSchema.parse(input));
      case "session_read":
        return yield* sessions.read(Inputs.AgentRuntimeTargetSchema.parse(input));
      case "session_control":
        return yield* sessions.control(Inputs.AgentRuntimeControlSchema.parse(input));
      case "session_inspect":
        return yield* sessions.inspect(Inputs.AgentRuntimeTargetSchema.parse(input));
      // Read with the Member's invocation, so only a chat they may read is named.
      case "thread_identity":
        return yield* sessions.identify(
          Inputs.AgentRuntimeThreadIdentitySchema.parse(input).threadId,
        );
      case "session_history":
        return yield* sessions.history(Inputs.AgentRuntimeHistorySchema.parse(input));
      case "session_message":
        return yield* host.messages.send(Inputs.HostedChatMessageInputSchema.parse(input));
      case "session_queue":
        return yield* host.messages.queue(Inputs.HostedChatQueueSchema.parse(input));
      // Core admits an edit only from the message's author, while no other Member has replied.
      case "session_rewrite_message":
        return yield* host.messages.rewrite(Inputs.HostedChatRewriteSchema.parse(input));
      case "session_respond":
        return yield* sessions.respond(response.parse(input));
      // Core admits these only from the Run's requester, the chat's owner or a Space Owner.
      case "session_stop":
        return yield* sessions.stop(Inputs.AgentRuntimeStopSchema.parse(input));
      case "session_stop_task":
        return yield* sessions.stopTask(Inputs.AgentRuntimeTaskStopSchema.parse(input));
      case "session_cancel_task":
        return yield* sessions.cancelTask(Inputs.AgentRuntimeTaskCancelSchema.parse(input));
      case "session_stop_background":
        return yield* sessions.stopBackground(Inputs.AgentRuntimeBackgroundStopSchema.parse(input));
      case "session_background_output":
        return yield* sessions.backgroundOutput(
          Inputs.AgentRuntimeBackgroundOutputSchema.parse(input),
        );
      case "session_prompt_turns":
        return yield* sessions.promptTurns(Inputs.AgentRuntimePromptTurnsSchema.parse(input));
      case "session_prompt_index":
        return yield* sessions.promptIndex(Inputs.AgentRuntimeTargetSchema.parse(input));
      case "session_queue_read":
        return yield* sessions.readQueuePage(Inputs.AgentRuntimeQueueReadSchema.parse(input));
      case "session_item":
        return yield* sessions.item(Inputs.AgentRuntimeItemSchema.parse(input));
      case "session_attachment":
        return yield* host.attachments.read(Inputs.HostedChatAttachmentReadSchema.parse(input));
      case "session_overview":
        return yield* sessions.overview(Inputs.AgentRuntimeOverviewSchema.parse(input));
      case "session_queued_preview":
        return yield* sessions.readQueuedPreview(Inputs.AgentRuntimeRunSchema.parse(input));
      case "session_run_message":
        return yield* sessions.readRunMessage(Inputs.AgentRuntimeRunSchema.parse(input));
      // Core admitted the Member's start of a new chat, or of their own draft; they own it.
      case "session_start":
        return yield* host.messages.start(Inputs.HostedChatStartSchema.parse(input));
      // Core admitted the Member's read of the source; that Member owns the new chat.
      case "session_fork":
        return yield* sessions.fork(Inputs.HostedChatForkSchema.parse(input));
      // Each side chat answers to the Member who opened it; Core admitted the action for them.
      case "session_side_chat_create":
        return yield* sessions.createSideChat(Inputs.AgentRuntimeSideChatCreateSchema.parse(input));
      case "session_side_chat_delete":
        return yield* sessions.deleteSideChat(Inputs.AgentRuntimeSideChatDeleteSchema.parse(input));
      case "session_merge_back":
        return yield* sessions.mergeBack(Inputs.AgentRuntimeMergeBackSchema.parse(input));
      // Core admitted whoever may manage the chat: its owner or a Space Owner.
      case "session_compact":
        return yield* sessions.compact(Inputs.AgentRuntimeCompactSchema.parse(input));
      case "session_clear_context":
        return yield* sessions.clearContext(Inputs.AgentRuntimeClearContextSchema.parse(input));
      // Core admits these only from whoever may manage the chat: its owner or a Space Owner.
      case "session_rename":
        return yield* hostLocalCommit(
          sessions.renameSession(ProjectSessionRenameCommandSchema.parse(input)),
        );
      case "session_archive":
        return yield* hostLocalCommit(
          sessions.archiveSession(ProjectSessionArchiveCommandSchema.parse(input)),
        );
      case "session_unarchive":
        return yield* hostLocalCommit(
          sessions.unarchiveSession(ProjectSessionArchiveCommandSchema.parse(input)),
        );
      case "session_move":
        return yield* sessions.moveSession(Inputs.AgentRuntimeSessionMoveSchema.parse(input));
      case "workspace_refresh":
        return yield* sessions.refreshPageWorkspace(page.parse(input).pageId);
      case "work_start": {
        const parsed = startWorkInputSchema.parse(input);
        if (!parsed.operationId)
          return yield* Effect.fail(new Error("Work requires an operation identity"));
        const { value, apply } = yield* work.startWork(parsed);
        return { ok: true, value, localCommit: rendererLocalCommitApply(apply) };
      }
      case "inbox_reply_destination": {
        const parsed = replyDestination.parse(input);
        return yield* inbox.replyDestination(parsed.pageId, parsed.body);
      }
      case "inbox_send":
        return yield* hostLocalCommit(inbox.send(InboxSendInputSchema.parse(input)));
      // The host resolves the decision's Agent from its own catalog; Core confirms it with
      // the requesting Member's authority, exactly as for a phone.
      case "inbox_skill_availability":
        return yield* inbox.skillAvailability(InboxSkillAvailabilityInputSchema.parse(input));
      case "inbox_prepare_confirmation":
        return yield* inbox.prepareConfirmation(InboxConfirmationDraftSchema.parse(input));
      case "inbox_confirm":
        return yield* hostLocalCommit(inbox.confirm(InboxConfirmInputSchema.parse(input)));
      case "inbox_dispatch":
        return yield* hostLocalCommit(inbox.dispatch(InboxDispatchInputSchema.parse(input)));
      case "inbox_chat_targets":
        return yield* inbox.chatTargets(InboxChatTargetsInputSchema.parse(input));
      case "inbox_request_suggestion":
        return yield* hostLocalCommit(
          inbox.requestSuggestion(InboxSuggestionRequestInputSchema.parse(input)),
        );
      case "inbox_stop_suggestion":
        return yield* hostLocalCommit(
          inbox.stopSuggestion(InboxSuggestionStopInputSchema.parse(input)),
        );
      case "inbox_retry_dispatch":
        return yield* hostLocalCommit(inbox.retryDispatch(InboxProposalInputSchema.parse(input)));
      // Read with the Member's invocation: the chats they may read, bounded, never another's.
      case "chat_search":
        return yield* host.chats.search(ChatSearchInputSchema.parse(input));
      case "chat_search_messages":
        return yield* host.chats.searchMessages(ChatMessageSearchInputSchema.parse(input));
    }
  }).pipe(Effect.provideService(HostInvocation, invocation.credential));
