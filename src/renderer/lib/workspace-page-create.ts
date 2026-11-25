import { createBoundedOperationId } from "../../shared/operation-identity";
import { NEW_CHAT_TITLE } from "../../shared/session-title";
import { createUuidV7 } from "../../shared/uuid-v7";
import type { CreatePageForInput, CreatePageForResult } from "../../shared/workspace-page-create";
import { defineRendererCommand, invokePlainCommand } from "./renderer-command";

export type { CreatePageForInput, CreatePageForResult } from "../../shared/workspace-page-create";

export const DEFAULT_NEW_PAGE_TITLE = "Untitled";

const MAX_SESSION_PAGE_TITLE_CODE_POINTS = 2_000;

type SessionTitleSource =
  | {
      readonly displayTitle?: string | null;
      readonly noThreadFallbackTitle?: string | null;
    }
  | string
  | null
  | undefined;

/**
 * Resolves the initial title for a Page created from a chat: reuses the chat's own title
 * normalized onto one line, falling back to "Untitled" for unnamed drafts.
 */
export function resolveNewPageTitleForSession(source: SessionTitleSource): string {
  const raw =
    typeof source === "object" && source !== null
      ? source.displayTitle?.trim()
        ? source.displayTitle
        : source.noThreadFallbackTitle
      : source;
  const normalized = raw?.replace(/\s+/gu, " ").trim() ?? "";
  if (!normalized || normalized === NEW_CHAT_TITLE) return DEFAULT_NEW_PAGE_TITLE;
  return normalized.length <= MAX_SESSION_PAGE_TITLE_CODE_POINTS
    ? normalized
    : Array.from(normalized).slice(0, MAX_SESSION_PAGE_TITLE_CODE_POINTS).join("");
}

const createPageForCommand = defineRendererCommand({
  key: "workspace.page.create-for",
  channel: "workspace:page:create-for",
  authority: "core",
  owner: "Workspace",
  protocol: { kind: "pending_operation" },
});

/** Core resolves the content home and links the new Page to its Session in one commit. */
export async function createPageFor(input: CreatePageForInput): Promise<CreatePageForResult> {
  return await invokePlainCommand(createPageForCommand, {
    ...input,
    operationId: createBoundedOperationId("workspace.page.create-for"),
    pageId: createUuidV7(),
    documentId: createUuidV7(),
  });
}
