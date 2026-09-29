import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { ConversationProviderPresentation } from "../thread-stage-types";

const ConversationToolOutputContext = createContext<{
  conversationId: string | null;
  readToolOutput: ConversationProviderPresentation["readToolOutput"];
}>({ conversationId: null, readToolOutput: undefined });

export function ConversationToolOutputProvider({
  children,
  readToolOutput,
  conversationId,
}: {
  children: ReactNode;
  conversationId: string | null;
  readToolOutput: ConversationProviderPresentation["readToolOutput"];
}) {
  const value = useMemo(
    () => ({ readToolOutput, conversationId }),
    [readToolOutput, conversationId],
  );
  return (
    <ConversationToolOutputContext.Provider value={value}>
      {children}
    </ConversationToolOutputContext.Provider>
  );
}
export const useConversationToolOutputReader = () => useContext(ConversationToolOutputContext);
