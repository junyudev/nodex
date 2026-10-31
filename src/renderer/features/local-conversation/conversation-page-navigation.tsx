import { createContext, useContext, type ReactNode } from "react";

/** Opens a Page referenced from a conversation, beside the chat that shows it. */
export type ConversationPageNavigation = (pageId: string, titleSnapshot?: string) => void;

const ConversationPageNavigationContext = createContext<ConversationPageNavigation | null>(null);

export function ConversationPageNavigationProvider({
  value,
  children,
}: {
  value: ConversationPageNavigation | null;
  children: ReactNode;
}) {
  return (
    <ConversationPageNavigationContext.Provider value={value}>
      {children}
    </ConversationPageNavigationContext.Provider>
  );
}

export function useConversationPageNavigation(): ConversationPageNavigation | null {
  return useContext(ConversationPageNavigationContext);
}
