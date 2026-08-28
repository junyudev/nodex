import { cn } from "@/lib/utils";

export const PROPERTY_EMPTY_VALUE_LABEL = "Empty";

export const DATABASE_PAGE_PROPERTY_EMPTY_TRIGGER_CLASS_NAME =
  "min-h-6 rounded-sm px-1 hover:bg-token-foreground/5";

export function PropertyEmptyValue({ className }: { readonly className?: string }) {
  return (
    <span className={cn("text-token-text-secondary", className)}>{PROPERTY_EMPTY_VALUE_LABEL}</span>
  );
}
