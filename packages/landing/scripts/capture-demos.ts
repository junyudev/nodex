import { spawn } from "node:child_process";
import { link, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, type Browser } from "playwright";
import { CAPTURE_DEMOS, captureDemoPath, type CaptureDemoId } from "../src/demos/capture-demos";
import type { Locale } from "../src/lib/locale";
import { SOCIAL_CARDS, SOCIAL_CARD_VIEWPORT } from "../src/lib/social-cards";

// Inside the checkout, where git ignores `*.local`, so recordings are never committed by accident.
const DEFAULT_OUT = fileURLToPath(
  new URL("../../../notes.local/artifacts/landing-captures", import.meta.url),
);
// Social cards are committed: the site publishes them from here.
const PUBLIC_ASSETS = fileURLToPath(new URL("../public", import.meta.url));
const MP4_LIMIT = 4_000_000;
const AVIF_LIMIT = 4_000_000;
/** GitHub shows a README image about 840 CSS px wide, so 1800 covers a 2x display. */
const FIT_WIDTH = 1800;
const AVIF_WIDTH = 1900;
/** The page around a demo's designed size that the capture root includes. */
const CAPTURE_MARGIN = 80;
/**
 * Renders each demo near the published width instead of resampling a larger capture: text stays
 * as the browser drew it, and lossless frames stay cheap enough to arrive at full rate. Quarter
 * steps keep the scaled size whole.
 */
export const fitScale = (designed: { readonly width: number }) =>
  Math.round((FIT_WIDTH / (designed.width + CAPTURE_MARGIN)) * 4) / 4;
const GIF_LIMIT = 10_000_000;

interface Options {
  readonly demos: readonly CaptureDemoId[];
  readonly locales: readonly Locale[];
  readonly themes: readonly ("dark" | "light")[];
  readonly baseUrl: string;
  readonly out: string;
  readonly fps: number;
  readonly scale: number | undefined;
  readonly og: boolean;
}

interface Frame {
  readonly file: string;
  readonly timestampMs: number;
}

interface CaptureTiming {
  readonly startMs: number;
  readonly durationMs: number;
  endMs?: number;
}

declare global {
  interface Window {
    __nodexRecording?: CaptureTiming;
  }
}

interface Recording {
  readonly frames: readonly Frame[];
  readonly startMs: number;
  readonly durationMs: number;
  readonly width: number;
  readonly height: number;
  readonly background: string;
}

interface Output {
  readonly file: string;
  readonly dimensions: string;
  readonly duration: string;
  readonly size: string;
}

const help = `Record landing demos in real time with Chromium and ffmpeg.

  vp run capture:landing [options]

  --demo <id|all>       Default: all (${Object.keys(CAPTURE_DEMOS).join(", ")})
  --theme <dark|light|both>  Default: both
  --locale <en|zh-CN|both>  Default: en. Social cards are English.
  --base-url <url>      Default: http://127.0.0.1:4330
  --out <directory>     Default: ${DEFAULT_OUT}, or ${PUBLIC_ASSETS} with --og
  --fps <number>        Constant video frame rate, 1–60. Default: 30
  --scale <number>      Device scale factor, 1–4. Default: fits each demo to about 1800px
                        wide; 2 with --og
  --og                 Only render each /capture/og/<card>/ social card (1200×630 at --scale)
  --help               Show this help

Start the landing server separately. Requires Playwright Chromium. Demos also need
ffmpeg with libx264/libvpx-vp9, and avifenc for the looping AVIF.
No browser clock or animation time is mocked. Existing named outputs are replaced.
`;

export function parseOptions(args: readonly string[]): Options | undefined {
  const { values } = parseArgs({
    args: [...args],
    options: {
      demo: { type: "string", default: "all" },
      theme: { type: "string", default: "both" },
      locale: { type: "string", default: "en" },
      "base-url": { type: "string", default: "http://127.0.0.1:4330" },
      out: { type: "string" },
      fps: { type: "string", default: "30" },
      scale: { type: "string" },
      og: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) return undefined;
  const demo = values.demo!;
  if (demo !== "all" && !Object.hasOwn(CAPTURE_DEMOS, demo)) {
    throw new Error(
      `Unknown demo '${demo}'. Choose all or ${Object.keys(CAPTURE_DEMOS).join(", ")}.`,
    );
  }
  const locale = values.locale!;
  if (locale !== "en" && locale !== "zh-CN" && locale !== "both") {
    throw new Error("--locale must be en, zh-CN, or both.");
  }
  const theme = values.theme!;
  if (theme !== "both" && theme !== "dark" && theme !== "light") {
    throw new Error("--theme must be dark, light, or both.");
  }
  const fps = Number(values.fps);
  const scale = values.scale === undefined ? undefined : Number(values.scale);
  if (!Number.isInteger(fps) || fps < 1 || fps > 60)
    throw new Error("--fps must be an integer from 1 to 60.");
  if (scale !== undefined && (!Number.isFinite(scale) || scale < 1 || scale > 4))
    throw new Error("--scale must be from 1 to 4.");
  const baseUrl = new URL(values["base-url"]!);
  if (!/^https?:$/.test(baseUrl.protocol)) throw new Error("--base-url must use HTTP or HTTPS.");
  return {
    demos:
      demo === "all" ? (Object.keys(CAPTURE_DEMOS) as CaptureDemoId[]) : [demo as CaptureDemoId],
    locales: locale === "both" ? ["en", "zh-CN"] : [locale],
    themes: theme === "both" ? ["dark", "light"] : [theme],
    baseUrl: baseUrl.href,
    out: resolve(values.out ?? (values.og ? PUBLIC_ASSETS : DEFAULT_OUT)),
    fps,
    scale,
    og: values.og,
  };
}

/** Hold the last presented compositor frame at each CFR tick, including static tails. */
export function frameSequence(
  frames: readonly Frame[],
  startMs: number,
  durationMs: number,
  fps: number,
): readonly Frame[] {
  if (!frames.length) throw new Error("Chromium produced no capture frames.");
  const count = Math.ceil((durationMs * fps) / 1000);
  let index = 0;
  return Array.from({ length: count }, (_, tick) => {
    const timestampMs = startMs + (tick * 1000) / fps;
    while (index + 1 < frames.length && frames[index + 1]!.timestampMs <= timestampMs) index += 1;
    return frames[index]!;
  });
}

async function command(executable: string, args: readonly string[], cwd?: string): Promise<string> {
  return await new Promise((settle, reject) => {
    const child = spawn(executable, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (text: string) => {
      stdout += text;
    });
    child.stderr.setEncoding("utf8").on("data", (text: string) => {
      stderr = (stderr + text).slice(-12_000);
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) return settle(stdout);
      reject(new Error(`${executable} failed (${signal ?? code}):\n${stderr}`));
    });
  });
}

const ffmpeg = (args: readonly string[]) =>
  command("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", ...args]);
const frameName = (index: number) => `${String(index).padStart(6, "0")}.png`;

async function inspectMedia(file: string): Promise<{
  readonly streams: readonly {
    readonly width: number;
    readonly height: number;
    readonly pix_fmt?: string;
  }[];
  readonly format?: { readonly duration?: string };
}> {
  return JSON.parse(
    await command("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "stream=width,height,pix_fmt:format=duration",
      "-of",
      "json",
      file,
    ]),
  );
}

async function checkTools(): Promise<void> {
  try {
    const version = await command("ffmpeg", ["-version"]);
    await command("ffprobe", ["-version"]);
    console.log(version.split("\n")[0]);
  } catch (error) {
    throw new Error(
      "ffmpeg and ffprobe are required. Install with Homebrew: brew install ffmpeg-full",
      {
        cause: error,
      },
    );
  }
  const encoders = await command("ffmpeg", ["-hide_banner", "-encoders"]);
  for (const encoder of ["libx264", "libvpx-vp9"]) {
    if (!encoders.includes(encoder))
      throw new Error(`ffmpeg lacks ${encoder}. Use Homebrew's ffmpeg-full build.`);
  }
  try {
    await command("avifenc", ["--version"]);
  } catch (error) {
    throw new Error("The looping AVIF needs avifenc. Install with: brew install libavif", {
      cause: error,
    });
  }
}

async function record(
  browser: Browser,
  options: Options,
  scale: number,
  demo: CaptureDemoId,
  locale: Locale,
  stem: string,
  theme: "dark" | "light",
  directory: string,
): Promise<Recording> {
  const designed = CAPTURE_DEMOS[demo];
  const context = await browser.newContext({
    viewport: {
      width: designed.width + CAPTURE_MARGIN,
      height: designed.height + CAPTURE_MARGIN,
    },
    deviceScaleFactor: scale,
    colorScheme: theme,
    reducedMotion: "no-preference",
  });
  try {
    const page = await context.newPage();
    const pageErrors: Error[] = [];
    page.on("pageerror", (error) => {
      pageErrors.push(error);
      console.error(`  Capture page error: ${error.message}`);
    });
    // Observe the public handle at assignment time, before the first timeline RAF.
    // These are real epoch timestamps, on the same clock as screencast metadata.
    await page.addInitScript(() => {
      let handle: Window["__nodexCapture"];
      Object.defineProperty(window, "__nodexCapture", {
        configurable: true,
        get() {
          return handle;
        },
        set(value: NonNullable<Window["__nodexCapture"]>) {
          handle = value;
          const timing: CaptureTiming = {
            startMs: performance.timeOrigin + performance.now(),
            durationMs: value.durationMs,
          };
          window.__nodexRecording = timing;
          void value.done.then(() => {
            timing.endMs = performance.timeOrigin + performance.now();
          });
        },
      });
    });
    const url = new URL(
      captureDemoPath(demo, locale),
      options.baseUrl.endsWith("/") ? options.baseUrl : `${options.baseUrl}/`,
    );
    // Warm Astro modules/fonts and measure the actual root before recording a fresh loop.
    const response = await page.goto(url.href);
    if (!response?.ok()) throw new Error(`Capture page returned ${response?.status()}: ${url}`);
    const root = page.locator("[data-capture-root]");
    await root.waitFor();
    await page.evaluate(() => document.fonts.ready);
    const box = await root.boundingBox();
    if (!box || box.x !== 0 || box.y !== 0)
      throw new Error("Capture root must start at the page origin.");
    const viewport = { width: Math.ceil(box.width), height: Math.ceil(box.height) };
    await page.setViewportSize(viewport);
    const cdp = await context.newCDPSession(page);
    const frames: Frame[] = [];
    const writes: Promise<void>[] = [];
    const failures: unknown[] = [];
    const expectedWidth = Math.round(viewport.width * scale);
    const expectedHeight = Math.round(viewport.height * scale);
    cdp.on("Page.screencastFrame", (event) => {
      void cdp
        .send("Page.screencastFrameAck", { sessionId: event.sessionId })
        .catch((error: unknown) => {
          failures.push(error);
        });
      if (event.metadata.timestamp === undefined) {
        failures.push(new Error("Screencast frame has no compositor timestamp."));
        return;
      }
      const data = Buffer.from(event.data, "base64");
      const file = join(directory, frameName(frames.length));
      frames.push({ file, timestampMs: event.metadata.timestamp * 1000 });
      writes.push(
        writeFile(file, data).catch((error: unknown) => {
          failures.push(error);
        }),
      );
    });
    await cdp.send("Page.startScreencast", {
      format: "png",
      maxWidth: expectedWidth,
      maxHeight: expectedHeight,
      everyNthFrame: 1,
    });
    url.searchParams.set("capture", "");
    await page.goto(url.href);
    await page.waitForFunction(() => window.__nodexRecording !== undefined);
    const scriptedMs = await page.evaluate(() => window.__nodexRecording!.durationMs);
    console.log(
      `Recording ${stem}: ${(scriptedMs / 1000).toFixed(2)}s, ${expectedWidth}×${expectedHeight}…`,
    );
    await page.waitForFunction(() => window.__nodexRecording?.endMs !== undefined, null, {
      timeout: scriptedMs * 3 + 30_000,
    });
    const timing = await page.evaluate(() => window.__nodexRecording!);
    // Flush the final paint without extending the encoded timeline.
    await page.evaluate(
      () =>
        new Promise<void>((settle) =>
          requestAnimationFrame(() => requestAnimationFrame(() => settle())),
        ),
    );
    await cdp.send("Page.stopScreencast");
    await Promise.all(writes);
    if (pageErrors.length)
      throw new AggregateError(pageErrors, "Capture page failed during playback.");
    if (failures.length)
      throw new AggregateError(failures, "Could not record full-resolution screencast frames.");
    const valid = frames.filter(
      (frame) => frame.timestampMs >= timing.startMs && frame.timestampMs <= timing.endMs!,
    );
    if (!valid.length) throw new Error("No frames arrived during demo playback.");
    const dimensions = (await inspectMedia(valid[0]!.file)).streams[0];
    if (dimensions?.width !== expectedWidth || dimensions.height !== expectedHeight) {
      throw new Error(
        `Expected ${expectedWidth}×${expectedHeight} screencast. Check Chromium's device scale factor.`,
      );
    }
    const firstFrameDelayMs = valid[0]!.timestampMs - timing.startMs;
    if (firstFrameDelayMs > 150)
      throw new Error(
        `First demo frame arrived ${firstFrameDelayMs.toFixed(0)}ms late. Retry with less system load.`,
      );
    const durationMs = timing.endMs! - timing.startMs;
    const actualLocale = await page.locator("html").getAttribute("lang");
    if (actualLocale !== locale)
      throw new Error(`Expected ${locale} locale; page rendered ${actualLocale}.`);
    const actualTheme = await page.locator("html").getAttribute("data-theme");
    if (actualTheme !== theme)
      throw new Error(`Expected ${theme} theme; page rendered ${actualTheme}.`);
    const finalBox = await root.boundingBox();
    if (!finalBox || finalBox.width !== box.width || finalBox.height !== box.height)
      throw new Error("Capture root changed size during playback.");
    const background = await page.evaluate(() => {
      let node = document.querySelector("[data-capture-root]")!.parentElement;
      while (node) {
        const color = getComputedStyle(node).backgroundColor;
        if (color !== "transparent" && color !== "rgba(0, 0, 0, 0)") return color;
        node = node.parentElement;
      }
      throw new Error("Capture page has no opaque background for OG padding.");
    });
    const intervals = valid
      .slice(1)
      .map((frame, index) => frame.timestampMs - valid[index]!.timestampMs);
    const report = {
      demo,
      locale,
      theme,
      scriptedMs,
      durationMs,
      firstFrameDelayMs,
      sourceFrames: valid.length,
      largestFrameGapMs: Math.max(0, ...intervals),
      viewport,
      scale,
      startMs: timing.startMs,
      frames: valid.map((frame) => frame.timestampMs - timing.startMs),
    };
    await writeFile(
      join(options.out, `${stem}-timing.json`),
      `${JSON.stringify(report, null, 2)}\n`,
    );
    console.log(
      `  ${valid.length} compositor frames; first +${firstFrameDelayMs.toFixed(1)}ms; max gap ${report.largestFrameGapMs.toFixed(1)}ms; real duration ${(durationMs / 1000).toFixed(3)}s.`,
    );
    return {
      frames: valid,
      startMs: timing.startMs,
      durationMs,
      width: expectedWidth,
      height: expectedHeight,
      background,
    };
  } finally {
    await context.close();
  }
}

async function sequence(recording: Recording, fps: number, directory: string): Promise<string> {
  await mkdir(directory);
  const frames = frameSequence(recording.frames, recording.startMs, recording.durationMs, fps);
  // Hardlinks keep duplicated CFR frames cheap; every temporary file is under --out.
  for (const [index, frame] of frames.entries())
    await link(frame.file, join(directory, frameName(index)));
  return join(directory, "%06d.png");
}

async function output(
  file: string,
  width: number,
  height: number,
  durationMs?: number,
): Promise<Output> {
  const size = (await stat(file)).size;
  let measuredDurationMs = durationMs;
  if (/\.(mp4|webm|gif)$/.test(file)) {
    const metadata = await inspectMedia(file);
    const stream = metadata.streams[0];
    if (stream?.width !== width || stream.height !== height)
      throw new Error(`Unexpected encoded dimensions: ${file}`);
    if (!file.endsWith(".gif") && stream.pix_fmt !== "yuv420p")
      throw new Error(`Expected yuv420p video: ${file} (${stream.pix_fmt}).`);
    measuredDurationMs = Number(metadata.format?.duration) * 1000;
    if (!Number.isFinite(measuredDurationMs))
      throw new Error(`Could not measure duration: ${file}`);
  }
  return {
    file: file.split("/").at(-1)!,
    dimensions: `${width}×${height}`,
    duration:
      measuredDurationMs === undefined ? "still" : `${(measuredDurationMs / 1000).toFixed(3)}s`,
    size: `${(size / 1_000_000).toFixed(2)} MB`,
  };
}

const scaledHeight = (recording: Recording, width: number) =>
  Math.round((recording.height * width) / recording.width / 2) * 2;

async function stills(recording: Recording, stem: string, out: string): Promise<Output[]> {
  const rows: Output[] = [];
  for (const [suffix, fraction] of [
    ["first", 0],
    ["poster", 0.7],
    ["last", 1],
  ] as const) {
    const target = recording.startMs + fraction * recording.durationMs;
    const frame = recording.frames.reduce((nearest, candidate) =>
      Math.abs(candidate.timestampMs - target) < Math.abs(nearest.timestampMs - target)
        ? candidate
        : nearest,
    );
    const file = join(out, `${stem}-${suffix}.png`);
    await ffmpeg(["-i", frame.file, "-frames:v", "1", file]);
    rows.push(await output(file, recording.width, recording.height));
  }
  return rows;
}

/**
 * A looping image for places that cannot play video, such as a README. AV1 predicts each frame
 * from the last, so a mostly still interface costs little, and 4:4:4 keeps coloured text sharp.
 * Animated WebP is not an option: its lossy encoder leaves a pixel alone when it changed by less
 * than a quality-dependent tolerance, so a slow fade strands blocks of stale colour on screen.
 */
async function encodeAvif(
  recording: Recording,
  options: Options,
  stem: string,
  temp: string,
): Promise<Output> {
  const fps = Math.min(options.fps, 20);
  const width = Math.min(recording.width, AVIF_WIDTH);
  const input = await sequence(recording, fps, join(temp, "avif-sequence"));
  const file = join(options.out, `${stem}.avif`);
  const directory = join(temp, "avif-frames");
  await mkdir(directory);
  await ffmpeg([
    "-framerate",
    String(fps),
    "-i",
    input,
    "-vf",
    `scale=${width}:-2:flags=lanczos`,
    join(directory, "%06d.png"),
  ]);
  // Relative paths keep --out directories with spaces safe and the argument list short.
  const frames = (await readdir(directory)).sort().map((name) => join("avif-frames", name));
  for (const quality of [80, 70, 60]) {
    console.log(`  AVIF: ${fps}fps, quality ${quality}…`);
    await command(
      "avifenc",
      ["--fps", String(fps), "--yuv", "444", "-q", String(quality), "-s", "4", ...frames, file],
      temp,
    );
    if ((await stat(file)).size <= AVIF_LIMIT)
      return await output(
        file,
        width,
        scaledHeight(recording, width),
        (Math.ceil((recording.durationMs * fps) / 1000) * 1000) / fps,
      );
  }
  await rm(file);
  throw new Error(
    `${stem}.avif exceeded 4 MB even at quality 60. Shorten the capture or reduce motion before publishing.`,
  );
}

async function encode(
  recording: Recording,
  options: Options,
  stem: string,
  temp: string,
): Promise<Output[]> {
  const rows = await stills(recording, stem, options.out);
  const input = await sequence(recording, options.fps, join(temp, "video-sequence"));
  const source = ["-framerate", String(options.fps), "-i", input];
  const video = [
    "-vf",
    "scale=1260:-2:flags=lanczos:out_range=tv",
    "-an",
    "-pix_fmt",
    "yuv420p",
    "-color_range",
    "tv",
  ];
  const durationMs = (Math.ceil((recording.durationMs * options.fps) / 1000) * 1000) / options.fps;
  const mp4 = join(options.out, `${stem}.mp4`);
  console.log("  Encoding H.264…");
  await ffmpeg([
    ...source,
    ...video,
    "-c:v",
    "libx264",
    "-preset",
    "slow",
    "-crf",
    "20",
    "-movflags",
    "+faststart",
    mp4,
  ]);
  if ((await stat(mp4)).size > MP4_LIMIT) {
    // Two-pass encoding makes the size target explicit when CRF is insufficient.
    const bitrate = Math.floor((MP4_LIMIT * 8 * 0.94) / (durationMs / 1000));
    const pass = [
      ...source,
      ...video,
      "-c:v",
      "libx264",
      "-preset",
      "slow",
      "-b:v",
      String(bitrate),
      "-passlogfile",
      join(temp, "h264-pass"),
    ];
    await ffmpeg([...pass, "-pass", "1", "-f", "null", "/dev/null"]);
    await ffmpeg([...pass, "-pass", "2", "-movflags", "+faststart", mp4]);
  }
  if ((await stat(mp4)).size > MP4_LIMIT) throw new Error(`${stem}.mp4 exceeded the 4 MB target.`);
  rows.push(await output(mp4, 1260, scaledHeight(recording, 1260), durationMs));
  const webm = join(options.out, `${stem}.webm`);
  console.log("  Encoding VP9…");
  await ffmpeg([
    ...source,
    ...video,
    "-c:v",
    "libvpx-vp9",
    "-crf",
    "32",
    "-b:v",
    "0",
    "-row-mt",
    "1",
    "-cpu-used",
    "3",
    webm,
  ]);
  rows.push(await output(webm, 1260, scaledHeight(recording, 1260), durationMs));
  rows.push(await encodeAvif(recording, options, stem, temp));
  const gif = join(options.out, `${stem}.gif`);
  console.log("  Trying 960px / 15fps GIF…");
  await ffmpeg([
    ...source,
    "-filter_complex",
    "fps=15,scale=960:-2:flags=lanczos,split[a][b];[a]palettegen=max_colors=192:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3",
    "-loop",
    "0",
    "-an",
    gif,
  ]);
  if ((await stat(gif)).size <= GIF_LIMIT) {
    rows.push(
      await output(
        gif,
        960,
        scaledHeight(recording, 960),
        (Math.ceil((durationMs * 15) / 1000) * 1000) / 15,
      ),
    );
    return rows;
  }
  console.log(
    `  Skipped GIF: ${((await stat(gif)).size / 1_000_000).toFixed(2)} MB exceeds 10 MB.`,
  );
  await rm(gif);
  return rows;
}

/** Each social card is its own designed page; it waits for its entrances to settle. */
async function socialCards(browser: Browser, options: Options, scale: number): Promise<Output[]> {
  const page = await browser.newPage({
    viewport: SOCIAL_CARD_VIEWPORT,
    deviceScaleFactor: scale,
    colorScheme: "dark",
  });
  try {
    const rows: Output[] = [];
    for (const [id, card] of Object.entries(SOCIAL_CARDS)) {
      const url = new URL(`/capture/og/${id}/`, options.baseUrl);
      const response = await page.goto(url.href, { waitUntil: "networkidle" });
      if (!response?.ok()) throw new Error(`Capture page returned ${response?.status()}: ${url}`);
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(1500);
      const file = join(options.out, card.file);
      await page.screenshot({ path: file });
      rows.push(
        await output(file, SOCIAL_CARD_VIEWPORT.width * scale, SOCIAL_CARD_VIEWPORT.height * scale),
      );
    }
    return rows;
  } finally {
    await page.close();
  }
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  if (!options) {
    console.log(help);
    return;
  }
  if (!options.og) await checkTools();
  await mkdir(options.out, { recursive: true });
  // CDP screencast uses Chromium's process scale, so each scale needs its own browser.
  const launch = (scale: number) =>
    chromium.launch({ headless: true, args: [`--force-device-scale-factor=${scale}`] });
  const rows: Output[] = [];
  if (options.og) {
    const scale = options.scale ?? 2;
    const browser = await launch(scale);
    try {
      rows.push(...(await socialCards(browser, options, scale)));
    } finally {
      await browser.close();
    }
  }
  for (const demo of options.og ? [] : options.demos) {
    const scale = options.scale ?? fitScale(CAPTURE_DEMOS[demo]);
    const browser = await launch(scale);
    try {
      const variants = options.locales.flatMap((locale) =>
        options.themes.map((theme) => ({ locale, theme })),
      );
      for (const { locale, theme } of variants) {
        const stem = locale === "zh-CN" ? `${demo}-zh-${theme}` : `${demo}-${theme}`;
        const temp = await mkdtemp(join(options.out, `.${stem}-`));
        try {
          const recording = await record(browser, options, scale, demo, locale, stem, theme, temp);
          rows.push(...(await encode(recording, options, stem, temp)));
        } finally {
          await rm(temp, { recursive: true, force: true });
        }
      }
    } finally {
      await browser.close();
    }
  }
  console.log(`\nOutputs: ${options.out}`);
  console.table(rows);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
