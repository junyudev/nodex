import { motionValue } from "motion/react";
import { InboxCard, InboxComposer } from "../replica/Inbox";
import { INBOX_BURST } from "./lumen";

// Each goes somewhere else: Codex, a chat already running, a free OpenCode model, and a Claude lead
// that fans its work out.
const MESSAGES = ["webhooks", "darkmode", "changelog", "passkeys"].map((id) =>
  INBOX_BURST.find((message) => message.id === id)!,
);

const EMPTY_DRAFT = motionValue("");
const PLACEHOLDER_SHOWN = motionValue(1);

/**
 * The home social card's window: one Inbox sending several messages each to its own place. That
 * variety is what sets Nodex apart, so each card keeps only the message and where it goes, leaving
 * room to enlarge them enough to read in a feed's thumbnail. Cards take the window's full width
 * instead of a chat bubble's 80% so that every route stays on one line. The composer stays: it
 * says what the Inbox is for.
 */
export default function OgInbox() {
  return (
    <div className="flex h-full flex-col justify-end gap-2.5 px-5 pb-4 [zoom:1.17] [&>div>div]:max-w-full">
      {MESSAGES.map((message) => (
        <InboxCard key={message.id} message={message} phase="suggested" routeOnly />
      ))}
      <InboxComposer text={EMPTY_DRAFT} placeholderOpacity={PLACEHOLDER_SHOWN} />
    </div>
  );
}
