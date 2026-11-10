import { SkillMentionChip } from "../board/editor/skill-mention-chip";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import type {
  PortableRichText,
  PortableRichTextItem,
} from "../../../shared/block-documents/portable-rich-text";
import {
  portableRichTitleAtomLabel,
  portableRichTitleStyleClass,
} from "@/lib/portable-rich-title-presentation";
import { NodexTooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export interface PortableRichTitleProps extends Omit<ComponentPropsWithoutRef<"span">, "children"> {
  readonly value: PortableRichText;
  readonly fallback?: string;
}

const renderItem = (item: PortableRichTextItem, index: number): ReactNode => {
  if (item.type === "linebreak") {
    return <br key={`linebreak:${index}`} />;
  }
  if (item.type === "skillMention") return <SkillMentionChip key={index} name={item.name} />;
  if (item.type === "threadMention" || item.type === "pageMention" || item.type === "dateMention") {
    const label = portableRichTitleAtomLabel(item);
    const tooltip =
      item.type === "threadMention"
        ? item.uuid
        : item.type === "pageMention"
          ? item.targetPageId
          : label;
    return (
      <NodexTooltip key={`${item.type}:${index}`} tooltipContent={tooltip} side="top">
        <span
          data-portable-rich-title-atom={item.type}
          className="mx-0.5 inline-flex max-w-[18rem] rounded-md bg-token-foreground/5 px-1.5 align-baseline text-[0.82em] font-medium text-token-text-secondary"
        >
          {label}
        </span>
      </NodexTooltip>
    );
  }
  return (
    <NodexTooltip
      key={`${item.type}:${index}`}
      tooltipContent={item.type === "link" ? item.href : undefined}
      side="top"
    >
      <span
        data-portable-rich-title-link={item.type === "link" ? item.href : undefined}
        className={cn(
          item.type === "link" && "underline decoration-current/40 underline-offset-2",
          portableRichTitleStyleClass(item.styles),
        )}
      >
        {item.text}
      </span>
    </NodexTooltip>
  );
};

export function PortableRichTitle({
  value,
  fallback = "Untitled",
  className,
  ...props
}: PortableRichTitleProps) {
  return (
    <span {...props} className={cn("min-w-0 whitespace-pre-wrap wrap-break-word", className)}>
      {value.length > 0 ? value.map(renderItem) : fallback}
    </span>
  );
}
