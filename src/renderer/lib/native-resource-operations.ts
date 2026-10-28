import type { NativeResourceData } from "../../shared/native-resource";
import { invokeRendererQuery } from "./renderer-command";

/** HTTP resources use the desktop network stack rather than renderer CSP/CORS. */
export function readNativeResource(url: string): Promise<NativeResourceData> {
  return invokeRendererQuery("native-resource:read", { url });
}
