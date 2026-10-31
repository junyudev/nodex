import type { ContentRoutingContext } from "../../shared/content-routing-context";
import type { CodexPromptInput } from "@/lib/types";

/** How a chat picker marks the chat whose Scene it opened in, which it lists first. */
export const CURRENT_CHAT_LABEL = "This chat";

/** An existing chat names its Session when it has one, so mentions of it can name that Session. */
export type ChatDestinationTarget =
  | { readonly kind: "thread"; readonly threadId: string; readonly sessionId: string | null }
  | { readonly kind: "new-thread"; readonly sessionId?: string };

export interface OpenPageInNewChatInput {
  readonly projectId: string;
  readonly pageId: string;
  readonly pageKey?: string;
  readonly titleSnapshot?: string;
}

export interface SendPageToChatInput extends OpenPageInNewChatInput {
  readonly target: ChatDestinationTarget;
}

/** Pages to show in a chat's right panel, in tab order, opened through `routingContext`. */
export interface ShowPagesInChatInput {
  readonly sessionId: string;
  readonly routingContext: ContentRoutingContext;
  readonly pages: readonly { readonly pageId: string; readonly titleSnapshot?: string }[];
}

/** One Page to open beside its chat, through `routingContext`, taking the person to that chat. */
export interface OpenPageInChatInput {
  readonly sessionId: string;
  readonly routingContext: ContentRoutingContext;
  readonly page: ShowPagesInChatInput["pages"][number];
}

export interface PagePromptContext {
  readonly pageId: string;
  readonly pageKey?: string;
  readonly projectId: string;
  readonly title: string;
  readonly source: string;
  readonly promptInput: CodexPromptInput;
}

export interface ResolvedPageChatSession {
  readonly id: string;
  readonly projectId: string | null;
}

interface SendPageToChatDependencies {
  readonly loadPageContext: (input: OpenPageInNewChatInput) => Promise<PagePromptContext>;
  readonly resolveSessionById: (sessionId: string) => Promise<ResolvedPageChatSession>;
  readonly resolveSessionForThread: (threadId: string) => Promise<ResolvedPageChatSession>;
  readonly ensureDefaultSession: (projectId: string) => Promise<ResolvedPageChatSession>;
  readonly linkPage: (input: {
    readonly pageId: string;
    readonly sessionId: string;
  }) => Promise<void>;
  readonly startTurn: (input: {
    readonly projectId: string;
    readonly threadId: string;
    readonly context: PagePromptContext;
  }) => Promise<void>;
  readonly startThread: (input: {
    readonly projectId: string;
    readonly sessionId: string;
    readonly context: PagePromptContext;
  }) => Promise<{ readonly kind: string }>;
  readonly refreshSessions: (projectId: string) => Promise<void>;
}

/**
 * Executes the cross-runtime Page send protocol in its durable order.
 * A successful relation intentionally survives a later app-server failure.
 */
export async function sendPageToChatWithRelation(
  input: SendPageToChatInput,
  dependencies: SendPageToChatDependencies,
): Promise<void> {
  const context = await dependencies.loadPageContext(input);

  if (input.target.kind === "thread") {
    const targetSession = await dependencies.resolveSessionForThread(input.target.threadId);
    if (!targetSession.projectId) {
      throw new Error("Page content can only be sent to a Project chat");
    }
    await dependencies.linkPage({
      pageId: input.pageId,
      sessionId: targetSession.id,
    });
    await dependencies.startTurn({
      projectId: targetSession.projectId,
      threadId: input.target.threadId,
      context,
    });
    return;
  }

  const targetSession = input.target.sessionId?.trim()
    ? await dependencies.resolveSessionById(input.target.sessionId)
    : await dependencies.ensureDefaultSession(input.projectId);
  if (!targetSession.projectId) {
    throw new Error("Page content can only be sent to a Project chat");
  }
  await dependencies.linkPage({
    pageId: input.pageId,
    sessionId: targetSession.id,
  });
  const result = await dependencies.startThread({
    projectId: targetSession.projectId,
    sessionId: targetSession.id,
    context,
  });
  if (result.kind !== "started") {
    throw new Error("Page chat unexpectedly started in a worktree");
  }
  await dependencies.refreshSessions(targetSession.projectId);
}
