import { isWindowsStartupActivation } from "../windows-desktop-policy";

export function startupWindowPolicy(input: {
  readonly platform: string;
  readonly argv: readonly string[];
  readonly wasOpenedAtLogin: boolean;
}): "restore" | "defer" {
  if (input.platform === "darwin" && input.wasOpenedAtLogin) return "defer";
  if (isWindowsStartupActivation(input.platform, input.argv)) return "defer";
  return "restore";
}
