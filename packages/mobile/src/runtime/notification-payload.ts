/** The chat a notification belongs to, which the phone's notification extension attached. */
export const chatOfNotificationRequest = (request: {
  readonly trigger?: unknown;
}): { readonly sessionId: string; readonly hostId: string | null } | null => {
  const { trigger } = request;
  if (typeof trigger !== "object" || trigger === null || !("payload" in trigger)) return null;
  const { payload } = trigger;
  if (typeof payload !== "object" || payload === null || !("sessionId" in payload)) return null;
  const { sessionId } = payload;
  if (typeof sessionId !== "string" || sessionId.length === 0) return null;
  const hostId = "hostId" in payload && typeof payload.hostId === "string" ? payload.hostId : null;
  return { sessionId, hostId };
};

/** The chat behind a tapped notification. */
export const chatOfNotification = (response: {
  readonly notification: {
    readonly request: { readonly trigger?: unknown };
  };
}) => chatOfNotificationRequest(response.notification.request);
