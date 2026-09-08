import { useState } from "react";
import { motion } from "motion/react";
import type { CompletedMcpServerElicitationView } from "../../projection/mcp-server-elicitation-view";
import { CODEX_THREAD_ACCORDION_TRANSITION } from "./thread-motion";
import { useMeasuredElementHeight } from "./use-measured-element-height";
import { ThreadActivityShell, ThreadRichActivityHeader } from "./tools/tool-primitives";
import { ToolActivityIcon, semanticToolIcon } from "./tools/tool-call-icons";

export function CompletedRequestActivitySurface({
  view,
}: {
  view: CompletedMcpServerElicitationView;
}) {
  const [expanded, setExpanded] = useState(false);
  const { elementHeightPx, elementRef } = useMeasuredElementHeight();

  return (
    <ThreadActivityShell
      header={
        <ThreadRichActivityHeader
          icon={
            <ToolActivityIcon
              descriptor={semanticToolIcon("connector")}
              className="icon-xs shrink-0 text-token-conversation-body"
            />
          }
          summary={view.summary}
          disclosure={{
            expanded,
            onToggle: () => {
              setExpanded((current) => !current);
            },
          }}
        />
      }
      body={
        <motion.div
          initial={false}
          animate={{
            height: expanded ? elementHeightPx : 0,
            opacity: expanded ? 1 : 0,
          }}
          aria-hidden={!expanded}
          inert={expanded ? undefined : true}
          transition={CODEX_THREAD_ACCORDION_TRANSITION}
          className={expanded ? "mt-1.5 overflow-visible" : "overflow-hidden"}
          style={{ pointerEvents: expanded ? "auto" : "none" }}
        >
          <div ref={expanded ? elementRef : null} className="flex flex-col gap-3 pt-1 pb-0.5">
            <div className="flex flex-col gap-1">
              <span className="text-size-chat whitespace-pre-wrap text-token-conversation-body">
                {view.question}
              </span>
              <span className="text-size-chat text-token-conversation-header">{view.answer}</span>
            </div>
          </div>
        </motion.div>
      }
    />
  );
}
