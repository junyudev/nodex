import { createContext, useContext } from "react";
import { NodexPopover, NodexPopoverTrigger, NodexPopoverContent } from "@/components/ui/popover";
import type { ResponseTextAnnotation } from "../../../../shared/thread-text-selection";

export const ResponseAnnotationContext = createContext<readonly ResponseTextAnnotation[]>([]);

/** An inline answer reference resolves only against the annotations sent with this Turn. */
export function ResponseAnnotationReference({ index }: { readonly index: number }) {
  const annotations = useContext(ResponseAnnotationContext);
  const annotation = Number.isInteger(index) && index > 0 ? annotations[index - 1] : undefined;
  if (!annotation) return null;
  return (
    <NodexPopover>
      <NodexPopoverTrigger>
        <button
          type="button"
          aria-label={`Annotation ${index}`}
          className="mx-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-background-info-solid px-1 align-super text-[10px] font-medium text-white"
        >
          {index}
        </button>
      </NodexPopoverTrigger>
      <NodexPopoverContent side="top" className="w-80 p-3 text-sm">
        <p className="max-h-52 overflow-auto whitespace-pre-wrap">{annotation.text}</p>
        {annotation.annotation ? (
          <p className="mt-2 border-t border-default pt-2 whitespace-pre-wrap">
            {annotation.annotation}
          </p>
        ) : null}
      </NodexPopoverContent>
    </NodexPopover>
  );
}
