export type DesktopNotificationAuthorization =
  | "not-determined"
  | "denied"
  | "authorized"
  | "provisional"
  | "unknown"
  | "unsupported";

export function canDeliverDesktopNotification(status: DesktopNotificationAuthorization): boolean {
  return status === "authorized" || status === "provisional" || status === "unknown";
}
