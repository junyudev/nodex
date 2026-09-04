import type { ReactNode } from "react";
import { InfoIcon } from "./icons";
import { NodexButton } from "../ui/button";
import { NodexTooltip } from "../ui/tooltip";

/** File managers share action density; each owner supplies its own operation rules. */
export function FileDetailsToolbar({
  children,
  info,
  infoLabel,
}: {
  children: ReactNode;
  info: ReactNode;
  infoLabel: string;
}) {
  return (
    <div className="flex items-center gap-1 border-y-[0.5px] border-token-border px-4 py-1.5">
      {children}
      <NodexTooltip
        tooltipContent={<div className="max-w-72 space-y-2">{info}</div>}
        side="top"
        align="end"
      >
        <NodexButton
          variant="ghost"
          size="icon-sm"
          aria-label={infoLabel}
          className="ml-auto shrink-0 text-token-description-foreground"
        >
          <InfoIcon className="size-4" />
        </NodexButton>
      </NodexTooltip>
    </div>
  );
}
