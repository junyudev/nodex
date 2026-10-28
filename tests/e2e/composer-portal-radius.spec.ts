import { expect, test, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { ElectronScenarioHarness } from "../../scripts/scenarios/harness/electron-e2e-harness";
import { prepareScenarioCodexAppServerRuntimeSync } from "../../scripts/scenarios/runtime/agent-runtime-fixture";
import { openNewChatDraft } from "./support/new-chat-draft";

/** Trace the real composited stroke in a contrasting color, then restore the theme. */
async function readRailBorderContinuity(page: Page, artifactPath?: string) {
  const rail = page.locator("[data-composer-auxiliary-rail]");
  const originalStyle = await rail.getAttribute("style");
  try {
    await rail.evaluate((element) => {
      (element as HTMLElement).style.borderColor = "rgb(224, 0, 0)";
    });
    const box = await rail.boundingBox();
    if (!box) throw new Error("The Composer rail is not visible");
    const radius = await rail.evaluate((element) =>
      Number.parseFloat(getComputedStyle(element).borderTopLeftRadius),
    );
    const pixels = await page.screenshot({
      path: artifactPath,
      scale: "css",
      clip: {
        x: Math.floor(box.x) - 1,
        y: Math.floor(box.y) - 1,
        width: Math.ceil(box.x + box.width) - Math.floor(box.x) + 2,
        height: Math.ceil(radius) + 4,
      },
    });
    return await page.evaluate(
      async ({ base64, radius }) => {
        const image = new Image();
        image.src = `data:image/png;base64,${base64}`;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Cannot decode the Composer border screenshot");
        context.drawImage(image, 0, 0);
        const { data, width, height } = context.getImageData(0, 0, image.width, image.height);
        const cornerSize = Math.ceil(radius) + 4;
        const continuous = (right: boolean) => {
          const isStroke = (x: number, y: number) => {
            if (x < 0 || y < 0 || x >= cornerSize || y >= height) return false;
            const imageX = right ? width - 1 - x : x;
            const index = (y * width + imageX) * 4;
            return data[index]! - data[index + 1]! > 24 && data[index]! - data[index + 2]! > 24;
          };
          const pending: Array<[number, number]> = [];
          const visited = new Set<string>();
          for (let x = Math.ceil(radius); x < cornerSize; x++) {
            for (let y = 0; y <= 3; y++) {
              if (isStroke(x, y)) pending.push([x, y]);
            }
          }
          while (pending.length > 0) {
            const [x, y] = pending.pop()!;
            const key = `${x},${y}`;
            if (visited.has(key) || !isStroke(x, y)) continue;
            visited.add(key);
            if (x <= 3 && y >= radius) return true;
            for (const dx of [-1, 0, 1]) {
              for (const dy of [-1, 0, 1]) pending.push([x + dx, y + dy]);
            }
          }
          return false;
        };
        return { left: continuous(false), right: continuous(true) };
      },
      { base64: pixels.toString("base64"), radius },
    );
  } finally {
    await rail.evaluate((element, style) => {
      if (style === null) element.removeAttribute("style");
      else element.setAttribute("style", style);
    }, originalStyle);
  }
}

test("keeps the attached Composer rail rounded independently of the progress pill", async () => {
  test.setTimeout(120_000);
  const harness = await ElectronScenarioHarness.create({
    label: "composer-portal-radius",
    prepareAgentRuntime: false,
    environment: {
      NODEX_FAKE_CODEX_STATE_PATH: ".fake-codex/state.json",
      NODEX_FAKE_CODEX_LOG_PATH: ".fake-codex/requests.jsonl",
      NODEX_TEST_AGENT_RUNTIME_PROJECT_ROOT: ".",
      NODEX_FAKE_CODEX_COMPOSER_PLAN: "1",
    },
  });
  prepareScenarioCodexAppServerRuntimeSync(
    harness.profile.runRoot,
    path.resolve("tests/e2e/fixtures/codex-queue-app-server.mjs"),
  );
  const artifacts = process.env.NODEX_COMPOSER_PORTAL_ARTIFACT_DIR;
  if (artifacts) await mkdir(artifacts, { recursive: true });
  const claims: Array<{ name: string; expected: unknown; actual: unknown }> = [];
  const claim = (name: string, expected: unknown, actual: unknown) => {
    claims.push({ name, expected, actual });
    expect(actual, name).toEqual(expected);
  };
  let page: Page | undefined;
  let recording = false;
  let status = "failed";
  let failure: string | undefined;
  try {
    page = await harness.launch();
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.emulateMedia({ colorScheme: "light" });
    const draft = (await openNewChatDraft(page)).locator('[data-codex-composer="true"]');
    await draft.fill("Keep the turn open while reviewing the Composer");
    await page.getByRole("button", { name: "Send prompt" }).click();
    const stop = page.getByRole("button", { name: "Stop", exact: true });
    await expect(stop).toBeVisible({ timeout: 30_000 });
    const pill = page.locator('[data-above-composer-fixed-pill="true"]');
    await expect(pill).toBeVisible();
    const composer = page.locator(
      '[data-codex-composer="true"][aria-label="Ask for follow-up changes"]',
    );
    await composer.fill("Run the final checks");
    await composer.press("Meta+Enter");
    const row = page
      .locator("[data-queued-follow-up-row]")
      .filter({ hasText: "Run the final checks" });
    await expect(row).toBeVisible();
    // First-launch guidance is unrelated to the surface under review.
    const notice = page.getByRole("alert").filter({ hasText: "Global dictation is ready." });
    await notice.waitFor({ state: "visible", timeout: 8_000 }).catch(() => undefined);
    if (await notice.isVisible()) {
      await notice.getByRole("button", { name: "Dismiss notification" }).click();
      await expect(notice).toHaveCount(0);
    }
    claim(
      "The light-theme border connects the horizontal and vertical strokes through both corners",
      { left: true, right: true },
      await readRailBorderContinuity(
        page,
        artifacts ? path.join(artifacts, "border-light.png") : undefined,
      ),
    );
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    claim(
      "The dark-theme border remains connected through both corners",
      { left: true, right: true },
      await readRailBorderContinuity(
        page,
        artifacts ? path.join(artifacts, "border-dark.png") : undefined,
      ),
    );
    await page.emulateMedia({ colorScheme: "light" });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    if (artifacts) {
      await page.screenshot({ path: path.join(artifacts, "with-progress.png") });
      await page.screencast.start({
        path: path.join(artifacts, "review.webm"),
        size: { width: 1280, height: 800 },
      });
      recording = true;
      await page.screencast.showActions({ position: "top", style: { title: "font-size: 14px" } });
    }
    const verifyRail = async (state: string) => {
      const rail = page!.locator("#above-composer-queue-portal > div");
      await expect(rail).toBeVisible();
      const geometry = await rail.evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          topLeft: style.borderTopLeftRadius,
          topRight: style.borderTopRightRadius,
          bottomLeft: style.borderBottomLeftRadius,
          overflow: style.overflow,
          border: style.borderTopWidth,
          fits: element.scrollWidth <= element.clientWidth,
        };
      });
      claim(
        state,
        {
          topLeft: "20px",
          topRight: "20px",
          bottomLeft: "0px",
          overflow: "clip",
          border: "1px",
          fits: true,
        },
        geometry,
      );
      if (recording) {
        await page!.screencast.showOverlay(
          `<div style="position:fixed;top:64px;left:24px;max-width:440px;padding:10px 14px;border-radius:10px;background:#182026;color:white;font:14px system-ui">PASS · ${state}<br>20px top corners · clipped content · no horizontal overflow</div>`,
          { duration: 1200 },
        );
        await page!.waitForTimeout(1400);
      }
    };
    await verifyRail("Light theme with progress and a queued follow-up");
    await row.hover();
    await expect(row.getByRole("button", { name: "Delete queued message" })).toBeVisible();
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await verifyRail("Dark theme with progress");
    if (artifacts) await page.screenshot({ path: path.join(artifacts, "dark.png") });
    await page.setViewportSize({ width: 820, height: 800 });
    await verifyRail("Narrow Composer with progress");
    if (artifacts) await page.screenshot({ path: path.join(artifacts, "narrow.png") });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.emulateMedia({ colorScheme: "light" });
    await stop.click();
    await expect(pill).toHaveCount(0);
    await expect(row).toBeVisible();
    await verifyRail("Interrupted turn without the progress pill");
    if (artifacts) {
      await page.waitForTimeout(600);
      await page.screenshot({ path: path.join(artifacts, "final.png") });
    }
    status = "passed";
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    if (recording && page && !page.isClosed()) await page.screencast.stop();
    if (artifacts) {
      await writeFile(
        path.join(artifacts, "result.json"),
        JSON.stringify(
          { status, fixture: "codex-queue-app-server:composer-plan", claims, failure },
          null,
          2,
        ),
      );
      await writeFile(
        path.join(artifacts, "README.md"),
        `# Composer portal review\n\nStatus: **${status}**. A fresh disposable Electron Profile streams a plan through the Agent Runtime and queues a follow-up through the real Composer. The recording verifies the rail's computed top radii, border, clipping and width in light, dark and narrow layouts, then interrupts the turn and checks that removing the separate progress pill preserves the rounded rail.\n\n- [review.webm](review.webm)\n- [with-progress.png](with-progress.png)\n- [dark.png](dark.png)\n- [narrow.png](narrow.png)\n- [final.png](final.png)\n- [result.json](result.json)\n\nSynthetic content only.\n${failure ? `\nFailure: ${failure}\n` : ""}`,
      );
    }
    await harness.close();
  }
});
