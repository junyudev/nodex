import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { assertPackagedPtyReceipt, runPackagedPtyProbe } from "./packaged-pty-probe.mjs";

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function addon(mode: "success" | "missing-output" | "wrong-exit" | "hang" | "late-exit") {
  const root = mkdtempSync(join(tmpdir(), "nodex PTY probe "));
  roots.push(root);
  const addonPath = join(root, "addon.cjs");
  const cleanup = join(root, "killed");
  writeFileSync(
    addonPath,
    `
    exports.spawn = (executable, args, options) => {
      for (const key of ["NODE_OPTIONS", "NODE_PATH", "ELECTRON_RUN_AS_NODE"])
        if (process.env[key] || options.env[key]) throw new Error("Inherited " + key);
      if (options.useConpty !== undefined || options.useConptyDll !== undefined)
        throw new Error("Probe must use the default ConPTY backend");
      const marker = /NODEX_PTY_[a-f0-9-]{36}/.exec(args[1])[0];
      return {
        pid: process.pid,
        onData(callback) { if (${JSON.stringify(mode)} === "success" || ${JSON.stringify(mode)} === "wrong-exit" || ${JSON.stringify(mode)} === "late-exit") setTimeout(() => callback(marker), 5); },
        onExit(callback) { if (${JSON.stringify(mode)} !== "hang") setTimeout(() => callback({exitCode: ${mode === "wrong-exit" ? 0 : 73}}), ${mode === "late-exit" ? 150 : 10}); },
        kill() { require("node:fs").writeFileSync(${JSON.stringify(cleanup)}, "killed"); },
      };
    };
  `,
  );
  return { addonPath, cleanup, nodeExecutable: process.execPath };
}

test("requires actual output and exact exit under a clean stock-Node environment", () => {
  const input = addon("success");
  vi.stubEnv("NODE_OPTIONS", "--require=/missing/inherited-loader.cjs");
  vi.stubEnv("NODE_PATH", "/missing/inherited-modules");
  vi.stubEnv("ELECTRON_RUN_AS_NODE", "1");
  const receipt = runPackagedPtyProbe(input);
  expect(receipt.addonPath).toBe(input.addonPath);
  expect(receipt.output).toBe(receipt.marker);
  expect(receipt.exitCode).toBe(73);
  expect(assertPackagedPtyReceipt(receipt)).toEqual(receipt);
});
test.each([
  ["missing-output", "missing output marker"],
  ["wrong-exit", "wrong exit code: 0"],
] as const)("rejects %s at the execution boundary", (mode, message) => {
  expect(() => runPackagedPtyProbe(addon(mode))).toThrow(message);
});
test("bounds a stalled PTY and kills only its owned terminal", () => {
  const input = addon("hang");
  expect(() => runPackagedPtyProbe({ ...input, timeoutMs: 100 })).toThrow("timed out");
  expect(readFileSync(input.cleanup, "utf8")).toBe("killed");
});
test("rejects missing and incomplete distribution receipts", () => {
  expect(() => assertPackagedPtyReceipt(undefined)).toThrow("receipt");
  const receipt = runPackagedPtyProbe(addon("success"));
  expect(() => assertPackagedPtyReceipt({ ...receipt, output: "" })).toThrow("receipt");
  expect(() => assertPackagedPtyReceipt({ ...receipt, exitCode: 0 })).toThrow("receipt");
});

test("a late successful exit cannot override a timeout failure", () => {
  const input = addon("late-exit");
  expect(() => runPackagedPtyProbe({ ...input, timeoutMs: 50 })).toThrow("timed out");
  expect(readFileSync(input.cleanup, "utf8")).toBe("killed");
});
