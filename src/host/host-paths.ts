/** How paths are written on the machine a Space host runs on, which its Agents' replies follow. */
export type HostPathFlavor = "win32" | "posix";

export const hostPathFlavor = (platform: string): HostPathFlavor =>
  platform === "win32" ? "win32" : "posix";
