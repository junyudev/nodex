import type {
  PageChatActivitySummaryInput,
  PageChatLinkInput,
  PageChatWindowInput,
} from "../../shared/types";
import { defineRendererCommand, invokePlainCommand, invokeRendererQuery } from "./renderer-command";

const pageChatRelationCommandDefinitions = {
  link: defineRendererCommand({
    key: "page.chat.link",
    channel: "page-chats:link",
    authority: "core",
    owner: "PageChats",
    protocol: { kind: "pending_operation" },
  }),
  unlink: defineRendererCommand({
    key: "page.chat.unlink",
    channel: "page-chats:unlink",
    authority: "core",
    owner: "PageChats",
    protocol: { kind: "pending_operation" },
  }),
} as const;

const { link: linkPageChatCommand, unlink: unlinkPageChatCommand } =
  pageChatRelationCommandDefinitions;

export async function readPageChatActivitySummaries(input: PageChatActivitySummaryInput) {
  return await invokeRendererQuery("page-chats:activity-summaries", input);
}

export async function readPageChatWindow(input: PageChatWindowInput) {
  return await invokeRendererQuery("page-chats:list", input);
}

export async function linkPageChat(sessionId: string, input: PageChatLinkInput): Promise<void> {
  await invokePlainCommand(linkPageChatCommand, sessionId, input);
}

export async function unlinkPageChat(sessionId: string, input: PageChatLinkInput): Promise<void> {
  await invokePlainCommand(unlinkPageChatCommand, sessionId, input);
}
