import { toast } from "@/components/ui/toast";
import { readableIpcError } from "./ipc-error-message";

/**
 * Tells the user that something they did did not complete. The title says what failed in
 * product words; the description carries the reason the failing layer gave, when it gave one
 * that adds to the title. A stable `id` replaces the earlier toast for the same failure instead
 * of stacking another.
 */
export function toastFailure(
  title: string,
  cause?: unknown,
  options?: { readonly id?: string },
): void {
  const reason = cause === undefined ? "" : readableIpcError(cause);
  toast.danger(title, {
    ...(reason && reason !== title ? { description: reason } : {}),
    ...(options?.id ? { id: options.id } : {}),
  });
}
