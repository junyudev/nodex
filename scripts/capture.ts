import { lstat, mkdir, open, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { chromium, type CDPSession, type Page, type Request } from "playwright";
import {
  readIsolatedRunClaim,
  readIsolatedRunLeaseOwner,
} from "../src/main/core-client/isolated-run-ownership";
import { APP_RENDERER_URL } from "../src/shared/app-renderer-policy";
import { CHANGELOG_SECTION_KINDS } from "../src/shared/changelog";
import {
  isAppLocale,
  type AppLocalePreference,
  type LanguageSettings,
} from "../src/shared/i18n/locales";
import { THEME_STORAGE_KEY } from "../src/renderer/lib/theme-preferences";
import {
  DEVELOPMENT_HOME_MANIFEST_FILE,
  parseDevelopmentHomeManifest,
} from "./development-environment-home";
import { resolvePrimaryCheckoutRoot } from "./primary-checkout";
import { runVitePlus } from "./vite-plus-command";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const timeout = 15_000;
const usage = `Capture a running seeded Nodex development window.

  vp run capture -- --home <absolute dev home> --out <file.png> [options]
  vp run capture -- --home <absolute dev home> --hero <change-file> --caption "<text>" [options]

  --selector <css>         Crop around a visible element
  --padding <px>           CSS pixels around the crop (default: 24); 0 crops to the element
                           alone and makes what lies behind its rounded corners transparent
  --theme light|dark|both  Default: current appearance; both adds -light and -dark
  --locale en-US|zh-CN     Default: current display language
  --width <px>             CSS pixels (default: 1440)
  --height <px>            CSS pixels (default: 900)
  --scale <ratio>          Device pixel ratio (default: 2)
  --hero <change-file>     Capture both appearances and attach them to the change
  --caption <text>         Required with --hero
`;

type Theme = "light" | "dark";
type Clip = { x: number; y: number; width: number; height: number };

function numericOption(name: string, raw: string, min: number, integer = true): number {
  const number = Number(raw);
  if (
    !raw.trim() ||
    !Number.isFinite(number) ||
    number < min ||
    (integer && !Number.isSafeInteger(number))
  ) {
    throw new Error(`--${name} must be ${integer ? "an integer" : "a number"} of at least ${min}`);
  }
  return number;
}

function captureOptions(args: string[]) {
  const { values } = parseArgs({
    args: args[0] === "--" ? args.slice(1) : args,
    options: {
      help: { type: "boolean", short: "h" },
      home: { type: "string" },
      out: { type: "string" },
      selector: { type: "string" },
      padding: { type: "string", default: "24" },
      theme: { type: "string" },
      locale: { type: "string" },
      width: { type: "string", default: "1440" },
      height: { type: "string", default: "900" },
      scale: { type: "string", default: "2" },
      hero: { type: "string" },
      caption: { type: "string" },
    },
  });
  if (values.help) return null;
  const { home, out, hero, caption, locale, selector } = values;
  const requestedTheme = values.theme;
  const theme: Theme | "both" | undefined =
    requestedTheme === "light" || requestedTheme === "dark" || requestedTheme === "both"
      ? requestedTheme
      : undefined;
  if (!home || !path.isAbsolute(home))
    throw new Error("--home must be an absolute development home");
  if (requestedTheme !== undefined && theme === undefined) {
    throw new Error("--theme must be light, dark, or both");
  }
  if (locale !== undefined && !isAppLocale(locale))
    throw new Error("--locale must be en-US or zh-CN");
  if (selector !== undefined && !selector.trim())
    throw new Error("--selector must be a CSS selector");
  if (hero !== undefined) {
    if (!hero || !caption?.trim()) throw new Error("--hero requires a change file and --caption");
    if (out !== undefined) throw new Error("--hero sets the output directory; omit --out");
    if (theme && theme !== "both") throw new Error("--hero requires both appearances");
  } else {
    if (!out || path.extname(out).toLowerCase() !== ".png")
      throw new Error("--out must be a PNG path");
    if (caption !== undefined) throw new Error("--caption requires --hero");
  }
  return {
    home,
    out,
    hero: hero && caption ? { file: hero, caption } : undefined,
    theme,
    locale,
    selector,
    padding: numericOption("padding", values.padding, 0),
    width: numericOption("width", values.width, 1),
    height: numericOption("height", values.height, 1),
    scale: numericOption("scale", values.scale, 0.1, false),
  };
}

type Options = NonNullable<ReturnType<typeof captureOptions>>;

async function heroOutput(changeFile: string): Promise<string> {
  const file = await realpath(changeFile);
  const [folder, kind, name, extra] = path.relative(repositoryRoot, file).split(path.sep);
  const slug = /^\d{4}-\d{2}-\d{2}-([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/u.exec(name ?? "")?.[1];
  if (
    folder !== "changes" ||
    !CHANGELOG_SECTION_KINDS.some((value) => value === kind) ||
    !slug ||
    extra
  ) {
    throw new Error("--hero must name a change file under changes/<kind>/ in this worktree");
  }
  return path.join(
    resolvePrimaryCheckoutRoot(repositoryRoot),
    "notes.local",
    "artifacts",
    slug,
    "hero",
    "hero.png",
  );
}

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, "utf8"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535;
}

async function devToolsJson(origin: string, route: string): Promise<unknown> {
  const response = await fetch(`${origin}${route}`, {
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`DevTools discovery returned HTTP ${response.status}`);
  return response.json();
}

function isWorkbenchUrl(value: unknown): value is string {
  const url = typeof value === "string" ? URL.parse(value) : null;
  if (!url || url.searchParams.has("initialRoute") || !url.searchParams.has("opaqueWindowSurface"))
    return false;
  const appUrl = new URL(APP_RENDERER_URL);
  if (url.protocol === appUrl.protocol && url.host === appUrl.host)
    return url.pathname === appUrl.pathname;
  return (
    url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
    !!url.port &&
    ["/", "/index.html"].includes(url.pathname)
  );
}

async function discoverTarget(home: string) {
  if (!(await lstat(home)).isDirectory())
    throw new Error("--home must be a real development directory");
  const manifest = parseDevelopmentHomeManifest(
    await readJson(path.join(home, DEVELOPMENT_HOME_MANIFEST_FILE)),
  );
  if (
    !manifest.seed ||
    !manifest.initializedAt ||
    manifest.repositoryRealpath !== (await realpath(repositoryRoot))
  ) {
    throw new Error("--home must be a seeded development Profile owned by this worktree");
  }
  const nodexHome = path.join(await realpath(home), ".nodex");
  if (!(await lstat(nodexHome)).isDirectory())
    throw new Error("Development Profile must be a real directory");

  const owner = readIsolatedRunLeaseOwner(nodexHome);
  const claim = readIsolatedRunClaim(nodexHome);
  if (!owner || !claim || owner.runId !== claim.runId || claim.phase !== "ready") {
    throw new Error("No ready capture target for this home. Start it with vp run dev");
  }

  // Electron writes the port and a unique browser WebSocket path into the isolated
  // session data directory for both fixed and assigned ports.
  const sessionData = path.join(nodexHome, "electron-session-data");
  const activePortFile = path.join(sessionData, "DevToolsActivePort");
  if (!(await lstat(sessionData)).isDirectory()) {
    throw new Error("DevTools session data must be inside the development Profile");
  }
  const activePortStat = await lstat(activePortFile);
  if (!activePortStat.isFile() || activePortStat.mtimeMs < Date.parse(owner.acquiredAt)) {
    throw new Error("DevTools endpoint was not recorded by the current development launch");
  }
  const [recordedPort, socketPath] = (await readFile(activePortFile, "utf8"))
    .trim()
    .split(/\r?\n/u);
  const port = Number(recordedPort);
  if (!isPort(port) || !socketPath || !/^\/devtools\/browser\/[\da-f-]+$/iu.test(socketPath)) {
    throw new Error("Invalid DevTools endpoint in the development Profile");
  }

  const endpoint = `127.0.0.1:${port}`;
  const socket = `ws://${endpoint}${socketPath}`;
  const origin = `http://${endpoint}`;
  const version = await devToolsJson(origin, "/json/version");
  if (!isRecord(version) || version.webSocketDebuggerUrl !== socket) {
    throw new Error("DevTools browser endpoint does not match the development Profile");
  }
  const targets = await devToolsJson(origin, "/json/list");
  if (!Array.isArray(targets)) throw new Error("DevTools returned an invalid target list");
  const matches = targets.flatMap((target: unknown) =>
    isRecord(target) &&
    target.type === "page" &&
    typeof target.id === "string" &&
    isWorkbenchUrl(target.url)
      ? [{ id: target.id, url: target.url }]
      : [],
  );
  const [target] = matches;
  if (!target || readIsolatedRunClaim(nodexHome)?.runId !== claim.runId) {
    throw new Error("DevTools has no matching Nodex workbench for this development launch");
  }
  if (matches.length > 1)
    throw new Error("Close extra Nodex windows in this development instance before capturing");
  return { target, socket, lockPath: path.join(home, `capture-${claim.runId}.lock`) };
}

async function languageSettings(
  page: Page,
  preference?: AppLocalePreference,
): Promise<LanguageSettings> {
  const settings = await page.evaluate(async (preference) => {
    const api = window.api;
    if (!api) throw new Error("Nodex settings bridge is unavailable");
    return preference === undefined
      ? await api.invoke("settings:language:get")
      : await api.invoke("settings:language:update", preference);
  }, preference);
  if (
    !isRecord(settings) ||
    !isAppLocale(settings.locale) ||
    (settings.preference !== null && !isAppLocale(settings.preference))
  ) {
    throw new Error("Nodex returned invalid language settings");
  }
  return { locale: settings.locale, preference: settings.preference };
}

async function applyTheme(page: Page, preference: string | null): Promise<void> {
  await page.evaluate(
    ({ key, preference }) => {
      const previous = localStorage.getItem(key);
      if (previous === preference) return;
      if (preference === null) localStorage.removeItem(key);
      else localStorage.setItem(key, preference);
      // ThemeProvider uses this same preference and event to synchronize workbench windows.
      window.dispatchEvent(
        new StorageEvent("storage", { key, oldValue: previous, newValue: preference }),
      );
    },
    { key: THEME_STORAGE_KEY, preference },
  );
}

function watchNetwork(page: Page) {
  const pending = new Set<Request>();
  let lastActivity = performance.now();
  page.on("request", (request) => {
    if (request.resourceType() === "eventsource") return;
    pending.add(request);
    lastActivity = performance.now();
  });
  const finish = (request: Request) => {
    if (pending.delete(request)) lastActivity = performance.now();
  };
  page.on("requestfinished", finish);
  page.on("requestfailed", finish);
  return () => pending.size === 0 && performance.now() - lastActivity >= 500;
}

async function waitForFrame(
  page: Page,
  isNetworkIdle: () => boolean,
  theme: Theme,
  locale: string,
  signal: AbortSignal,
) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    signal.throwIfAborted();
    await page.waitForFunction(
      ({ theme, locale }) => {
        const html = document.documentElement;
        return (
          html.dataset.theme === theme &&
          html.lang === locale &&
          document.fonts.status === "loaded" &&
          // Scroll-driven effects are already at their captured scroll position.
          document
            .getAnimations()
            .every(
              (animation) =>
                !(animation.timeline instanceof DocumentTimeline) ||
                animation.playState !== "running" ||
                animation.effect?.getTiming().iterations === Infinity,
            )
        );
      },
      { theme, locale },
      { polling: 50, timeout: Math.max(1, deadline - performance.now()) },
    );
    if (isNetworkIdle()) return;
    await delay(50, undefined, { signal });
  }
  throw new Error("The workbench did not reach network idle");
}

/** Keeps only the element's rounded rectangle, so what lies behind its corners is transparent. */
async function cutOut(
  png: Buffer,
  shape: { x: number; y: number; width: number; height: number; radius: number },
  scale: number,
): Promise<Buffer> {
  const { default: sharp } = await import("sharp");
  const image = sharp(png);
  const { width, height } = await image.metadata();
  const mask = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect x="${shape.x * scale}" y="${shape.y * scale}" width="${shape.width * scale}" height="${shape.height * scale}" rx="${shape.radius * scale}" fill="#fff"/></svg>`,
  );
  return image
    .ensureAlpha()
    .composite([{ input: mask, blend: "dest-in" }])
    .png()
    .toBuffer();
}

async function captureImage(
  page: Page,
  cdp: CDPSession,
  options: Options,
  out: string,
): Promise<void> {
  const viewport = await page.evaluate(() => ({
    x: scrollX,
    y: scrollY,
    width: innerWidth,
    height: innerHeight,
    scale: devicePixelRatio,
  }));
  if (
    viewport.width !== options.width ||
    viewport.height !== options.height ||
    Math.abs(viewport.scale - options.scale) > 0.0001
  ) {
    throw new Error(
      `Unexpected capture viewport: ${viewport.width}×${viewport.height} at ${viewport.scale}x`,
    );
  }

  let clip: Clip = viewport;
  // A selector crop without padding is the element alone: its rounded corners become transparent.
  let cutout: { x: number; y: number; width: number; height: number; radius: number } | undefined;
  if (options.selector) {
    const element = page.locator(`css=${options.selector}`);
    const box = await element.boundingBox({ timeout });
    if (!box) throw new Error(`Capture selector is not visible: ${options.selector}`);
    const left = Math.max(0, Math.floor(box.x - options.padding));
    const top = Math.max(0, Math.floor(box.y - options.padding));
    const right = Math.min(viewport.width, Math.ceil(box.x + box.width + options.padding));
    const bottom = Math.min(viewport.height, Math.ceil(box.y + box.height + options.padding));
    if (right <= left || bottom <= top)
      throw new Error("Capture selector lies outside the viewport");
    clip = { x: viewport.x + left, y: viewport.y + top, width: right - left, height: bottom - top };
    if (options.padding === 0) {
      const radius = await element.evaluate(
        (node) => Number.parseFloat(getComputedStyle(node).borderTopLeftRadius) || 0,
      );
      if (radius > 0) {
        cutout = { x: box.x - left, y: box.y - top, width: box.width, height: box.height, radius };
      }
    }
  }
  const { data } = (await cdp.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
    clip: { ...clip, scale: 1 },
  })) as { data: string };
  const png = Buffer.from(data, "base64");
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (
    Math.abs(width - clip.width * options.scale) > 0.5 ||
    Math.abs(height - clip.height * options.scale) > 0.5
  ) {
    throw new Error(
      `DevTools returned ${width}×${height} for a ${clip.width}×${clip.height} crop at ${options.scale}x`,
    );
  }
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, cutout ? await cutOut(png, cutout, options.scale) : png);
  console.log(`${out} (${width}×${height})`);
}

const CARET_STYLE_ID = "nodex-capture-hidden-caret";

async function captureWindow(
  page: Page,
  cdp: CDPSession,
  options: Options,
  out: string,
  signal: AbortSignal,
) {
  const isNetworkIdle = watchNetwork(page);
  await page.waitForFunction(
    () =>
      !!document.querySelector("#root:not([aria-busy]) > *") &&
      !document.querySelector(".nodex-startup-shell"),
    undefined,
    { polling: 50, timeout },
  );
  const previous = await page.evaluate(
    (key) => ({
      preference: localStorage.getItem(key),
      theme: document.documentElement.dataset.theme,
    }),
    THEME_STORAGE_KEY,
  );
  const previousTheme = previous.theme;
  if (previousTheme !== "light" && previousTheme !== "dark")
    throw new Error("Nodex appearance is unavailable");
  const language = await languageSettings(page);
  const localeChanged = options.locale !== undefined && options.locale !== language.preference;
  const appearance = options.hero ? "both" : options.theme;
  const themes: Theme[] = appearance === "both" ? ["light", "dark"] : [appearance ?? previousTheme];
  const imagePath = (theme: Theme) =>
    appearance === "both" ? `${out.slice(0, -4)}-${theme}.png` : out;

  const emulateFocus = await page.evaluate(() => document.hidden);
  const errors: unknown[] = [];
  try {
    if (emulateFocus) await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: options.width,
      height: options.height,
      deviceScaleFactor: options.scale,
      mobile: false,
    });
    if (localeChanged) await languageSettings(page, options.locale);
    // A blinking caret would make otherwise identical captures differ.
    await page.evaluate((id) => {
      const style = document.createElement("style");
      style.id = id;
      style.textContent = "*, *::before, *::after { caret-color: transparent !important; }";
      document.head.append(style);
    }, CARET_STYLE_ID);
    for (const theme of themes) {
      signal.throwIfAborted();
      if (appearance) await applyTheme(page, theme);
      await waitForFrame(page, isNetworkIdle, theme, options.locale ?? language.locale, signal);
      await captureImage(page, cdp, options, imagePath(theme));
    }
  } catch (error) {
    errors.push(error);
  } finally {
    const restorations = await Promise.allSettled([
      cdp.send("Emulation.clearDeviceMetricsOverride"),
      page.evaluate((id) => document.getElementById(id)?.remove(), CARET_STYLE_ID),
      emulateFocus ? cdp.send("Emulation.setFocusEmulationEnabled", { enabled: false }) : undefined,
      appearance ? applyTheme(page, previous.preference) : undefined,
      localeChanged ? languageSettings(page, language.preference) : undefined,
    ]);
    for (const result of restorations) {
      if (result.status === "rejected") errors.push(result.reason);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "Capture and cleanup did not finish");
  return { light: imagePath("light"), dark: imagePath("dark") };
}

async function capture(options: Options, signal: AbortSignal) {
  const out = options.hero ? await heroOutput(options.hero.file) : path.resolve(options.out!);
  const { target, socket, lockPath } = await discoverTarget(options.home);
  signal.throwIfAborted();
  const lock = await open(lockPath, "wx", 0o600).catch((error: unknown) => {
    if (isRecord(error) && error.code === "EEXIST") {
      throw new Error(
        "A capture is already running for this instance. If it was interrupted, relaunch the instance.",
      );
    }
    throw error;
  });
  let images: Awaited<ReturnType<typeof captureWindow>>;
  try {
    const browser = await chromium.connectOverCDP(socket, { noDefaults: true, timeout });
    try {
      const page = browser
        .contexts()
        .flatMap((context) => context.pages())
        .find((page) => page.url() === target.url);
      if (!page) throw new Error("The verified workbench closed before capture");
      const cdp = await page.context().newCDPSession(page);
      const { targetInfo } = (await cdp.send("Target.getTargetInfo")) as {
        targetInfo: { targetId: string };
      };
      if (targetInfo.targetId !== target.id)
        throw new Error("The workbench target changed before capture");
      images = await captureWindow(page, cdp, options, out, signal);
    } finally {
      await browser.close();
    }
  } finally {
    await lock.close();
    await rm(lockPath, { force: true });
  }
  signal.throwIfAborted();
  if (options.hero) {
    runVitePlus(
      [
        "run",
        "media:add",
        "--",
        path.resolve(options.hero.file),
        "--caption",
        options.hero.caption,
        "--light",
        images.light,
        "--dark",
        images.dark,
      ],
      { cwd: repositoryRoot },
    );
  }
}

const controller = new AbortController();
const interrupt = () => controller.abort(new Error("Capture interrupted"));
async function main() {
  const options = captureOptions(process.argv.slice(2));
  if (!options) {
    console.log(usage);
    return;
  }
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  try {
    await capture(options, controller.signal);
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
