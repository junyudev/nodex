import { app } from "electron";
import { release } from "node:os";
import { supportsWindowsMica } from "../../electron-window-backdrop";

export function isWindowBackdropSupported(platform: NodeJS.Platform): boolean {
  if (platform !== "win32") return true;
  return supportsWindowsMica(release(), app.getGPUFeatureStatus().gpu_compositing);
}
