import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";

import { NodexPopover, NodexPopoverAnchor, NodexPopoverContent } from "@/components/ui/popover";

const SELECTED_MENTION_SELECTOR =
  '[data-mention-inline-chip="true"][data-mention-token-selected="true"]';

function useMentionTokenSelected(containerRef: RefObject<HTMLElement | null>): boolean {
  const [selected, setSelected] = useState(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof MutationObserver === "undefined") return undefined;

    const syncSelection = () => {
      const nextSelected = Boolean(container.querySelector(SELECTED_MENTION_SELECTOR));
      setSelected((currentSelected) =>
        currentSelected === nextSelected ? currentSelected : nextSelected,
      );
    };

    syncSelection();
    const observer = new MutationObserver(syncSelection);
    observer.observe(container, {
      subtree: true,
      attributes: true,
      attributeFilter: ["data-mention-token-selected"],
    });
    return () => observer.disconnect();
  }, [containerRef]);

  return selected;
}

export function MentionInlineFocusAffordance({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  const containerRef = useRef<HTMLSpanElement>(null);
  const selected = useMentionTokenSelected(containerRef);

  return (
    <NodexPopover open={selected} modal={false}>
      <span ref={containerRef} className="inline align-baseline">
        {children}
        <NodexPopoverAnchor>
          <span
            aria-hidden="true"
            className="inline-block w-0 overflow-visible align-baseline"
            contentEditable={false}
            data-mention-inline-focus-anchor="true"
          />
        </NodexPopoverAnchor>
      </span>
      <NodexPopoverContent
        aria-hidden="true"
        data-mention-inline-focus-affordance="true"
        role="presentation"
        side="bottom"
        align="center"
        sideOffset={6}
        collisionPadding={4}
        className="pointer-events-none w-fit min-w-0 max-w-[calc(100vw-8px)] overflow-visible whitespace-nowrap rounded-[4px] border-0 bg-token-dropdown-background px-2 py-1 text-xs leading-[1.4] font-medium text-token-foreground shadow-[0_1px_4px_rgba(0,0,0,0.3)] ring-0 backdrop-blur-none"
        initialFocus={false}
        finalFocus={false}
      >
        <div>
          <div>{label}</div>
          <div className="text-token-description-foreground">↵</div>
        </div>
      </NodexPopoverContent>
    </NodexPopover>
  );
}
