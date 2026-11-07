import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { allowedBundle, validateDevice, type Device } from "./validation.js";

const AAD = Buffer.from("nodex-push-device:v1");
const VERSION = 1;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const NONCE_END = 1 + NONCE_BYTES;
const TAG_END = NONCE_END + TAG_BYTES;

export const createHandles = (encodedKey: string) => {
  const key = Buffer.from(encodedKey, "base64");
  if (key.length !== 32 || key.toString("base64") !== encodedKey) {
    throw new Error("Invalid PUSH_RELAY_SEAL_KEY");
  }

  return {
    seal(device: Device): string {
      if (!allowedBundle(device.bundleId)) throw new Error("BundleNotAllowed");
      const nonce = randomBytes(NONCE_BYTES);
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      cipher.setAAD(AAD);
      const ciphertext = Buffer.concat([
        cipher.update(JSON.stringify(device), "utf8"),
        cipher.final(),
      ]);
      return Buffer.concat([
        Buffer.from([VERSION]),
        nonce,
        cipher.getAuthTag(),
        ciphertext,
      ]).toString("base64url");
    },
    open(handle: string): Device | null {
      if (handle.length > 1024 || !/^[A-Za-z0-9_-]+$/u.test(handle)) return null;
      const bytes = Buffer.from(handle, "base64url");
      if (bytes.length <= TAG_END || bytes[0] !== VERSION) return null;
      if (bytes.toString("base64url") !== handle) return null;
      try {
        const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(1, NONCE_END));
        decipher.setAAD(AAD);
        decipher.setAuthTag(bytes.subarray(NONCE_END, TAG_END));
        const plaintext = Buffer.concat([
          decipher.update(bytes.subarray(TAG_END)),
          decipher.final(),
        ]);
        const device = validateDevice(JSON.parse(plaintext.toString("utf8")));
        return device && allowedBundle(device.bundleId) ? device : null;
      } catch {
        return null;
      }
    },
  };
};
