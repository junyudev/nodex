import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const run = promisify(execFile);
const sources = fileURLToPath(new URL("../../modules/pinned-tls/ios/", import.meta.url));

it.skipIf(process.platform !== "darwin")(
  "frames the iOS pinned HTTP exchange and matches only the exact leaf pin",
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "nodex-pinned-http-"));
    try {
      const executable = path.join(directory, "pinned-http-test");
      await run("xcrun", [
        "swiftc",
        path.join(sources, "PinnedHttp.swift"),
        path.join(sources, "tests/main.swift"),
        "-o",
        executable,
      ]);
      const { stdout } = await run(executable);
      expect(stdout.trim()).toBe("Pinned HTTP passed");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  120_000,
);
