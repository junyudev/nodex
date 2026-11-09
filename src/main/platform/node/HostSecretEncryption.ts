/* @effect-diagnostics asyncFunction:off -- Private file and native crypto Adapter for a headless Host. */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import type { SecretEncryptionAdapter } from "../SecretEncryption";
import { verifyPrivatePaths } from "./private-filesystem";

/** The key stays beside Core's administration material, outside the execution home. */
export async function hostSecretEncryption(
  coreHome: string,
  coreExecutable: string,
): Promise<SecretEncryptionAdapter> {
  const path = join(coreHome, "settings.key");
  await verifyPrivatePaths([{ path: coreHome, directory: true }], coreExecutable);
  const created = await open(path, "wx", 0o600).catch((cause: unknown) => {
    if ((cause as NodeJS.ErrnoException).code === "EEXIST") return null;
    throw cause;
  });
  if (created) {
    try {
      await created.writeFile(randomBytes(32));
      await created.sync();
    } finally {
      await created.close();
    }
  }
  await verifyPrivatePaths([{ path, directory: false }], coreExecutable);
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  const key = await (async () => {
    try {
      const metadata = await file.stat();
      if (!metadata.isFile() || metadata.size !== 32 || metadata.nlink !== 1)
        throw new Error("Host settings key is invalid");
      if (
        process.platform !== "win32" &&
        (metadata.uid !== process.getuid?.() || (metadata.mode & 0o777) !== 0o600)
      )
        throw new Error("Host settings key must be owner-only");
      return await file.readFile();
    } finally {
      await file.close();
    }
  })();
  return {
    isAvailable: () => true,
    encryptString: (plaintext) => {
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      return Buffer.concat([Buffer.from([1]), nonce, cipher.getAuthTag(), encrypted]);
    },
    decryptString: (ciphertext) => {
      if (ciphertext.length < 29 || ciphertext[0] !== 1)
        throw new Error("Host secret encoding is invalid");
      const cipher = createDecipheriv("aes-256-gcm", key, ciphertext.subarray(1, 13));
      cipher.setAuthTag(ciphertext.subarray(13, 29));
      return Buffer.concat([cipher.update(ciphertext.subarray(29)), cipher.final()]).toString(
        "utf8",
      );
    },
  };
}
