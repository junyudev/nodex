import type { components } from "@nodex/core-protocol";

type Member = components["schemas"]["Member"];
type MemberDevice = components["schemas"]["MemberDevice"];

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** How recently a Device reached this Space. Core records seconds since the epoch. */
export const describeLastSeen = (lastSeen: number, nowSeconds: number): string => {
  const elapsed = Math.max(0, nowSeconds - lastSeen);
  if (elapsed < MINUTE) return "Seen just now";
  if (elapsed < HOUR) return `Seen ${Math.floor(elapsed / MINUTE)}m ago`;
  if (elapsed < DAY) return `Seen ${Math.floor(elapsed / HOUR)}h ago`;
  return `Seen ${Math.floor(elapsed / DAY)}d ago`;
};

/** How long an offer has left: a ticking `4:05` under an hour, then whole hours. */
export const describeExpiry = (expiresAt: number, nowSeconds: number): string => {
  const seconds = Math.max(0, Math.ceil(expiresAt - nowSeconds));
  if (seconds === 0) return "Expired";
  if (seconds >= 2 * HOUR) return `Works once · expires in ${Math.floor(seconds / HOUR)} hours`;
  if (seconds >= HOUR) return "Works once · expires in 1 hour";
  return `Works once · expires in ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

/** The hosts behind HTTPS routes, so the person can tell which network a device must be on. */
export const routeHosts = (routes: readonly string[]): readonly string[] =>
  routes.flatMap((route) => {
    try {
      return [new URL(route).hostname];
    } catch {
      return [];
    }
  });

/**
 * One line under a Device: whose it is when that is not the reader, what it is, whether it hears
 * about chats while away, and when it was here.
 */
export const describeDevice = (
  device: MemberDevice,
  ownerName: string | null,
  thisDevice: boolean,
  nowSeconds: number,
): string =>
  [
    ownerName,
    thisDevice ? "This computer" : device.form_factor === "phone" ? "Phone" : "Computer",
    device.notifications_enabled ? "Notifications on" : null,
    thisDevice ? null : describeLastSeen(device.last_seen, nowSeconds),
  ]
    .filter(Boolean)
    .join(" · ");

/** The reader first, then everyone else as Core lists them. */
export const peopleInOrder = (
  members: readonly Member[],
  readerId: string | null,
): readonly Member[] =>
  members
    .filter((member) => member.lifecycle === "active")
    .toSorted((a, b) => Number(b.id === readerId) - Number(a.id === readerId));

/** Devices a person can still revoke, the reader's own first, then by when they were linked. */
export const activeDevices = (
  devices: readonly MemberDevice[],
  readerId: string | null,
): readonly MemberDevice[] =>
  devices
    .filter((device) => device.revoked_at === null || device.revoked_at === undefined)
    .toSorted(
      (a, b) =>
        Number(b.member_id === readerId) - Number(a.member_id === readerId) ||
        a.created_at - b.created_at,
    );

export const roleLabel = (role: Member["role"]): string => (role === "owner" ? "Owner" : "Member");

/** A desktop joins with a URL that pins the certificate, and the one-time code beside it. */
export const joinLinkFor = (route: string, fingerprint: string): string => {
  const url = new URL(route);
  url.pathname = "/";
  url.search = new URLSearchParams({ fingerprint }).toString();
  return url.toString();
};
