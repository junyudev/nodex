import { createContext, useContext, type ReactNode } from "react";

export interface InlineVisualizationFollowUpMessage {
  readonly sourceId: string;
  readonly prompt: string;
  readonly context?: unknown;
}

export type InlineVisualizationFollowUpHandler = (
  message: InlineVisualizationFollowUpMessage,
) => Promise<void>;

const FollowUpContext = createContext<InlineVisualizationFollowUpHandler | null>(null);

export function InlineVisualizationFollowUpProvider({
  children,
  onSend,
}: {
  children: ReactNode;
  onSend: InlineVisualizationFollowUpHandler;
}) {
  return <FollowUpContext.Provider value={onSend}>{children}</FollowUpContext.Provider>;
}

export const useInlineVisualizationFollowUpHandler = () => useContext(FollowUpContext);
