/* @effect-diagnostics asyncFunction:off -- Exercises persistent encryption and native permission admission. */
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "vite-plus/test";
import { requiredNativeExecutable } from "../../../../scripts/testing/native-artifacts";
import { hostSecretEncryption } from "./HostSecretEncryption";

test("host secrets survive restart, reject tampering, and require a private key", async () => {
  const home = await mkdtemp(join(tmpdir(), "nodex-host-key-"));
  const core = requiredNativeExecutable("core-server");
  try {
    const first = await hostSecretEncryption(home, core);
    const secret = "provider-test-secret";
    const ciphertext = first.encryptString(secret);
    expect(ciphertext.includes(Buffer.from(secret))).toBe(false);
    const reopened = await hostSecretEncryption(home, core);
    expect(reopened.decryptString(ciphertext)).toBe(secret);
    ciphertext[ciphertext.length - 1] ^= 1;
    expect(() => reopened.decryptString(ciphertext)).toThrow();
    if (process.platform === "win32") return;
    await chmod(join(home, "settings.key"), 0o640);
    await expect(hostSecretEncryption(home, core)).rejects.toThrow();
  } finally {
    await rm(home, { force: true, recursive: true });
  }
});
