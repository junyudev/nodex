import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { ElectronScenarioHarness } from "../../scripts/scenarios/harness/electron-e2e-harness";
import { prepareScenarioCodexAppServerRuntimeSync } from "../../scripts/scenarios/runtime/agent-runtime-fixture";
import { invokeIpc } from "./support/editor-scenario";

interface Generation {
  readonly requestId: string;
  readonly pid: number;
  readonly bodies: readonly string[];
  readonly effort: string | null;
}

/** Longer than Main's wait for a burst to settle, so nothing more is coming. */
const QUIET_MS = 3_000;
const SPINNER = "Finding where this goes";
const STOP = "Stop suggesting";

const isRunning = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const shot = async (page: Page, target: Locator, file: string) => {
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  if (!box) throw new Error(`${file} is not on screen`);
  await page.screenshot({ path: file, clip: box });
};

test("Inbox advice runs in parallel, says why it failed, and stops when asked", async ({}, testInfo) => {
  test.setTimeout(300_000);
  const artifacts =
    process.env.NODEX_INBOX_PARALLEL_SUGGESTIONS_ARTIFACT_DIR ??
    testInfo.outputPath("inbox-parallel-suggestions");
  await mkdir(artifacts, { recursive: true });
  const claims: { name: string; expected: unknown; actual: unknown }[] = [];
  const claim = (name: string, expected: unknown, actual: unknown) => {
    claims.push({ name, expected, actual });
    expect(actual, name).toEqual(expected);
  };

  const harness = await ElectronScenarioHarness.create({
    label: "inbox-parallel-suggestions",
    prepareAgentRuntime: false,
    environment: {
      NODEX_FAKE_CODEX_STATE_PATH: ".fake-codex/state.json",
      NODEX_FAKE_CODEX_LOG_PATH: ".fake-codex/requests.jsonl",
      NODEX_FAKE_CODEX_EXEC_DIR: ".fake-codex/exec",
      NODEX_FAKE_CODEX_REASONING_EFFORTS: "low,medium,high",
      NODEX_FAKE_CODEX_APP_SERVER_PATH: path.resolve(
        "tests/e2e/fixtures/codex-queue-app-server.mjs",
      ),
      NODEX_TEST_AGENT_RUNTIME_PROJECT_ROOT: ".",
    },
  });
  prepareScenarioCodexAppServerRuntimeSync(
    harness.profile.runRoot,
    path.resolve("tests/e2e/fixtures/codex-exec-app-server.mjs"),
  );
  const execDirectory = path.join(harness.profile.runRoot, ".fake-codex/exec");
  const generations = (): Generation[] => {
    const log = path.join(execDirectory, "generations.jsonl");
    return existsSync(log)
      ? readFileSync(log, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Generation)
      : [];
  };
  const generationsOf = (text: string) =>
    generations().filter((generation) => generation.bodies.includes(text));
  /** Waits for the message's nth generation, so a test never reads an earlier one by accident. */
  const generationOf = async (text: string, nth = 1) => {
    await expect
      .poll(() => generationsOf(text).length, { timeout: 45_000, message: text })
      .toBeGreaterThanOrEqual(nth);
    return generationsOf(text)[nth - 1]!;
  };
  const conclude = (generation: Generation, how: "answer" | "fail") =>
    writeFileSync(path.join(execDirectory, `${generation.requestId}.${how}`), "");

  let status: "passed" | "failed" = "failed";
  let failure: string | null = null;
  try {
    const page = await harness.launch();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByTestId("sidebar-inbox-row-wrapper").getByRole("button").click();
    const inbox = page.locator('[data-inbox-scope="library"]');
    await expect(inbox).toBeVisible();
    const stream = inbox.getByTestId("inbox-stream");
    const composer = page.getByRole("textbox", { name: "Message your Inbox" });
    const row = (text: string) => inbox.getByTestId("inbox-message").filter({ hasText: text });
    const spinnerOf = (text: string) => row(text).getByRole("status", { name: SPINNER });
    const send = async (text: string) => {
      await composer.fill(text);
      await composer.press("Enter");
      await expect(row(text)).toBeVisible();
    };
    const stop = async (text: string) => {
      await row(text).getByRole("button", { name: STOP }).click();
      await expect(spinnerOf(text)).toHaveCount(0);
    };

    await page.screencast.start({
      path: path.join(artifacts, "review.webm"),
      size: { width: 1280, height: 900 },
    });
    await page.screencast.showActions({ position: "bottom", style: { title: "font-size: 14px" } });
    try {
      // Each waits for the last to start, so these are requests of their own rather than one burst.
      const running = [
        "First: slow lookup",
        "Second: quick note",
        "Third: a task",
        "Fourth: a comparison",
        "Fifth: a reminder",
      ];
      const runs: Generation[] = [];
      for (const text of running) {
        await send(text);
        runs.push(await generationOf(text));
      }
      const [first, second, third, fourth, fifth] = running as [
        string,
        string,
        string,
        string,
        string,
      ];
      const [firstRun, secondRun, thirdRun, fourthRun, fifthRun] = runs as [
        Generation,
        Generation,
        Generation,
        Generation,
        Generation,
      ];
      claim(
        "Five generations run at the same moment by default, each in its own process",
        { running: [true, true, true, true, true], processes: 5 },
        {
          running: runs.map(({ pid }) => isRunning(pid)),
          processes: new Set(runs.map(({ pid }) => pid)).size,
        },
      );
      claim("An unchosen suggestion effort is high on Codex", "high", firstRun.effort);

      const [sixth, seventh] = ["Sixth: waits for a place", "Seventh: waits beside it"] as const;
      await send(sixth);
      await send(seventh);
      await page.waitForTimeout(QUIET_MS);
      claim("A sixth generation waits while five run", 5, generations().length);
      claim(
        "Every message waiting for advice shows its own spinner",
        [1, 1, 1, 1, 1, 1, 1],
        await Promise.all([...running, sixth, seventh].map((text) => spinnerOf(text).count())),
      );
      await shot(page, stream, path.join(artifacts, "1-all-waiting.png"));

      const stopFirst = row(first).getByRole("button", { name: STOP });
      await stopFirst.hover();
      await expect(page.getByRole("tooltip", { name: STOP })).toBeVisible();
      await page.screenshot({ path: path.join(artifacts, "2-hover-stop.png") });
      await stopFirst.click();
      await expect(spinnerOf(first)).toHaveCount(0);
      await expect.poll(() => isRunning(firstRun.pid)).toBe(false);
      await expect(row(first).getByRole("button", { name: "Suggest", exact: true })).toBeVisible();
      await page.mouse.move(640, 40);
      await shot(page, row(first), path.join(artifacts, "3-after-stop.png"));

      const gathered = await generationOf(sixth);
      claim(
        "The freed place gathers the messages waiting for it into one request, unasked",
        [sixth, seventh],
        gathered.bodies,
      );

      await stop(seventh);
      await expect.poll(() => isRunning(gathered.pid)).toBe(false);
      const sixthAlone = await generationOf(sixth, 2);
      claim(
        "Stopping one gathered message stops only it; the other is advised without it",
        [sixth],
        sixthAlone.bodies,
      );

      const queued = "Eighth: stopped before it starts";
      await send(queued);
      await page.waitForTimeout(QUIET_MS);
      await stop(queued);
      await expect(row(queued).getByRole("button", { name: "Suggest", exact: true })).toBeVisible();

      conclude(secondRun, "fail");
      await expect(row(second).getByText(/Couldn’t suggest/)).toBeVisible();
      await expect(row(second).getByRole("button", { name: "Retry" })).toBeVisible();
      const others = [
        [third, thirdRun],
        [fourth, fourthRun],
        [fifth, fifthRun],
        [sixth, sixthAlone],
      ] as const;
      claim(
        "One failure says why and leaves the others running",
        { spinners: [1, 1, 1, 1], running: [true, true, true, true] },
        {
          spinners: await Promise.all(others.map(([text]) => spinnerOf(text).count())),
          running: others.map(([, run]) => isRunning(run.pid)),
        },
      );
      await shot(page, stream, path.join(artifacts, "4-failed.png"));

      for (const [text, run] of others) {
        conclude(run, "answer");
        await expect(spinnerOf(text)).toHaveCount(0);
      }
      await row(second).getByRole("button", { name: "Retry" }).click();
      conclude(await generationOf(second, 2), "answer");
      await expect(row(second).getByText(/Couldn’t suggest/)).toHaveCount(0);
      await expect(spinnerOf(second)).toHaveCount(0);

      await page.waitForTimeout(QUIET_MS);
      claim(
        "A stopped message is not asked again on its own",
        { first: 1, seventh: 1, queued: 0 },
        {
          first: generationsOf(first).length,
          seventh: generationsOf(seventh).length,
          queued: generationsOf(queued).length,
        },
      );

      await invokeIpc(page, "settings:inbox:update", {
        suggestionAgent: {
          instanceId: "codex",
          model: null,
          reasoningEffort: "low",
          serviceTier: null,
        },
      });
      const atEffort = "Ninth: runs at the chosen effort";
      await send(atEffort);
      const atEffortRun = await generationOf(atEffort);
      claim("The chosen suggestion effort reaches the Agent", "low", atEffortRun.effort);
      conclude(atEffortRun, "answer");
      await expect(spinnerOf(atEffort)).toHaveCount(0);

      await page.getByRole("button", { name: "Inbox settings" }).click();
      await page.getByRole("button", { name: "Suggestion model" }).click();
      claim(
        "The suggestion model menu offers its effort",
        "Light",
        await page.getByRole("slider", { name: "Effort" }).getAttribute("aria-valuetext"),
      );
      await page.screenshot({ path: path.join(artifacts, "5-effort-menu.png") });
      const moreSettings = page.getByRole("button", { name: "Routing preferences and more" });
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
      await expect(moreSettings).toHaveCount(0);

      // With the limit at one, a second message waits; raising it in Settings is all it takes.
      await invokeIpc(page, "settings:inbox:update", { suggestionConcurrency: 1 });
      const alone = "Tenth: runs alone";
      const beside = "Eleventh: waits for a higher limit";
      await send(alone);
      const aloneRun = await generationOf(alone);
      await send(beside);
      await page.waitForTimeout(QUIET_MS);
      claim("A lowered limit holds the next message back", 0, generationsOf(beside).length);

      await page.getByRole("button", { name: "Inbox settings" }).click();
      await moreSettings.click();
      const limit = page.getByRole("spinbutton", { name: "Suggestions at once" });
      await expect(limit).toHaveValue("1");
      await limit.fill("2");
      await limit.press("Enter");
      await expect(limit).toHaveValue("2");
      await shot(
        page,
        page.getByText("Suggestions at once", { exact: true }).locator("xpath=ancestor::*[3]"),
        path.join(artifacts, "6-settings-limit.png"),
      );
      // Sooner than the safety poll, and nothing else happens in the Inbox meanwhile.
      await expect.poll(() => generationsOf(beside).length).toBe(1);
      claim(
        "Raising the limit in Settings starts the waiting message at once, beside the first",
        true,
        isRunning(aloneRun.pid),
      );
      status = "passed";
    } finally {
      await page.screencast.stop();
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    await writeFile(
      path.join(artifacts, "verification.json"),
      `${JSON.stringify({ status, failure, claims }, null, 2)}\n`,
    );
    await harness.close();
  }
});
