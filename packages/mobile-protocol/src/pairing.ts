import { z } from "zod";

import { decodeBase64Url, encodeBase64Url, utf8Bytes, utf8Text } from "./encoding";

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

export const encodePairingUri = (offer: PairingOffer): string =>
  `${MOBILE_URL_SCHEME}://pair#${encodeBase64Url(utf8Bytes(JSON.stringify(offer)))}`;

/** Returns null for anything that is not a well formed offer. Expiry is the caller's to report. */
export const parsePairingUri = (uri: string): PairingOffer | null => {
  const prefix = `${MOBILE_URL_SCHEME}://pair#`;
  const trimmed = uri.trim();
  if (!trimmed.startsWith(prefix)) return null;
  try {
    const parsed = PairingOfferSchema.safeParse(
      JSON.parse(utf8Text(decodeBase64Url(trimmed.slice(prefix.length)))),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};
