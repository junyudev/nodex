import { LIBRARY_INBOX, projectInbox, type InboxScope } from "../../../shared/inbox";
import type { WorkbenchLocation } from "../../../shared/workbench-layout";

/**
 * The Inbox a capture lands in: the Project the user is in, whether its own Scene or one of
 * its chats, and the Library Inbox anywhere else. Agents and the command line follow the
 * same rule for their own messages.
 */
export function resolveInboxCaptureScope(location: WorkbenchLocation): InboxScope {
  if (location.kind === "project") return projectInbox(location.projectId);
  if (location.kind === "session" && location.projectContextId)
    return projectInbox(location.projectContextId);
  return LIBRARY_INBOX;
}
