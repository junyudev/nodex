/* @effect-diagnostics asyncFunction:off -- Verifies an owned native process tree, including Windows taskkill. */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { expect, test } from "vite-plus/test";
import { killChildProcessTree } from "./process-tree";

test.runIf(process.platform === "win32")(
  "terminates descendants of an owned Windows console process",
  async () => {
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL("../../tests/fixtures/scoped-process-tree.mjs", import.meta.url))],
      { stdio: ["ignore", "pipe", "inherit"], windowsHide: true },
    );
    try {
      const [output] = await once(child.stdout!, "data");
      const [leader, descendant] = String(output).trim().split(" ").map(Number);
      expect(leader).toBe(child.pid);
      expect(descendant).toBeGreaterThan(0);
      const exited = once(child, "exit");
      killChildProcessTree(child, "SIGTERM", "win32");
      await exited;
      await expect
        .poll(() => {
          try {
            process.kill(descendant!, 0);
            return true;
          } catch {
            return false;
          }
        })
        .toBe(false);
    } finally {
      killChildProcessTree(child, "SIGKILL", "win32");
    }
  },
);
