import { app, shell } from "electron";
import type { OpenAtLoginResult, OpenAtLoginStatus } from "../../../shared/open-at-login";
import type { MainConfigValue } from "../../app/MainConfig";
import {
  WINDOWS_LOGIN_ITEM_NAME,
  WINDOWS_STARTUP_ARGUMENT,
  windowsLoginItemEnabled,
} from "../../windows-desktop-policy";

const mainAppService = { type: "mainAppService" } as const;
type LoginItemHost = Pick<MainConfigValue, "platform" | "isPackaged" | "runtimeBinaryPath">;

export function wasOpenedAtLogin(platform: string): boolean {
  // Electron 45 captures the login marker from the launch Apple Event before emitting ready.
  // Read it after app.whenReady(); mainAppService uses SMAppService and only Windows accepts args.
  return platform === "darwin" && app.getLoginItemSettings(mainAppService).wasOpenedAtLogin;
}

export function readOpenAtLogin(host: LoginItemHost): OpenAtLoginStatus {
  if (!host.isPackaged) return "unavailable";
  if (host.platform === "darwin") {
    const { status } = app.getLoginItemSettings(mainAppService);
    if (status === "not-found") return "unavailable";
    if (status === "not-registered") return "disabled";
    return status;
  }
  if (host.platform === "win32") {
    const settings = app.getLoginItemSettings({ path: host.runtimeBinaryPath });
    return windowsLoginItemEnabled(host.runtimeBinaryPath, settings) ? "enabled" : "disabled";
  }
  return "unavailable";
}

export function setOpenAtLogin(host: LoginItemHost, enabled: boolean): OpenAtLoginResult {
  const current = readOpenAtLogin(host);
  if (current === "unavailable") return { status: current, error: "change-failed" };
  if (enabled && current === "enabled") return { status: current };
  if (enabled && current === "requires-approval")
    return { status: current, error: "requires-approval" };
  if (!enabled && current === "disabled" && host.platform === "darwin") return { status: current };
  if (host.platform === "darwin") {
    app.setLoginItemSettings({ ...mainAppService, openAtLogin: enabled });
  } else {
    app.setLoginItemSettings({
      name: WINDOWS_LOGIN_ITEM_NAME,
      path: host.runtimeBinaryPath,
      args: [WINDOWS_STARTUP_ARGUMENT],
      openAtLogin: enabled,
      enabled,
    });
  }

  // Electron reports the OS state separately from the registration call.
  const status = readOpenAtLogin(host);
  if (status === (enabled ? "enabled" : "disabled")) return { status };
  if (enabled && status === "requires-approval") return { status, error: "requires-approval" };
  return { status, error: "change-failed" };
}

export async function openLoginItemSystemSettings(platform: string): Promise<void> {
  if (platform !== "darwin") return;
  await shell.openExternal("x-apple.systempreferences:com.apple.LoginItems-Settings.extension");
}
