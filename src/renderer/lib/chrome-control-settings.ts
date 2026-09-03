import { invokeRendererQuery } from "@/lib/renderer-command";

export function readChromeControlSettings() {
  return invokeRendererQuery("chrome-control-settings-get");
}
