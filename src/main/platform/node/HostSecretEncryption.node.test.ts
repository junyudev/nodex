/* @effect-diagnostics asyncFunction:off -- Exercises persistent encryption and native permission admission. */
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "vite-plus/test";
import { requiredNativeExecutable } from "../../../../scripts/testing/native-artifacts";
import { makePrivatePaths } from "./private-filesystem";
import { hostSecretEncryption } from "./HostSecretEncryption";

test("host secrets survive restart, reject tampering, and require a private key", async () => {
  const home = await mkdtemp(join(tmpdir(), "nodex-host-key-"));
  const core = requiredNativeExecutable("core-server");
  try {
    await makePrivatePaths([{ path: home, directory: true }], core);
    const first = await hostSecretEncryption(home, core);
    const secret = "provider-test-secret";
    const ciphertext = first.encryptString(secret);
    expect(ciphertext.includes(Buffer.from(secret))).toBe(false);
    const reopened = await hostSecretEncryption(home, core);
    expect(reopened.decryptString(ciphertext)).toBe(secret);
    ciphertext[ciphertext.length - 1] ^= 1;
    expect(() => reopened.decryptString(ciphertext)).toThrow();
    const keyPath = join(home, "settings.key");
    if (process.platform === "win32") {
      // An ordinary Node write inherits the parent DACL instead of setting a protected one.
      const key = await readFile(keyPath);
      await rm(keyPath);
      await writeFile(keyPath, key);
    } else {
      await chmod(keyPath, 0o640);
    }
    await expect(hostSecretEncryption(home, core)).rejects.toThrow();
  } finally {
    await rm(home, { force: true, recursive: true });
  }
});
