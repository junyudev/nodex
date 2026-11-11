import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vite-plus/test";
import { vitePlusCommand } from "../../scripts/vite-plus-command.ts";

const plugin = fileURLToPath(new URL("./index.ts", import.meta.url));

interface RuleCase {
  readonly rule: string;
  readonly invalid: string;
  readonly valid: string;
  readonly count: number;
  readonly invalidFile?: string;
  readonly extraValid?: Readonly<Record<string, string>>;
}

const cases: readonly RuleCase[] = [
  {
    rule: "no-explicit-test-timeout",
    invalidFile: "tests/e2e/invalid.spec.ts",
    invalid: `
      import { expect as check } from "@playwright/test";
      import { waitFor as wait } from "@testing-library/react";
      await wait(ready, { timeout: 100 });
      await waitForElementToBeRemoved(node, { timeout: 100 });
      await screen.findByRole("button", {}, { timeout: 100 });
      await screen.findAllByText("name", {}, { "timeout": 100 });
      await vi.waitFor(ready, { timeout: 100 });
      const budget = 100;
      await vi.waitUntil(ready, budget);
      await check.poll(ready, { timeout: 100 }).toBe(true);
      await check(locator).not.toHaveText("waiting", { timeout: 100 });
      await check(ready).toPass({ timeout: 100 });
      await locator.waitFor({ state: "visible", timeout: 100 });
      test("timeout last", ready, 100);
      it.each(cases)("timeout first", { timeout: 100 }, ready);
      describe("suite", ready, 100);
      beforeAll(ready, 100);
      test.setTimeout(100);
      test.describe.configure({ timeout: 100 });
      vi.setConfig({ hookTimeout: 100 });
    `,
    valid: `
      await waitFor(ready, { interval: 100 });
      await screen.findByText("name", { selector: "button" });
      await vi.waitFor(ready);
      await expect.poll(ready, { message: "ready" }).toBe(true);
      await expect(locator).toBeVisible();
      await expect(ready).toPass();
      expect(settings).toEqual({ timeout: 100 });
      await expect(locator).toHaveJSProperty("settings", { timeout: 100 });
      await locator.waitFor({ state: "visible" });
      test("shared defaults", ready);
      beforeEach(ready);
      helper.test("unrelated", ready, 100);
      // oxlint-disable-next-line nodex/no-explicit-test-timeout -- Exercise the timeout error.
      await vi.waitFor(neverReady, 100);
    `,
    count: 17,
  },
  {
    rule: "no-real-time-wait-in-tests",
    invalidFile: "tests/fixtures/invalid.mts",
    invalid: `
      import { setTimeout as tick } from "node:timers/promises";
      import * as timers from "timers/promises";
      await tick(10);
      await timers.setTimeout(10);
      await new Promise((resolve) => globalThis.setTimeout(resolve, 10));
      await new Promise(setTimeout);
      await page.waitForTimeout(10);
      await sleep(10);
      await delay(10);
      it.live("uses a real clock", () => Effect.sleep(10));
    `,
    valid: `
      const handle = setTimeout(onTimeout, 10);
      clearTimeout(handle);
      await vi.advanceTimersByTimeAsync(10);
      await done;
      it.effect("uses a test clock", () => Effect.sleep("10 millis"));
    `,
    count: 8,
    extraValid: {
      "src/production.ts": "await sleep(10);",
      "third_party/fixture.test.ts": "await sleep(10);",
      "packages/agent-runtime/vendor/fixture.test.ts": "await sleep(10);",
      "elsewhere/fixture.spec.tsx": "await sleep(10);",
    },
  },
  {
    rule: "no-polling-loop-in-tests",
    invalidFile: "src/renderer/test/invalid.ts",
    invalid: `
      while (!ready()) await sleep(10);
      for (let attempt = 0; attempt < 3; attempt++) {
        if (ready()) break;
        await page.waitForTimeout(10);
      }
      do {
        await new Promise((resolve) => setTimeout(resolve, 10));
      } while (!ready());
      while (!ready()) await Promise.resolve();
      function* poll() { while (!ready()) yield* Effect.sleep(10); }
      for (const interval of intervals) {
        if (ready()) break;
        await sleep(interval);
      }
    `,
    valid: `
      for (let i = 0; i < 3; i++) await Promise.resolve();
      while (!ready()) { await receiveEvent(); }
      while (!ready()) { queue.push(async () => { await delay(10); }); }
    `,
    count: 6,
  },
  {
    rule: "no-wall-clock-in-tests",
    invalid: `
      const started = performance.now();
      const elapsed = performance.now() - started;
      expect(elapsed).toBeLessThan(BUDGET);
      const began = Date.now();
      if (Date.now() - began > 1_000) throw Error("slow");
    `,
    valid: `
      const started = performance.now();
      console.info(performance.now() - started);
      expect(event.createdAt).toEqual(Date.now());
      expect(count).toBeLessThan(10);
      const fake = () => {
        const performance = { now: () => 1 };
        expect(performance.now() - performance.now()).toBeLessThan(1);
      };
    `,
    count: 2,
    extraValid: {
      "tests/e2e/open-performance.spec.ts": "expect(Date.now() - Date.now()).toBeLessThan(10);",
      "src/fixture.stress.browser.test.tsx": "expect(Date.now() - Date.now()).toBeLessThan(10);",
    },
  },
  {
    rule: "no-test-retries",
    invalid: `
      import { test as playwrightTest } from "@playwright/test";
      test("retries", { retry: 1 }, run);
      it.concurrent("trailing options", run, { retries: 2 });
      playwrightTest.describe.configure({ retries: 1 });
      vi.setConfig({ retry: 1 });
    `,
    valid: `
      test("no retries", run);
      test.describe.configure({ mode: "serial" });
      expect.poll(run).toBe(true);
      request({ retries: 2 });
    `,
    count: 4,
    extraValid: { "config/playwright.e2e.config.ts": "test.describe.configure({ retries: 1 });" },
  },
  {
    rule: "require-test-skip-reason",
    invalid: `
      test.skip("unexplained", run);
      // TODO
      it.todo("add coverage");
      describe.skip("suite", run);
      test.fixme();
      it.skip.each(cases)("case", run);
      it("options", { skip: true }, run);
    `,
    valid: `
      // Clipboard APIs are absent on the headless runner.
      test.skip("clipboard read", run);
      test.fixme(isWindows, "The native adapter needs a Windows fixture.");
      it.todo("cover resize"); // Needs a test driver that can resize native windows.
      it.skipIf(isWindows)("uses a POSIX signal", run);
    `,
    count: 6,
  },
];

test.each(cases)("$rule reports the intended test syntax", (ruleCase) => {
  const dir = mkdtempSync(join(tmpdir(), "nodex-lint-test-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ private: true, type: "module" }));
    const invalid = ruleCase.invalidFile ?? "invalid.test.ts";
    const valid = ruleCase.invalidFile?.replace("invalid", "valid") ?? "valid.test.ts";
    const id = `nodex/${ruleCase.rule}`;
    const files = { [invalid]: ruleCase.invalid, [valid]: ruleCase.valid, ...ruleCase.extraValid };
    for (const [filename, code] of Object.entries(files)) {
      const path = join(dir, filename);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, code);
    }
    writeFileSync(
      join(dir, "oxlint.json"),
      JSON.stringify({
        jsPlugins: [plugin],
        categories: { correctness: "off" },
        rules: { [id]: "warn" },
        options: { reportUnusedDisableDirectives: "warn" },
      }),
    );
    const { command, args } = vitePlusCommand([
      "lint",
      "-c",
      "oxlint.json",
      "--format",
      "json",
      ...Object.keys(files),
    ]);
    const result = spawnSync(command, args, { cwd: dir, encoding: "utf8" });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const output = result.stdout.slice(result.stdout.indexOf('{ "diagnostics"'));
    const { diagnostics } = JSON.parse(output) as {
      diagnostics: { code: string; filename: string }[];
    };
    expect(diagnostics.map(({ code, filename }) => [code, filename])).toEqual(
      Array.from({ length: ruleCase.count }, () => [`nodex(${ruleCase.rule})`, invalid]),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
