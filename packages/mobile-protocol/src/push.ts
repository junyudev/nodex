import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { z } from "zod";

import { decodeBase64Url, encodeBase64Url, utf8Bytes, utf8Text } from "./encoding";

/**
 * Notifications reach a phone through a relay that cannot read what they say. The relay seals the
 * phone's system push address into an opaque `handle` that only it can open. A Space host encrypts
 * each notification with a key only the phone and its Device registrations hold. Each Space learns
 * the handle and key from the phone's own request over its pinned channel.
 */
export const PUSH_RELAY_ORIGIN = "https://push.nodex.jyu.app";

export const PUSH_KEY_BYTES = 32;
export const PUSH_NONCE_BYTES = 12;

/** The system's limit is 4 KB for everything; these leave room for the sealing and its encoding. */
export const PUSH_TITLE_MAX_CHARS = 120;
export const PUSH_BODY_MAX_CHARS = 240;

export const PushPreferencesSchema = z.looseObject({
  /** A chat is asking for an approval or an answer. */
  needsYou: z.boolean(),
  /** A Run ended, whether it finished or failed. */
  finished: z.boolean(),
});
export type PushPreferences = z.infer<typeof PushPreferencesSchema>;

export const PushRegistrationSchema = z.looseObject({
  /** From the relay's `POST /v1/devices`. */
  handle: z.string().regex(/^[A-Za-z0-9_-]{1,1024}$/u),
  /** Base64url, `PUSH_KEY_BYTES` long. */
  key: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  preferences: PushPreferencesSchema,
});
export type PushRegistration = z.infer<typeof PushRegistrationSchema>;

/** What the phone shows, and the chat a tap opens. Only the phone and its Spaces can read this. */
export const PushPayloadSchema = z
  .looseObject({
    kind: z.enum(["needs_you", "finished", "failed"]),
    /** The chat a tap opens. A Page Turn that waits on no chat names its Page instead. */
    sessionId: z.string().optional(),
    /** The Page whose Turn it is, which a tap opens when there is no chat to open. */
    pageId: z.string().optional(),
    /** The Space and Member enrollment it came from (Hello's `host.id`), so a tap opens that Space. */
    hostId: z.string().optional(),
    title: z.string(),
    body: z.string(),
  })
  .refine((payload) => payload.sessionId !== undefined || payload.pageId !== undefined, {
    message: "A notification opens a chat or a Page",
  });
export type PushPayload = z.infer<typeof PushPayloadSchema>;

/** `POST /v1/devices`, from the phone. The answer is `{ handle }`. */
export const RelayDeviceRequestSchema = z.looseObject({
  /** The system's device token, in hexadecimal. */
  token: z.string().regex(/^[0-9a-fA-F]{32,200}$/u),
  environment: z.enum(["sandbox", "production"]),
  bundleId: z.string(),
});
export type RelayDeviceRequest = z.infer<typeof RelayDeviceRequestSchema>;

/**
 * `POST /v1/push`, from a Space host. `410` means this phone is gone and the handle should be forgotten;
 * `429` and `5xx` are worth a later retry; anything else is a defect.
 */
export const RelayPushRequestSchema = z.looseObject({
  handle: z.string(),
  /** From `sealPushPayload`. */
  sealed: z.string(),
  /** `time-sensitive` breaks through Focus, for something that holds a Run until answered. */
  urgency: z.enum(["active", "time-sensitive"]),
});
export type RelayPushRequest = z.infer<typeof RelayPushRequestSchema>;

export const encodePushKey = encodeBase64Url;
export const decodePushKey = decodeBase64Url;

/** ChaCha20-Poly1305 as base64url of nonce, ciphertext, tag: the order Apple's `ChaChaPoly` reads. */
export const sealPushPayload = (
  key: Uint8Array,
  nonce: Uint8Array,
  payload: PushPayload,
): string => {
  const plaintext = utf8Bytes(JSON.stringify(payload));
  const sealed = chacha20poly1305(key, nonce).encrypt(plaintext);
  const combined = new Uint8Array(nonce.length + sealed.length);
  combined.set(nonce);
  combined.set(sealed, nonce.length);
  return encodeBase64Url(combined);
};

/** The notification, or null when this key did not seal it. */
export const openPushPayload = (key: Uint8Array, sealed: string): PushPayload | null => {
  try {
    const combined = decodeBase64Url(sealed);
    const nonce = combined.subarray(0, PUSH_NONCE_BYTES);
    const ciphertext = combined.subarray(PUSH_NONCE_BYTES);
    const plaintext = chacha20poly1305(key, nonce).decrypt(ciphertext);
    return PushPayloadSchema.parse(JSON.parse(utf8Text(plaintext)));
  } catch {
    return null;
  }
};
