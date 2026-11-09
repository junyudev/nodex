import { NodexLogoMarkIcon } from "@/components/shared/icons";
import { cn } from "@/lib/utils";

export function NodexAuthor({ className }: { readonly className?: string }) {
  return (
    <span
      className={cn(
        "flex items-center gap-1 pl-1 text-xs text-token-description-foreground",
        className,
      )}
    >
      <NodexLogoMarkIcon monochrome className="size-3.5 shrink-0" />
      Nodex
    </span>
  );
}
