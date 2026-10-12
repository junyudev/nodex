import { createContext, useContext, type ReactNode } from "react";
import type { VisualizationAnnotationSubmission } from "./inline-visualization-annotations";

export interface InlineVisualizationFollowUpMessage {
  readonly sourceId: string;
  readonly prompt: string;
  readonly context?: unknown;
}

export type InlineVisualizationFollowUpHandler = (
  message: InlineVisualizationFollowUpMessage,
) => Promise<void>;

const FollowUpContext = createContext<InlineVisualizationFollowUpHandler | null>(null);
export type InlineVisualizationAnnotationSubmitHandler = (
  message: VisualizationAnnotationSubmission & { readonly sourceId: string },
) => Promise<void>;
const AnnotationSubmitContext = createContext<InlineVisualizationAnnotationSubmitHandler | null>(
  null,
);

export function InlineVisualizationFollowUpProvider({
  children,
  onSend,
  onSubmitAnnotations,
}: {
  children: ReactNode;
  onSend: InlineVisualizationFollowUpHandler;
  onSubmitAnnotations?: InlineVisualizationAnnotationSubmitHandler;
}) {
  return (
    <FollowUpContext.Provider value={onSend}>
      <AnnotationSubmitContext.Provider value={onSubmitAnnotations ?? null}>
        {children}
      </AnnotationSubmitContext.Provider>
    </FollowUpContext.Provider>
  );
}

export const useInlineVisualizationFollowUpHandler = () => useContext(FollowUpContext);
export const useInlineVisualizationAnnotationSubmitHandler = () =>
  useContext(AnnotationSubmitContext);
