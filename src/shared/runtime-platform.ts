/** The operating system family Nodex runs on, as keyboard and window behavior distinguishes it. */
export type RuntimePlatform = "macOS" | "windows" | "linux";

export function resolveRuntimePlatform(nodePlatform: string = process.platform): RuntimePlatform {
  if (nodePlatform === "darwin") return "macOS";
  if (nodePlatform === "win32") return "windows";
  return "linux";
}
