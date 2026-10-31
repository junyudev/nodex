import { toast } from "@/components/ui/toast";

/** Direct sends have no picker to hold their error, so a failure surfaces as one toast. */
export function reportNfmChatSendFailure(action: "send" | "add-to-composer", error: unknown): void {
  const description = error instanceof Error ? error.message.trim() : "";
  toast.danger(action === "send" ? "Could not send" : "Could not add to composer", {
    id: "nfm-send-to-thread",
    ...(description ? { description } : {}),
  });
}
