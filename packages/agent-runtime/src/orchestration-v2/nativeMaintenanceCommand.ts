import type { ChatAttachment } from "@t3tools/contracts";

interface NativeCommandMessage {
  readonly text: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
}

const nativeCommand = (message: NativeCommandMessage): string | null =>
  message.attachments.length === 0 ? message.text.trim().toLowerCase() : null;

/** A native /compact or /logout turn: provider maintenance, not agent work. */
export function isNativeMaintenanceCommand(message: NativeCommandMessage): boolean {
  const command = nativeCommand(message);
  return command === "/compact" || command === "/logout";
}

/** A native /compact turn: the user asked the provider to compact its context. */
export function isNativeCompactCommand(message: NativeCommandMessage): boolean {
  return nativeCommand(message) === "/compact";
}
