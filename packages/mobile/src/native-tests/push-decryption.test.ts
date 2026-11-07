import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const run = promisify(execFile);
const sources = fileURLToPath(new URL("../../notification-service/", import.meta.url));

it.skipIf(process.platform !== "darwin")(
  "opens the protocol vector in CryptoKit and rejects invalid notifications",
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "nodex-push-decryption-"));
    try {
      const executable = path.join(directory, "push-decryption-test");
      await run("xcrun", [
        "swiftc",
        path.join(sources, "PushDecryption.swift"),
        path.join(sources, "tests/main.swift"),
        "-o",
        executable,
      ]);
      const { stdout } = await run(executable);
      expect(stdout.trim()).toBe("Push decryption passed");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  60_000,
);
