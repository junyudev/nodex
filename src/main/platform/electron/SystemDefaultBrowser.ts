import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { app, type NativeImage } from "electron";
import type { SystemDefaultBrowser } from "../../../shared/system-default-browser";

const execFileAsync = promisify(execFile);

async function readHttpsHandler(): Promise<{
  readonly name: string;
  readonly appPath: string | null;
  readonly icon: NativeImage | null;
} | null> {
  try {
    const { name, icon, path: appPath } = await app.getApplicationInfoForProtocol("https://");
    if (name.trim()) return { name: name.trim(), icon, appPath: appPath || null };
  } catch {
    // Some platforms expose only the handler's name.
  }
  try {
    const name = app.getApplicationNameForProtocol("https://").trim();
    return name ? { name, icon: null, appPath: null } : null;
  } catch {
    return null;
  }
}

export async function readSystemDefaultBrowser(): Promise<SystemDefaultBrowser | null> {
  const handler = await readHttpsHandler();
  if (!handler) return null;
  const { name, appPath, icon } = handler;
  return { name, appPath, iconDataUrl: icon && !icon.isEmpty() ? icon.toDataURL() : null };
}

export async function readDefaultBrowserIdentity(): Promise<{
  readonly name: string;
  readonly applicationId: string | null;
} | null> {
  const browser = await readHttpsHandler();
  if (!browser) return null;
  const { name, appPath } = browser;
  if (!appPath) return { name, applicationId: null };
  if (process.platform === "win32") return { name, applicationId: path.win32.basename(appPath) };
  if (process.platform !== "darwin") return { name, applicationId: null };
  try {
    // Electron may return the bundle or an executable inside it.
    const bundle = /^(.+?\.app)(?:\/|$)/u.exec(appPath)?.[1];
    if (!bundle) return { name, applicationId: null };
    const { stdout } = await execFileAsync(
      "/usr/libexec/PlistBuddy",
      ["-c", "Print :CFBundleIdentifier", path.join(bundle, "Contents", "Info.plist")],
      { timeout: 1_000, maxBuffer: 4_096 },
    );
    return { name, applicationId: stdout.trim() || null };
  } catch {
    return { name, applicationId: null };
  }
}
