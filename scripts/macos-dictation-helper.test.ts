import { spawn, execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import { beforeAll, expect, test } from "vitest";
import { MAC_DICTATION_HELPER_PROTOCOL_VERSION } from "../src/main/dictation/mac-dictation-native-helper-client";

const helper = path.resolve(".generated/dev-runtime/bin/nodex-dictation-helper");
const macOS = process.platform === "darwin";

beforeAll(() => {
  if (!macOS) return;
  execFileSync("vp", ["run", "dictation-helper:build:dev"], { stdio: "pipe" });
});

test.skipIf(!macOS)("replies to newline commands while its stdin pipe remains open", async () => {
  const child = spawn(helper, [], { stdio: ["pipe", "pipe", "pipe"] });
  child.stderr.resume();
  const reader = createInterface({ input: child.stdout });
  const lines: unknown[] = [];
  const waiting = new Map<string, (value: Record<string, unknown>) => void>();
  // Spawn failures settle without an unhandled rejection or an exit event to wait for.
  const stopped = new Promise<Error | null>((resolve) => {
    child.once("error", resolve);
    child.once("close", () => resolve(null));
  });
  const waitForStop = async (): Promise<Error | null> => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        stopped,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error("Native dictation helper did not exit")),
            2000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
  };
  const read = async (key: string): Promise<Record<string, unknown>> => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        new Promise<Record<string, unknown>>((resolve, reject) => {
          timeout = setTimeout(() => {
            reject(new Error(`Native dictation helper did not reply to ${key} with stdin open`));
          }, 2000);
          waiting.set(key, resolve);
        }),
        stopped.then((error) => {
          throw error ?? new Error(`Native dictation helper exited before replying to ${key}`);
        }),
      ]);
    } finally {
      clearTimeout(timeout);
      waiting.delete(key);
    }
  };
  reader.on("line", (line) => {
    const value = JSON.parse(line) as Record<string, unknown>;
    lines.push(value);
    const key = value.type === "ready" ? "ready" : String(value.id);
    waiting.get(key)?.(value);
    waiting.delete(key);
  });
  try {
    await expect(read("ready")).resolves.toMatchObject({
      type: "ready",
      protocolVersion: MAC_DICTATION_HELPER_PROTOCOL_VERSION,
    });
    const first = read("first");
    child.stdin.write(`${JSON.stringify({ id: "first", type: "queryBuiltInMic" })}\n`);
    const response = await first;
    expect(response).toMatchObject({ type: "response", id: "first", ok: true });
    expect(response.value === null || typeof response.value === "string").toBe(true);
    expect(child.stdin.writableEnded).toBe(false);

    // A later newline must remain independently consumable in the same process.
    const second = read("second");
    child.stdin.write(`${JSON.stringify({ id: "second", type: "queryBuiltInMic" })}\n`);
    await expect(second).resolves.toMatchObject({ type: "response", id: "second", ok: true });
    expect(child.stdin.writableEnded).toBe(false);
    expect(lines).toHaveLength(3);
    child.stdin.end();
    const error = await waitForStop();
    if (error) throw error;
    expect(child.exitCode).toBe(0);
  } finally {
    reader.close();
    child.stdin.end();
    try {
      await waitForStop();
    } catch {
      child.kill("SIGKILL");
      await waitForStop();
    }
  }
});
