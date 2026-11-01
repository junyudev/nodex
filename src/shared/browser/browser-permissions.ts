export const BROWSER_SITE_PERMISSION_NAMES = [
  "camera",
  "microphone",
  "geolocation",
  "notifications",
  "clipboard-read",
  "clipboard-write",
  "midi",
  "midi-sysex",
  "window-management",
  "idle-detection",
  "storage-access",
  "top-level-storage-access",
  "open-external",
  "local-fonts",
  "local-network",
  "speaker-selection",
  "automatic-fullscreen",
  "captured-surface-control",
  "ar",
  "vr",
  "hand-tracking",
  "display-capture",
] as const;

export type BrowserSitePermissionName = (typeof BROWSER_SITE_PERMISSION_NAMES)[number];
export type BrowserSitePermissionState = "allow" | "block" | "ask";
export type BrowserPermissionAction = "allow" | "allow-this-time" | "deny" | "dismiss";
export type BrowserGeolocationAccuracy = "approximate" | "precise";

export interface BrowserPermissionDescriptor {
  name: BrowserSitePermissionName;
  /** The destination is supplied by Electron for external protocol requests. */
  externalUrl?: string;
}

export interface BrowserPermissionPrompt {
  id: string;
  origin: string;
  embeddingOrigin?: string;
  permissions: BrowserPermissionDescriptor[];
  actions: BrowserPermissionAction[];
  variant: "permission" | "os-system-settings";
  /** Presentation identity must accompany a response, including after a remount. */
  mountGeneration: number;
  geolocationAccuracies?: BrowserGeolocationAccuracy[];
}
