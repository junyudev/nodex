export const MAX_BODY_BYTES = 8 * 1024;
export const MAX_APNS_BYTES = 4096;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// Keep the wire grammar aligned with mobile-protocol; authorize topics separately.
export const validateDevice = (value: unknown) => {
  if (!isObject(value)) return null;
  const { token, environment, bundleId } = value;
  if (typeof token !== "string" || !/^[0-9a-fA-F]{32,200}$/u.test(token)) return null;
  if (environment !== "sandbox" && environment !== "production") return null;
  if (typeof bundleId !== "string") return null;
  return { token, environment, bundleId };
};
export type Device = NonNullable<ReturnType<typeof validateDevice>>;

export const allowedBundle = (bundleId: string): boolean =>
  bundleId === "app.jyu.nodex.mobile" || bundleId === "app.jyu.nodex.mobile.dev";

export const validatePush = (value: unknown) => {
  if (!isObject(value)) return null;
  const { handle, sealed, urgency } = value;
  if (typeof handle !== "string" || typeof sealed !== "string") return null;
  if (urgency !== "active" && urgency !== "time-sensitive") return null;
  return { handle, sealed, urgency };
};
export type Push = NonNullable<ReturnType<typeof validatePush>>;

export const pushBody = ({ sealed, urgency }: Push): string =>
  JSON.stringify({
    aps: {
      alert: { title: "Nodex", body: "You have an update." },
      "mutable-content": 1,
      sound: "default",
      "interruption-level": urgency,
    },
    n: sealed,
  });
