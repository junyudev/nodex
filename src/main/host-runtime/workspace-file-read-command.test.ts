import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vite-plus/test";
import { workspaceFileReadCommand } from "./workspace-file-read-command";

test.runIf(process.platform !== "win32")(
  "host command bounds bytes and treats exact filenames as data",
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nodex-bounded-host-read-"));
    try {
      const file = path.join(root, "media '$()' 空格.webm ");
      await writeFile(file, Buffer.from([0, 1, 2, 3, 4, 5]));
      const execute = async (sampleBytes: number, maxBytes?: number) => {
        const [command, ...args] = workspaceFileReadCommand(file, sampleBytes, maxBytes);
        return (await promisify(execFile)(command!, args)).stdout;
      };
      expect(await execute(4)).toBe("6\nAAECAw==\n");
      expect(await execute(7, 5)).toBe("6\n");
      expect(await execute(7, 6)).toBe("6\nAAECAwQF\n");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  },
);
