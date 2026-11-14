import { NodexLogoMarkIcon } from "@/components/shared/icons";

export function NodexAuthor() {
  return (
    <span className="flex items-center gap-1 text-xs text-token-description-foreground">
      <NodexLogoMarkIcon monochrome className="size-3.5 shrink-0" />
      Nodex
    </span>
  );
}
