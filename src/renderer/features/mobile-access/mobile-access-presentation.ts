import type { MobileDevice } from "../../../shared/mobile-access";

const PLATFORM_NAMES: Readonly<Record<string, string>> = { ios: "iOS", android: "Android" };

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** How recently a phone was here, in the words a paired-device list uses. */
export const describeLastSeen = (lastSeenAt: number | null, now: number): string => {
  if (lastSeenAt === null) return "Not connected yet";
  const elapsed = Math.max(0, now - lastSeenAt);
  if (elapsed < MINUTE) return "Seen just now";
  if (elapsed < HOUR) return `Seen ${Math.floor(elapsed / MINUTE)}m ago`;
  if (elapsed < DAY) return `Seen ${Math.floor(elapsed / HOUR)}h ago`;
  return `Seen ${Math.floor(elapsed / DAY)}d ago`;
};

export const describeDevice = (device: MobileDevice, now: number): string =>
  [
    PLATFORM_NAMES[device.platform] ?? device.platform,
    device.appVersion ? `Nodex Mobile ${device.appVersion}` : null,
    device.notificationsEnabled ? "Notifications on" : "Notifications off",
    device.connected ? "Connected" : describeLastSeen(device.lastSeenAt, now),
  ]
    .filter(Boolean)
    .join(" · ");

/** The time left on a pairing code, as `4:05`; never negative. */
export const formatPairingCountdown = (expiresAt: number, now: number): string => {
  const seconds = Math.max(0, Math.ceil((expiresAt - now) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

const ROUTE_ADDRESS = /^wss?:\/\/([^/:]+)/u;

/** The addresses behind a Host's routes, for telling which network a phone must be on. */
export const routeAddresses = (routes: readonly string[]): readonly string[] =>
  routes.flatMap((route) => {
    const address = ROUTE_ADDRESS.exec(route)?.[1];
    return address ? [address] : [];
  });
