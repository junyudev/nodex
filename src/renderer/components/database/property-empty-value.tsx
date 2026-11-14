import { cn } from "@/lib/utils";

export const PROPERTY_EMPTY_VALUE_LABEL = "Empty";

export function PropertyEmptyValue({ className }: { readonly className?: string }) {
  return (
    <span className={cn("text-token-text-secondary", className)}>{PROPERTY_EMPTY_VALUE_LABEL}</span>
  );
}
