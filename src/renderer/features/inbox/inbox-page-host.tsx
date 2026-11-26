import { createContext, useContext, type ReactNode } from "react";
import type { ShowPagesInChatInput } from "@/lib/page-chat-actions";
import type { Project } from "../../../shared/types";

/**
 * What a message's Page needs from its window to decide the message where it stands: the same
 * window, Projects and navigation the Inbox decides with. A host without it shows no Inbox
 * section on its Pages.
 */
export interface InboxPageHost {
  readonly windowSessionId: string;
  readonly projects: readonly Project[];
  readonly openSession: (sessionId: string) => void;
  /** Opens a new chat with its message Pages beside it, as the Inbox does. */
  readonly showPagesInChat: (input: ShowPagesInChatInput) => Promise<void>;
  readonly openAutomation?: (automationId: string) => void;
}

const InboxPageHostContext = createContext<InboxPageHost | null>(null);

/** The current Workbench window decides messages on their Pages. */
export function InboxPageHostProvider({
  host,
  children,
}: {
  readonly host: InboxPageHost;
  readonly children: ReactNode;
}) {
  return <InboxPageHostContext value={host}>{children}</InboxPageHostContext>;
}

export const useInboxPageHost = (): InboxPageHost | null => useContext(InboxPageHostContext);
