export interface MobileDevice {
  id: string;
  name: string;
  platform: string;
  appVersion: string;
  pairedAt: number;
  lastSeenAt: number | null;
  connected: boolean;
}

export interface MobileAccessStatus {
  enabled: boolean;
  state: "off" | "starting" | "listening" | "failed";
  failureMessage: string | null;
  hostName: string;
  routes: readonly string[];
  devices: readonly MobileDevice[];
  pairing: { uri: string; expiresAt: number } | null;
}
