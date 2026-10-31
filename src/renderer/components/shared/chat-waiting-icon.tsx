import { AgentQuestionIcon } from "@/components/shared/icons";
import { cn } from "@/lib/utils";

/**
 * A chat waiting on its person, for an answer or an approval: the question bubble its reply panel
 * opens with, in the attention tone, so it never reads as the blue unread dot.
 */
export function ChatWaitingIcon({ className }: { readonly className?: string }) {
  return <AgentQuestionIcon className={cn("text-token-warning-foreground", className)} />;
}
