import { expect, test } from "vite-plus/test";
import { installPlaywrightChromium } from "./install-playwright";

const result = (exitCode: number) => ({ exitCode, signal: null, durationMs: 1 });

test("installs the browser on macOS without Linux package dependencies", async () => {
  const observed: string[][] = [];
  const exit = await installPlaywrightChromium({
    platform: "darwin",
    signal: new AbortController().signal,
    execute: async (command) => {
      observed.push([...command.args]);
      return result(0);
    },
  });
  expect(exit).toBe(0);
  expect(observed).toEqual([["exec", "playwright", "install", "chromium"]]);
});

test("preserves installation failures instead of masking them with a retry", async () => {
  let calls = 0;
  expect(
    await installPlaywrightChromium({
      platform: "linux",
      signal: new AbortController().signal,
      execute: async () => {
        calls++;
        return result(127);
      },
    }),
  ).toBe(127);
  expect(calls).toBe(1);
});

test("retries browser-only after a system dependency timeout", async () => {
  const attempts: boolean[] = [];
  const exit = await installPlaywrightChromium({
    platform: "linux",
    signal: new AbortController().signal,
    timeoutMs: 1,
    execute: async (command) => {
      const withDependencies = command.args.includes("--with-deps");
      attempts.push(withDependencies);
      if (!withDependencies) return result(0);
      await new Promise<void>((resolve) =>
        command.signal!.addEventListener("abort", () => resolve(), { once: true }),
      );
      return result(130);
    },
  });
  expect(exit).toBe(0);
  expect(attempts).toEqual([true, false]);
});

test("user cancellation prevents fallback installation", async () => {
  const controller = new AbortController();
  let calls = 0;
  expect(
    await installPlaywrightChromium({
      platform: "linux",
      signal: controller.signal,
      execute: async () => {
        calls++;
        controller.abort();
        return result(130);
      },
    }),
  ).toBe(130);
  expect(calls).toBe(1);
});
