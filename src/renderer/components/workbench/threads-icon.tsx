import { ChatBubblesIcon16 } from "@/components/shared/icons/plugin-detail-icons";
import { cn } from "@/lib/utils";

/** Chat-bubble threads icon (dual overlapping speech bubbles). */
export function ThreadsIcon({ className }: { className?: string }) {
  return <ChatBubblesIcon16 className={cn("size-3.5 shrink-0", className)} />;
}
