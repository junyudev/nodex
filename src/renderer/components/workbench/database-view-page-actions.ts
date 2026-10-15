import type { OpenPageInNewChatInput, SendPageToChatInput } from "@/lib/page-chat-actions";
import type { ContentRoutingContext } from "../../../shared/content-routing-context";

export interface DatabaseViewPageTarget {
  readonly libraryId: string;
  readonly routingContext: ContentRoutingContext;
  readonly projectId: string | null;
  readonly pageId: string;
  readonly pageKey: string | null;
  readonly titleSnapshot: string;
}

/** Session-owned Page commands shared by every Database View presentation. */
export interface DatabaseViewPageActionPort {
  readonly openInNewChat?: (input: OpenPageInNewChatInput) => Promise<void> | void;
  readonly sendToChat?: (input: SendPageToChatInput) => Promise<void> | void;
  readonly openRelatedChat?: (sessionId: string) => Promise<void> | void;
  readonly deletePage?: (input: DatabaseViewPageTarget) => Promise<void> | void;
}
