import { hostCapabilities } from "./platform/host-capabilities";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { desktopCapturer, screen, type DesktopCapturerSource, type Rectangle } from "electron";

const MAX_HELPER_OUTPUT_BYTES = 128 * 1024;
const MAX_CAPTURE_DIMENSION = 4_096;

export interface HelperWindowBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface ComposerAppshotHelperTarget {
  readonly name: string;
  readonly bundleIdentifier: string;
  readonly processIdentifier: number;
  readonly windowId: number;
  readonly windowTitle: string | null;
  readonly bounds: HelperWindowBounds;
  readonly axTree: string;
}

/** The true native seam used by the Appshot Module in production and tests. */
export interface ComposerAppshotPlatform {
  readonly platform: NodeJS.Platform;
  readonly processIdentifier: number;
  readonly helperAvailable: () => boolean;
  readonly readFrontmostWindow: (
    signal: AbortSignal,
  ) => Promise<ComposerAppshotHelperTarget | null>;
  readonly listWindowSources: (thumbnailSize: {
    readonly width: number;
    readonly height: number;
  }) => Promise<readonly DesktopCapturerSource[]>;
  readonly displayScaleFactor: (bounds: HelperWindowBounds) => number;
  readonly createId: () => string;
}

export interface ComposerAppshotLiveConfig {
  readonly configuredHelperPath: string | null;
  readonly isPackaged: boolean;
  readonly platform: string;
  readonly projectRootPath: string;
  readonly resourcesPath: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized ? normalized : null;
}

export function parseComposerAppshotHelperTarget(
  value: unknown,
): ComposerAppshotHelperTarget | null {
  if (!isRecord(value)) return null;
  const name = nonEmptyString(value.name);
  const bundleIdentifier = nonEmptyString(value.bundleIdentifier);
  const processIdentifier = finiteNumber(value.processIdentifier);
  const windowId = finiteNumber(value.windowId);
  const windowTitle = value.windowTitle === null ? null : nonEmptyString(value.windowTitle);
  const axTree = typeof value.axTree === "string" ? value.axTree : null;
  if (
    !name ||
    !bundleIdentifier ||
    processIdentifier === null ||
    !Number.isSafeInteger(processIdentifier) ||
    processIdentifier <= 0 ||
    windowId === null ||
    !Number.isSafeInteger(windowId) ||
    windowId <= 0 ||
    axTree === null ||
    !isRecord(value.bounds)
  ) {
    return null;
  }
  const x = finiteNumber(value.bounds.x);
  const y = finiteNumber(value.bounds.y);
  const width = finiteNumber(value.bounds.width);
  const height = finiteNumber(value.bounds.height);
  if (x === null || y === null || width === null || height === null || width < 40 || height < 40) {
    return null;
  }
  return {
    name,
    bundleIdentifier,
    processIdentifier,
    windowId,
    windowTitle,
    bounds: { x, y, width, height },
    axTree,
  };
}

export function resolveComposerAppshotCaptureSize(input: {
  readonly bounds: HelperWindowBounds;
  readonly scaleFactor: number;
}): { readonly width: number; readonly height: number } {
  const scaleFactor = Number.isFinite(input.scaleFactor) ? Math.max(1, input.scaleFactor) : 1;
  const requestedWidth = Math.max(1, Math.ceil(input.bounds.width * scaleFactor));
  const requestedHeight = Math.max(1, Math.ceil(input.bounds.height * scaleFactor));
  const longestDimension = Math.max(requestedWidth, requestedHeight);
  const downscale =
    longestDimension > MAX_CAPTURE_DIMENSION ? MAX_CAPTURE_DIMENSION / longestDimension : 1;
  return {
    width: Math.max(1, Math.round(requestedWidth * downscale)),
    height: Math.max(1, Math.round(requestedHeight * downscale)),
  };
}

export function findComposerAppshotSource<
  T extends {
    readonly id: string;
    readonly name: string;
  },
>(sources: readonly T[], target: ComposerAppshotHelperTarget): T | null {
  const sourcePrefix = `window:${target.windowId}:`;
  const exact = sources.find((source) => source.id.startsWith(sourcePrefix));
  if (exact) return exact;
  const windowTitle = target.windowTitle?.trim();
  if (!windowTitle) return null;
  return sources.find((source) => source.name.trim() === windowTitle) ?? null;
}

export function resolveComposerAppshotWindowTitle(input: {
  readonly axTree: string;
  readonly fallback: string | null;
}): string | null {
  const firstLine = input.axTree.split(/\r?\n/u, 1)[0] ?? "";
  const accessibilityTitle = /^Window:\s*"(.*)",\s*App:/u.exec(firstLine)?.[1]?.trim() ?? "";
  if (accessibilityTitle) return accessibilityTitle;
  return input.fallback?.trim() || null;
}

export function createComposerAppshotImageName(appName: string, now: number): string {
  const normalized = appName.replace(/[/:]/gu, "-").replace(/\s+/gu, " ").trim() || "App";
  const timestamp = new Date(now).toISOString().replaceAll(":", "-");
  return `${normalized} Appshot ${timestamp}.png`;
}

function resolveComposerAppshotHelperExecutable(config: ComposerAppshotLiveConfig): string {
  if (config.configuredHelperPath) return resolve(config.configuredHelperPath);
  if (config.isPackaged) return resolve(config.resourcesPath, "bin", "nodex-appshot-helper");
  return resolve(
    config.projectRootPath,
    ".generated",
    "dev-runtime",
    "bin",
    "nodex-appshot-helper",
  );
}

function runComposerAppshotHelper(
  executable: string,
  signal: AbortSignal,
): Promise<ComposerAppshotHelperTarget | null> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      executable,
      ["frontmost-window"],
      {
        encoding: "utf8",
        maxBuffer: MAX_HELPER_OUTPUT_BYTES,
        signal,
        timeout: 5_000,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr.trim() || error.message || "Appshot helper failed"));
          return;
        }
        try {
          resolvePromise(parseComposerAppshotHelperTarget(JSON.parse(stdout)));
        } catch (parseError) {
          reject(new Error("Appshot helper returned invalid JSON", { cause: parseError }));
        }
      },
    );
  });
}

export function makeComposerAppshotLivePlatform(
  config: ComposerAppshotLiveConfig,
): ComposerAppshotPlatform {
  const helperExecutable = resolveComposerAppshotHelperExecutable(config);
  return {
    platform: config.platform as NodeJS.Platform,
    processIdentifier: process.pid,
    helperAvailable: () =>
      hostCapabilities(config.platform).appshot && existsSync(helperExecutable),
    readFrontmostWindow: (signal) => runComposerAppshotHelper(helperExecutable, signal),
    listWindowSources: (thumbnailSize) =>
      desktopCapturer.getSources({
        types: ["window"],
        thumbnailSize,
        fetchWindowIcons: true,
      }),
    displayScaleFactor: (bounds) => screen.getDisplayMatching(bounds as Rectangle).scaleFactor,
    createId: randomUUID,
  };
}
