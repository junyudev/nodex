/**
 * What the phone's notification extension attached to a notification: the chat and the Page it is
 * about, either or both, and the Space and Member enrollment that sent it.
 */
export interface NotificationSubject {
  readonly sessionId: string | null;
  readonly pageId: string | null;
  readonly hostId: string | null;
}

/** Where a tapped notification leads: its chat, or the Page whose Turn it is when it has none. */
export type NotificationTarget =
  | { readonly kind: "chat"; readonly sessionId: string; readonly hostId: string | null }
  | { readonly kind: "page"; readonly pageId: string; readonly hostId: string | null };

const text = (payload: object, key: string) =>
  key in payload && typeof (payload as Record<string, unknown>)[key] === "string"
    ? ((payload as Record<string, unknown>)[key] as string) || null
    : null;

/** Null for a notification that names neither a chat nor a Page. */
export const subjectOfNotificationRequest = (request: {
  readonly trigger?: unknown;
}): NotificationSubject | null => {
  const { trigger } = request;
  if (typeof trigger !== "object" || trigger === null || !("payload" in trigger)) return null;
  const { payload } = trigger;
  if (typeof payload !== "object" || payload === null) return null;
  const sessionId = text(payload, "sessionId");
  const pageId = text(payload, "pageId");
  return sessionId || pageId ? { sessionId, pageId, hostId: text(payload, "hostId") } : null;
};

/** What a tapped notification opens. */
export const targetOfNotification = (response: {
  readonly notification: {
    readonly request: { readonly trigger?: unknown };
  };
}): NotificationTarget | null => {
  const subject = subjectOfNotificationRequest(response.notification.request);
  if (subject?.sessionId)
    return { kind: "chat", sessionId: subject.sessionId, hostId: subject.hostId };
  if (subject?.pageId) return { kind: "page", pageId: subject.pageId, hostId: subject.hostId };
  return null;
};
