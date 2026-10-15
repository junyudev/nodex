import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { JSHandle, Page } from "@playwright/test";
import type { BrowserWindow } from "electron";

// Playwright runs E2E support as CommonJS from the repository root, like the scenario harness.
const repositoryRoot = process.cwd();
const probeSource = path.join(repositoryRoot, "tests/e2e/support/native-pointer");
const probeFiles = ["binding.gyp", "src/nodex_native_pointer.mm"] as const;

/**
 * Builds the test-only AppKit click probe for the pinned Electron ABI. The build
 * is cached by source digest under `.generated/`, like other native artifacts.
 */
export function buildNativePointerProbe(): string {
  if (process.platform !== "darwin") throw new Error("The native pointer probe requires macOS");
  const electronVersion = (
    JSON.parse(readFileSync(path.join(repositoryRoot, "package.json"), "utf8")) as {
      devDependencies: { electron: string };
    }
  ).devDependencies.electron;
  const digest = createHash("sha256");
  digest.update(electronVersion);
  for (const file of probeFiles) digest.update(readFileSync(path.join(probeSource, file)));
  const stamp = digest.digest("hex");
  const buildRoot = path.join(repositoryRoot, ".generated", "e2e-native-pointer", process.arch);
  const binary = path.join(buildRoot, "build", "Release", "nodex_native_pointer.node");
  const stampFile = path.join(buildRoot, "source.sha256");
  if (existsSync(binary) && existsSync(stampFile) && readFileSync(stampFile, "utf8") === stamp) {
    return binary;
  }
  mkdirSync(path.join(buildRoot, "src"), { recursive: true });
  for (const file of probeFiles)
    copyFileSync(path.join(probeSource, file), path.join(buildRoot, file));
  execFileSync(
    process.execPath,
    [
      createRequire(path.join(repositoryRoot, "package.json")).resolve("node-gyp/bin/node-gyp.js"),
      "rebuild",
      "--directory",
      buildRoot,
      `--target=${electronVersion}`,
      `--arch=${process.arch}`,
      "--dist-url=https://electronjs.org/headers",
    ],
    { cwd: repositoryRoot, env: { ...process.env, MACOSX_DEPLOYMENT_TARGET: "15.0" } },
  );
  writeFileSync(stampFile, stamp);
  return binary;
}

export interface NativeClickOutcome {
  /** The renderer received the press, so no native drag region or window control took it. */
  readonly reachedRenderer: boolean;
  readonly target: string | null;
}

/**
 * Clicks a window point through AppKit's event dispatch and reports whether the
 * press reached the web contents. Callers must never aim at the native window
 * buttons; this probe is for proving renderer controls and drag regions.
 */
export async function clickThroughNativeWindow(
  window: JSHandle<BrowserWindow>,
  page: Page,
  probePath: string,
  point: { readonly x: number; readonly y: number },
): Promise<NativeClickOutcome> {
  await page.evaluate(() => {
    const state = window as typeof window & { __nativePointerPresses?: string[] };
    state.__nativePointerPresses = [];
    document.addEventListener(
      "pointerdown",
      (event) => {
        const target = event.target instanceof Element ? event.target : null;
        const labelled = target?.closest("[aria-label]");
        state.__nativePointerPresses?.push(
          labelled?.getAttribute("aria-label") ?? target?.tagName.toLowerCase() ?? "unknown",
        );
      },
      { capture: true, once: true },
    );
  });
  await window.evaluate(
    (browserWindow, input) => {
      const module = { exports: {} as { click(handle: Buffer, x: number, y: number): void } };
      process.dlopen(module, input.probePath);
      module.exports.click(browserWindow.getNativeWindowHandle(), input.x, input.y);
    },
    { probePath, x: point.x, y: point.y },
  );
  await page.waitForTimeout(250);
  const presses = await page.evaluate(
    () => (window as typeof window & { __nativePointerPresses?: string[] }).__nativePointerPresses,
  );
  return { reachedRenderer: (presses?.length ?? 0) > 0, target: presses?.[0] ?? null };
}

export interface NativeDragRegionReport {
  /** Visible, topmost controls whose center falls in the window's draggable region. */
  readonly blockedControls: readonly string[];
  readonly draggableAt: readonly boolean[];
}

/**
 * Folds the page's `app-region` boxes the way Chromium collects them and
 * Electron applies them: layout-tree order, border boxes of visible boxes only,
 * `drag` adds and `no-drag` subtracts. Inline boxes contribute nothing.
 */
export async function readNativeDragRegions(
  page: Page,
  samples: readonly { readonly x: number; readonly y: number }[] = [],
): Promise<NativeDragRegionReport> {
  return page.evaluate((points) => {
    const regions: { drag: boolean; left: number; top: number; right: number; bottom: number }[] =
      [];
    const replaced = new Set([
      "IMG",
      "VIDEO",
      "CANVAS",
      "IFRAME",
      "WEBVIEW",
      "INPUT",
      "TEXTAREA",
      "SELECT",
      "BUTTON",
    ]);
    const visit = (element: Element) => {
      const style = getComputedStyle(element);
      if (style.display === "none") return;
      const mode = style.getPropertyValue("-webkit-app-region");
      const isBox =
        style.display !== "contents" &&
        (style.display !== "inline" ||
          element instanceof SVGSVGElement ||
          replaced.has(element.tagName)) &&
        !(element instanceof SVGElement && !(element instanceof SVGSVGElement));
      if (style.visibility === "visible" && isBox && (mode === "drag" || mode === "no-drag")) {
        const bounds = element.getBoundingClientRect();
        if (bounds.width > 0 && bounds.height > 0) {
          regions.push({
            drag: mode === "drag",
            left: bounds.left,
            top: bounds.top,
            right: bounds.right,
            bottom: bounds.bottom,
          });
        }
      }
      for (const child of element.children) visit(child);
    };
    visit(document.documentElement);
    const draggable = (x: number, y: number) => {
      let inside = false;
      for (const region of regions) {
        if (x >= region.left && x < region.right && y >= region.top && y < region.bottom) {
          inside = region.drag;
        }
      }
      return inside;
    };
    const blockedControls: string[] = [];
    const controls = document.querySelectorAll(
      'button, a[href], input, textarea, select, [role="tab"], [role="button"], [role="menuitem"]',
    );
    for (const control of controls) {
      if (!control.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
      const bounds = control.getBoundingClientRect();
      if (bounds.width < 2 || bounds.height < 2) continue;
      const x = bounds.left + bounds.width / 2;
      const y = bounds.top + bounds.height / 2;
      const hit = document.elementFromPoint(x, y);
      if (!hit || !(hit === control || control.contains(hit))) continue;
      if (draggable(x, y)) {
        blockedControls.push(
          control.getAttribute("aria-label") ?? control.textContent?.trim() ?? "",
        );
      }
    }
    return { blockedControls, draggableAt: points.map((point) => draggable(point.x, point.y)) };
  }, samples);
}
