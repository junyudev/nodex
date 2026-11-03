import { runWithCleanup } from "@/lib/run-with-cleanup";
import { useQueryClient } from "@tanstack/react-query";
import type { InboxSendInput, InboxSendResult } from "../../../shared/inbox";
import { sendInboxMessage } from "@/lib/inbox-runtime";
import { invalidateInbox } from "./use-inbox";

/** Sends a capture from any surface and refreshes the window's Inbox queries. */
export function useSendInboxMessage(): (input: InboxSendInput) => Promise<InboxSendResult> {
  const queryClient = useQueryClient();
  return async (input) => {
    return runWithCleanup(
      async () => {
        return (await sendInboxMessage(input)).value;
      },
      {
        cleanup: () => {
          void invalidateInbox(queryClient);
        },
      },
    );
  };
}
