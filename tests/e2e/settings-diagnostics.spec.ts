import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { ElectronScenarioHarness } from "../../scripts/scenarios/harness/electron-e2e-harness";

interface EvidenceClaim {
  name: string;
  expected: unknown;
  actual: unknown;
}

const readFramePaint = async (section: Locator) =>
  section.evaluate((element) => {
    const widths = (style: CSSStyleDeclaration) =>
      [
        style.borderTopWidth,
        style.borderRightWidth,
        style.borderBottomWidth,
        style.borderLeftWidth,
      ].map((width) => Number.parseFloat(width));
    const frames = (root: Element) =>
      Array.from(root.querySelectorAll<HTMLElement>("*"))
        .filter((node) => node.getBoundingClientRect().height > 0)
        .filter((node) => widths(getComputedStyle(node)).every((width) => width > 0));
    const general = document.getElementById("general");
    const trigger = element.querySelector("button[aria-expanded]");
    const content = trigger?.parentElement;
    if (!general || !content) throw new Error("Missing General diagnostics surface");
    const referenceFrame = frames(general)[0];
    const paintedFrames = frames(element);
    const frame = paintedFrames[0];
    if (!referenceFrame || !frame) throw new Error("Missing Settings frame paint");
    const frameBounds = frame.getBoundingClientRect();
    const contentBounds = content.getBoundingClientRect();
    const frameStyle = getComputedStyle(frame);
    return {
      settingsBorder: getComputedStyle(referenceFrame).borderTopColor,
      paint: {
        framedSurfaces: paintedFrames.length,
        frameBorderWidths: widths(frameStyle),
        frameBorderColor: frameStyle.borderTopColor,
        contentBorderWidths: widths(getComputedStyle(content)),
        contentBackground: getComputedStyle(content).backgroundColor,
        contentInsideFrame:
          contentBounds.left >= frameBounds.left &&
          contentBounds.right <= frameBounds.right &&
          contentBounds.top >= frameBounds.top &&
          contentBounds.bottom <= frameBounds.bottom,
      },
    };
  });

const readOverflow = async (section: Locator) =>
  section.evaluate((element) => {
    const surface = element.closest("main");
    if (!surface) throw new Error("Missing General Settings surface");
    const scroller = Array.from(surface.children).find(
      (child) => getComputedStyle(child).overflowY === "auto",
    );
    if (!scroller) throw new Error("Missing General Settings scroller");
    return {
      diagnostics: Math.max(0, element.scrollWidth - element.clientWidth),
      settings: Math.max(0, scroller.scrollWidth - scroller.clientWidth),
      document: Math.max(
        0,
        document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    };
  });

const holdReviewFrame = async (page: Page) => {
  await page.mouse.move(1240, 760);
  // Assertions own settling; keep each verified state readable in the native recording.
  await page.waitForTimeout(750);
};

test("renders and toggles App server diagnostics in General settings", async ({}, testInfo) => {
  test.setTimeout(120_000);
  const artifacts =
    process.env.NODEX_SETTINGS_DIAGNOSTICS_ARTIFACT_DIR ??
    testInfo.outputPath("settings-diagnostics-review");
  await mkdir(artifacts, { recursive: true });
  const claims: EvidenceClaim[] = [];
  const claim = (name: string, expected: unknown, actual: unknown) => {
    claims.push({ name, expected, actual });
    expect(actual, name).toEqual(expected);
  };
  const harness = await ElectronScenarioHarness.create({ label: "settings-diagnostics" });
  const rendererErrors: string[] = [];
  let page: Page | undefined;
  let recording: Page | undefined;
  let status: "passed" | "failed" = "failed";
  let failure: string | null = null;
  try {
    page = await harness.launch();
    page.on("pageerror", (error) => rendererErrors.push(error.message));
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("link", { name: "Appearance", exact: true }).click();
    const darkMode = page.getByRole("radio", { name: "Dark", exact: true });
    await darkMode.locator("..").click();
    await expect(darkMode).toBeChecked();
    await expect(page.locator("html")).toHaveClass(/dark/);
    claim(
      "Appearance Mode is explicitly Dark",
      { checked: true, resolvedDark: true },
      {
        checked: await darkMode.isChecked(),
        resolvedDark: await page
          .locator("html")
          .evaluate((element) => element.classList.contains("dark")),
      },
    );
    await page.getByRole("link", { name: "General", exact: true }).click();
    const section = page.locator("#app-server-diagnostics");
    const trigger = section.getByRole("button", { name: "App server requests", exact: true });
    const empty = section.getByText("No requests recorded yet", { exact: true });
    const count = section.getByText("0 requests", { exact: true });
    await expect(trigger).toBeVisible();
    await section.scrollIntoViewIfNeeded();
    await page.screencast.start({
      path: path.join(artifacts, "review.webm"),
      size: { width: 1280, height: 800 },
      annotate: { position: "bottom", fontSize: 14 },
    });
    recording = page;
    claim(
      "Diagnostics starts collapsed without a request count",
      { expanded: "false", countVisible: false },
      {
        expanded: await trigger.getAttribute("aria-expanded"),
        countVisible: await count.isVisible(),
      },
    );
    const collapsedPaint = await readFramePaint(section);
    claim(
      "Collapsed diagnostics uses one complete muted Settings frame",
      {
        framedSurfaces: 1,
        frameBorderWidths: [1, 1, 1, 1],
        frameBorderColor: collapsedPaint.settingsBorder,
        contentBorderWidths: [0, 0, 0, 0],
        contentBackground: "rgba(0, 0, 0, 0)",
        contentInsideFrame: true,
      },
      collapsedPaint.paint,
    );
    await page.screenshot({ path: path.join(artifacts, "collapsed.png") });
    await holdReviewFrame(page);

    await trigger.focus();
    await trigger.press("Space");
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    await expect(empty).toBeVisible();
    claim(
      "Space opens diagnostics and retains keyboard focus",
      { expanded: "true", focused: true },
      await trigger.evaluate((element) => ({
        expanded: element.getAttribute("aria-expanded"),
        focused: element === document.activeElement,
      })),
    );
    claim(
      "Fresh diagnostics has no captured requests",
      { count: "0 requests", emptyVisible: true },
      {
        count: await count.innerText(),
        emptyVisible: await empty.isVisible(),
      },
    );
    await page.screenshot({ path: path.join(artifacts, "expanded.png") });
    await holdReviewFrame(page);

    await page.setViewportSize({ width: 760, height: 800 });
    await expect(empty).toBeVisible();
    claim(
      "Expanded diagnostics fits narrow Settings without horizontal overflow",
      { diagnostics: 0, settings: 0, document: 0 },
      await readOverflow(section),
    );
    await page.screenshot({ path: path.join(artifacts, "narrow.png") });
    await holdReviewFrame(page);

    await trigger.press("Enter");
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await expect(empty).not.toBeVisible();
    claim(
      "Enter closes diagnostics and retains keyboard focus",
      { expanded: "false", focused: true },
      await trigger.evaluate((element) => ({
        expanded: element.getAttribute("aria-expanded"),
        focused: element === document.activeElement,
      })),
    );
    claim(
      "Diagnostics interaction shows no error toasts",
      0,
      await page.getByRole("alert").count(),
    );
    claim("Diagnostics interaction raises no renderer errors", [], rendererErrors);
    await page.setViewportSize({ width: 1280, height: 800 });
    await trigger.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(artifacts, "final.png") });
    await holdReviewFrame(page);
    status = "passed";
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    await page?.screenshot({ path: path.join(artifacts, "failure.png") }).catch(() => undefined);
    throw error;
  } finally {
    await recording?.screencast.stop().catch(() => undefined);
    await writeFile(
      path.join(artifacts, "result.json"),
      `${JSON.stringify({ status, fixture: "settings-diagnostics: fresh Electron Profile, Dark Mode, real General Settings", claims, failure }, null, 2)}\n`,
    );
    await writeFile(
      path.join(artifacts, "README.md"),
      `# App server diagnostics verification\n\nStatus: **${status}**\n\nA fresh disposable Electron Profile selects Dark Mode in Settings → Appearance, then opens General through the actual navigation. The native recording shows the collapsed frame, keyboard opening, the empty request state, narrow Settings, and keyboard closing. No user Profile or private recorder fixtures are used. Exact expected and actual values are in result.json.\n\nScreenshots: collapsed.png, expanded.png, narrow.png, final.png.\n${failure ? `\nFailure: ${failure}\n` : ""}`,
    );
    await harness.close();
  }
});
