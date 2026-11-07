import type { ChatAttachment, OrchestrationMessageContext } from "@t3tools/contracts";

interface NativeCommandMessage {
  readonly text: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly context?: OrchestrationMessageContext | undefined;
}

/** A command stands alone: anything attached makes the message an ordinary prompt. */
const nativeCommand = (message: NativeCommandMessage): string | null =>
  message.attachments.length === 0 && (message.context?.records.length ?? 0) === 0
    ? message.text.trim().toLowerCase()
    : null;

/** A native /compact or /logout turn: provider maintenance, not agent work. */
export function isNativeMaintenanceCommand(message: NativeCommandMessage): boolean {
  const command = nativeCommand(message);
  return command === "/compact" || command === "/logout";
}

/** A native /compact turn: the user asked the provider to compact its context. */
export function isNativeCompactCommand(message: NativeCommandMessage): boolean {
  return nativeCommand(message) === "/compact";
}
