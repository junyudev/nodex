import { defineMessage, type MessageDescriptor } from "@/lib/i18n";
import type { RuntimeMode } from "@nodex/agent-runtime/contracts";

export interface PermissionModePresentation {
  readonly mode: RuntimeMode;
  readonly label: MessageDescriptor;
  readonly description: MessageDescriptor;
}

/** Ordered from narrowest to broadest native execution access. */
export const PERMISSION_MODES: readonly PermissionModePresentation[] = [
  {
    mode: "approval-required",
    label: defineMessage({
      id: "conversation.permissionMode.ask",
      defaultMessage: "Ask for approval",
    }),
    description: defineMessage({
      id: "conversation.permissionMode.askHint",
      defaultMessage: "Asks before leaving its workspace",
    }),
  },
  {
    mode: "auto",
    label: defineMessage({
      id: "conversation.permissionMode.auto",
      defaultMessage: "Approve for me",
    }),
    description: defineMessage({
      id: "conversation.permissionMode.autoHint",
      defaultMessage: "Asks only about risky actions",
    }),
  },
  {
    mode: "full-access",
    label: defineMessage({ id: "conversation.permissionMode.full", defaultMessage: "Full access" }),
    description: defineMessage({
      id: "conversation.permissionMode.fullHint",
      defaultMessage: "Acts anywhere without asking",
    }),
  },
];

export function permissionModePresentation(mode: RuntimeMode): PermissionModePresentation {
  return PERMISSION_MODES.find((entry) => entry.mode === mode) ?? PERMISSION_MODES[0]!;
}
