import { z } from "zod";

import { decodeBase64Url, encodeBase64Url, utf8Bytes, utf8Text } from "./encoding";

export const MOBILE_URL_SCHEME = "nodex-mobile";
export const DEVICE_LINK_REVISION = 1;

/** One-time Core-issued offer. Routes carry coordinates; only the certificate pin establishes trust. */
export const DeviceLinkOfferSchema = z.strictObject({
  space_id: z.string().min(1).max(512),
  space_name: z.string().min(1).max(512),
  member_id: z.string().min(1).max(512),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/iu),
  routes: z
    .array(
      z
        .url()
        .max(2048)
        .regex(/^https:\/\/(?:\[[a-f0-9:.]+\]|[^/:@?#\\\s]+)(?::[0-9]{1,5})?\/?$/iu),
    )
    .min(1)
    .max(32),
  code: z.string().min(1).max(512),
  expires_at: z.number().int().positive(),
});
export type DeviceLinkOffer = Readonly<Omit<z.infer<typeof DeviceLinkOfferSchema>, "routes">> & {
  readonly routes: readonly string[];
};

const prefix = `${MOBILE_URL_SCHEME}://link#`;

export const encodeDeviceLink = (offer: DeviceLinkOffer): string => {
  const uri = `${prefix}${encodeBase64Url(utf8Bytes(JSON.stringify({ version: DEVICE_LINK_REVISION, offer: DeviceLinkOfferSchema.parse(offer) })))}`;
  if (uri.length > 32768) throw new Error("Device link exceeds its bound");
  return uri;
};
export const createDeviceLinkUri = encodeDeviceLink;

/** No compatibility decoder: unknown versions and non-HTTPS routes require a fresh link. */
export const parseDeviceLinkUri = (uri: string): DeviceLinkOffer | null => {
  const trimmed = uri.trim();
  if (trimmed.length > 32768 || !trimmed.startsWith(prefix)) return null;
  try {
    const parsed = z
      .strictObject({ version: z.literal(DEVICE_LINK_REVISION), offer: DeviceLinkOfferSchema })
      .safeParse(JSON.parse(utf8Text(decodeBase64Url(trimmed.slice(prefix.length)))));
    return parsed.success ? parsed.data.offer : null;
  } catch {
    return null;
  }
};
