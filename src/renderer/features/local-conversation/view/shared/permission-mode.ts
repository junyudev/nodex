import type { RuntimeMode } from "@nodex/agent-runtime/contracts";

export interface PermissionModePresentation {
  readonly mode: RuntimeMode;
  readonly label: string;
  readonly description: string;
}

/** Ordered from narrowest to broadest native execution access. */
export const PERMISSION_MODES: readonly PermissionModePresentation[] = [
  {
    mode: "approval-required",
    label: "Ask for approval",
    description: "Asks before leaving its workspace",
  },
  {
    mode: "auto",
    label: "Approve for me",
    description: "Asks only about risky actions",
  },
  {
    mode: "full-access",
    label: "Full access",
    description: "Acts anywhere without asking",
  },
];

export function permissionModePresentation(mode: RuntimeMode): PermissionModePresentation {
  return PERMISSION_MODES.find((entry) => entry.mode === mode) ?? PERMISSION_MODES[0]!;
}
