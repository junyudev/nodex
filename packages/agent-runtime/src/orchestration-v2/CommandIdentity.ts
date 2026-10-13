import { createHash } from "node:crypto";
import type { MessageId, OrchestrationV2ServerCommand } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

/** Receipt identity is derived from the validated command, before allocating execution IDs. */
export interface CommandReceiptIdentity {
  readonly requestFingerprint?: string;
  readonly messageId?: MessageId;
  readonly messageFingerprint?: string;
}

function stableJson(value: unknown): string {
  if (DateTime.isDateTime(value)) return JSON.stringify(DateTime.formatIso(value));
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export const fingerprintCommand = (value: unknown): string =>
  createHash("sha256").update(stableJson(value)).digest("hex");

export function commandReceiptIdentity(
  command: OrchestrationV2ServerCommand,
): CommandReceiptIdentity {
  const requestFingerprint = fingerprintCommand(command);
  // Completion mailboxes deliberately revise an undelivered, server-owned message.
  // Human and MCP submissions are immutable requests, even under a new command ID.
  if (
    command.type !== "message.dispatch" ||
    (command.createdBy !== "user" && command.creationSource !== "mcp")
  ) {
    return { requestFingerprint };
  }
  const { commandId: _commandId, ...messageRequest } = command;
  return {
    requestFingerprint,
    messageId: command.messageId,
    messageFingerprint: fingerprintCommand(messageRequest),
  };
}
