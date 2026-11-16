import { defineMessage, FormattedMessage } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export const propertyEmptyValueMessage = defineMessage({
  id: "components.propertyEmptyValue.empty",
  defaultMessage: "Empty",
});

export function PropertyEmptyValue({ className }: { readonly className?: string }) {
  return (
    <span className={cn("text-token-text-secondary", className)}>
      <FormattedMessage {...propertyEmptyValueMessage} />
    </span>
  );
}
