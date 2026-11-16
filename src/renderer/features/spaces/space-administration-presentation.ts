import { getIntl, type IntlShape } from "@/lib/i18n";
import type { components } from "@nodex/core-protocol";

type Member = components["schemas"]["Member"];
type MemberDevice = components["schemas"]["MemberDevice"];

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** How recently a Device reached this Space. Core records seconds since the epoch. */
export const describeLastSeen = (
  lastSeen: number,
  nowSeconds: number,
  intl: IntlShape = getIntl(),
): string => {
  const elapsed = Math.max(0, nowSeconds - lastSeen);
  if (elapsed < MINUTE)
    return intl.formatMessage({
      id: "spaces.spaceAdministrationPresentation.seenJustNow",
      defaultMessage: "Seen just now",
    });
  if (elapsed < HOUR)
    return intl.formatMessage(
      {
        id: "spaces.spaceAdministrationPresentation.seenValueMAgo",
        defaultMessage: "Seen {value1}m ago",
      },
      { value1: Math.floor(elapsed / MINUTE) },
    );
  if (elapsed < DAY)
    return intl.formatMessage(
      {
        id: "spaces.spaceAdministrationPresentation.seenValueHAgo",
        defaultMessage: "Seen {value1}h ago",
      },
      { value1: Math.floor(elapsed / HOUR) },
    );
  return intl.formatMessage(
    {
      id: "spaces.spaceAdministrationPresentation.seenValueDAgo",
      defaultMessage: "Seen {value1}d ago",
    },
    { value1: Math.floor(elapsed / DAY) },
  );
};

/** How long an offer has left: a ticking `4:05` under an hour, then whole hours. */
export const describeExpiry = (
  expiresAt: number,
  nowSeconds: number,
  intl: IntlShape = getIntl(),
): string => {
  const seconds = Math.max(0, Math.ceil(expiresAt - nowSeconds));
  if (seconds === 0)
    return intl.formatMessage({
      id: "spaces.spaceAdministrationPresentation.expired",
      defaultMessage: "Expired",
    });
  if (seconds >= 2 * HOUR)
    return intl.formatMessage(
      {
        id: "spaces.spaceAdministrationPresentation.worksOnceExpiresInValue",
        defaultMessage: "Works once · expires in {value1} hours",
      },
      { value1: Math.floor(seconds / HOUR) },
    );
  if (seconds >= HOUR)
    return intl.formatMessage({
      id: "spaces.spaceAdministrationPresentation.worksOnceExpiresIn1",
      defaultMessage: "Works once · expires in 1 hour",
    });
  return intl.formatMessage(
    {
      id: "spaces.spaceAdministrationPresentation.worksOnceExpiresInValue2",
      defaultMessage: "Works once · expires in {value1}:{value2}",
    },
    { value1: Math.floor(seconds / 60), value2: String(seconds % 60).padStart(2, "0") },
  );
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
  intl: IntlShape = getIntl(),
): string =>
  [
    ownerName,
    thisDevice
      ? intl.formatMessage({
          id: "spaces.spaceAdministrationPresentation.thisComputer",
          defaultMessage: "This computer",
        })
      : device.form_factor === "phone"
        ? intl.formatMessage({
            id: "spaces.spaceAdministrationPresentation.phone",
            defaultMessage: "Phone",
          })
        : intl.formatMessage({
            id: "spaces.spaceAdministrationPresentation.computer",
            defaultMessage: "Computer",
          }),
    device.notifications_enabled
      ? intl.formatMessage({
          id: "spaces.spaceAdministrationPresentation.notificationsOn",
          defaultMessage: "Notifications on",
        })
      : null,
    thisDevice ? null : describeLastSeen(device.last_seen, nowSeconds, intl),
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

export const roleLabel = (role: Member["role"], intl: IntlShape = getIntl()): string =>
  role === "owner"
    ? intl.formatMessage({
        id: "spaces.spaceAdministrationPresentation.owner",
        defaultMessage: "Owner",
      })
    : intl.formatMessage({
        id: "spaces.spaceAdministrationPresentation.member",
        defaultMessage: "Member",
      });

/** A desktop joins with a URL that pins the certificate, and the one-time code beside it. */
export const joinLinkFor = (route: string, fingerprint: string): string => {
  const url = new URL(route);
  url.pathname = "/";
  url.search = new URLSearchParams({ fingerprint }).toString();
  return url.toString();
};
