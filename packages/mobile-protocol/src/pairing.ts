import { z } from "zod";

/** The app's URL scheme, so a phone's system camera can open a pairing QR code directly. */
export const MOBILE_URL_SCHEME = "nodex-mobile";

/** Everything a phone needs to reach and authenticate a Host once. Shown only as a QR or a link. */
export const PairingOfferSchema = z.looseObject({
  /** Host static public key, base64url. Pins the Host's identity from the first message. */
  hostKey: z.string(),
  hostName: z.string(),
  /** The one-time secret, base64url. */
  secret: z.string(),
  /** WebSocket URLs, best first. */
  routes: z.array(z.string()).min(1),
  /** Epoch milliseconds. */
  expiresAt: z.number(),
});
export type PairingOffer = z.infer<typeof PairingOfferSchema>;

const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

// URI encoding supplies UTF-8 without relying on browser globals in the mobile runtime.
const base64UrlEncodeText = (text: string): string => {
  const bytes = encodeURIComponent(text).replace(/%([0-9A-F]{2})/gu, (_, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
  let encoded = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte.charCodeAt(0);
    bits += 8;
    while (bits >= 6) {
      bits -= 6;
      encoded += BASE64URL.charAt((buffer >>> bits) & 63);
    }
  }
  if (bits > 0) encoded += BASE64URL.charAt((buffer << (6 - bits)) & 63);
  return encoded;
};

const base64UrlDecodeText = (encoded: string): string => {
  if (encoded.length % 4 === 1) throw new Error("Invalid base64url length");
  let escaped = "";
  let buffer = 0;
  let bits = 0;
  for (const char of encoded) {
    const digit = BASE64URL.indexOf(char);
    if (digit < 0) throw new Error("Invalid base64url character");
    buffer = (buffer << 6) | digit;
    bits += 6;
    if (bits < 8) continue;
    bits -= 8;
    escaped += `%${((buffer >>> bits) & 255).toString(16).padStart(2, "0")}`;
  }
  if ((buffer & ((1 << bits) - 1)) !== 0) throw new Error("Invalid base64url trailing bits");
  return decodeURIComponent(escaped);
};

export const encodePairingUri = (offer: PairingOffer): string =>
  `${MOBILE_URL_SCHEME}://pair#${base64UrlEncodeText(JSON.stringify(offer))}`;

/** Returns null for anything that is not a well formed offer. Expiry is the caller's to report. */
export const parsePairingUri = (uri: string): PairingOffer | null => {
  const prefix = `${MOBILE_URL_SCHEME}://pair#`;
  const trimmed = uri.trim();
  if (!trimmed.startsWith(prefix)) return null;
  try {
    const parsed = PairingOfferSchema.safeParse(
      JSON.parse(base64UrlDecodeText(trimmed.slice(prefix.length))),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};
