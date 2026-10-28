import { spawn } from "node:child_process";
import { copyFile, link, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, type Browser } from "playwright";
import { CAPTURE_DEMOS, type CaptureDemoId } from "../src/demos/capture-demos";

// Inside the checkout, where git ignores `*.local`, so recordings are never committed by accident.
const DEFAULT_OUT = fileURLToPath(
  new URL("../../../notes.local/artifacts/landing-captures", import.meta.url),
);
const MP4_LIMIT = 4_000_000;
const WEBP_LIMIT = 8_000_000;
const GIF_LIMIT = 10_000_000;

interface Options {
  readonly demos: readonly CaptureDemoId[];
  readonly themes: readonly ("dark" | "light")[];
  readonly baseUrl: string;
  readonly out: string;
  readonly fps: number;
  readonly scale: number;
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
  --base-url <url>      Default: http://127.0.0.1:4330
  --out <directory>     Default: ${DEFAULT_OUT}
  --fps <number>        Constant video frame rate, 1–60. Default: 30
  --scale <number>      Device scale factor, 1–4. Default: 2
  --og                 Only render the /capture/og/ social preview as og.png (1200×630 at --scale)
  --help               Show this help

Start the landing server separately. Requires Playwright Chromium, ffmpeg with
libx264/libvpx-vp9, and libwebp_anim/libwebp or the optional img2webp CLI.
No browser clock or animation time is mocked. Existing named outputs are replaced.
`;

export function parseOptions(args: readonly string[]): Options | undefined {
  const { values } = parseArgs({
    args: [...args],
    options: {
      demo: { type: "string", default: "all" },
      theme: { type: "string", default: "both" },
      "base-url": { type: "string", default: "http://127.0.0.1:4330" },
      out: { type: "string", default: DEFAULT_OUT },
      fps: { type: "string", default: "30" },
      scale: { type: "string", default: "2" },
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
  const theme = values.theme!;
  if (theme !== "both" && theme !== "dark" && theme !== "light") {
    throw new Error("--theme must be dark, light, or both.");
  }
  const fps = Number(values.fps);
  const scale = Number(values.scale);
  if (!Number.isInteger(fps) || fps < 1 || fps > 60)
    throw new Error("--fps must be an integer from 1 to 60.");
  if (!Number.isFinite(scale) || scale < 1 || scale > 4)
    throw new Error("--scale must be from 1 to 4.");
  const baseUrl = new URL(values["base-url"]!);
  if (!/^https?:$/.test(baseUrl.protocol)) throw new Error("--base-url must use HTTP or HTTPS.");
  return {
    demos:
      demo === "all" ? (Object.keys(CAPTURE_DEMOS) as CaptureDemoId[]) : [demo as CaptureDemoId],
    themes: theme === "both" ? ["dark", "light"] : [theme],
    baseUrl: baseUrl.href,
    out: resolve(values.out!),
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
const frameName = (index: number) => `${String(index).padStart(6, "0")}.jpg`;

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

async function checkTools(og: boolean): Promise<string | undefined> {
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
  if (og) return undefined;
  const encoders = await command("ffmpeg", ["-hide_banner", "-encoders"]);
  for (const encoder of ["libx264", "libvpx-vp9"]) {
    if (!encoders.includes(encoder))
      throw new Error(`ffmpeg lacks ${encoder}. Use Homebrew's ffmpeg-full build.`);
  }
  if (encoders.includes("libwebp_anim")) return "libwebp_anim";
  if (encoders.includes("libwebp")) return "libwebp";
  try {
    await command("img2webp", ["-version"]);
    console.log("ffmpeg lacks WebP encoding; using installed img2webp for animated WebP.");
    return undefined;
  } catch (error) {
    throw new Error(
      "Animated WebP needs libwebp in ffmpeg, or img2webp. Install with: brew install webp",
      { cause: error },
    );
  }
}

async function record(
  browser: Browser,
  options: Options,
  demo: CaptureDemoId,
  theme: "dark" | "light",
  directory: string,
): Promise<Recording> {
  const designed = CAPTURE_DEMOS[demo];
  const context = await browser.newContext({
    viewport: { width: designed.width + 80, height: designed.height + 80 },
    deviceScaleFactor: options.scale,
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
      `capture/${demo}/`,
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
    const expectedWidth = Math.round(viewport.width * options.scale);
    const expectedHeight = Math.round(viewport.height * options.scale);
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
      format: "jpeg",
      quality: 95,
      maxWidth: expectedWidth,
      maxHeight: expectedHeight,
      everyNthFrame: 1,
    });
    url.searchParams.set("capture", "");
    await page.goto(url.href);
    await page.waitForFunction(() => window.__nodexRecording !== undefined);
    const scriptedMs = await page.evaluate(() => window.__nodexRecording!.durationMs);
    console.log(
      `Recording ${demo}/${theme}: ${(scriptedMs / 1000).toFixed(2)}s, ${expectedWidth}×${expectedHeight}…`,
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
      theme,
      scriptedMs,
      durationMs,
      firstFrameDelayMs,
      sourceFrames: valid.length,
      largestFrameGapMs: Math.max(0, ...intervals),
      viewport,
      scale: options.scale,
      startMs: timing.startMs,
      frames: valid.map((frame) => frame.timestampMs - timing.startMs),
    };
    await writeFile(
      join(options.out, options.og ? "og-timing.json" : `${demo}-${theme}-timing.json`),
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
  return join(directory, "%06d.jpg");
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

async function encodeWebp(
  recording: Recording,
  options: Options,
  stem: string,
  temp: string,
  encoder: string | undefined,
): Promise<Output> {
  // 20fps has exact integer millisecond frame durations in WebP's timebase.
  const fps = Math.min(options.fps, 20);
  const width = Math.min(recording.width, 1200);
  const input = await sequence(recording, fps, join(temp, "webp-sequence"));
  const file = join(options.out, `${stem}.webp`);
  let webpFrames: string[] = [];
  if (!encoder) {
    const directory = join(temp, "webp-frames");
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
    webpFrames = (await readdir(directory)).sort().map((name) => join("webp-frames", name));
  }
  for (const quality of [80, 65, 50, 35]) {
    console.log(`  WebP: ${fps}fps, quality ${quality}…`);
    if (encoder) {
      await ffmpeg([
        "-framerate",
        String(fps),
        "-i",
        input,
        "-vf",
        `scale=${width}:-2:flags=lanczos`,
        "-c:v",
        encoder,
        "-lossless",
        "0",
        "-quality",
        String(quality),
        "-compression_level",
        "4",
        "-loop",
        "0",
        "-an",
        file,
      ]);
    } else {
      // img2webp splits its argument file on whitespace without shell quoting.
      // Relative paths keep --out directories with spaces safe and avoid ARG_MAX.
      const args = ["-loop", "0", "-lossy", "-q", String(quality), "-m", "4"];
      for (const [index, frame] of webpFrames.entries()) {
        const delay = Math.round(((index + 1) * 1000) / fps) - Math.round((index * 1000) / fps);
        args.push("-d", String(delay), frame);
      }
      args.push("-o", "encoded.webp");
      const argumentFile = join(temp, "webp-arguments.txt");
      await writeFile(argumentFile, args.join("\n"));
      await command("img2webp", [argumentFile], temp);
      await copyFile(join(temp, "encoded.webp"), file);
    }
    if ((await stat(file)).size <= WEBP_LIMIT)
      return await output(
        file,
        width,
        scaledHeight(recording, width),
        (Math.ceil((recording.durationMs * fps) / 1000) * 1000) / fps,
      );
  }
  await rm(file);
  throw new Error(
    `${stem}.webp exceeded 8 MB even at quality 35. Shorten the capture or reduce motion before publishing.`,
  );
}

async function encode(
  recording: Recording,
  options: Options,
  stem: string,
  temp: string,
  webpEncoder: string | undefined,
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
  rows.push(await encodeWebp(recording, options, stem, temp, webpEncoder));
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

/** The social preview is its own designed page; it waits for its entrances to settle. */
async function og(browser: Browser, options: Options): Promise<Output> {
  const page = await browser.newPage({
    viewport: { width: 1200, height: 630 },
    deviceScaleFactor: options.scale,
    colorScheme: "dark",
  });
  try {
    await page.goto(new URL("/capture/og/", options.baseUrl).href, { waitUntil: "networkidle" });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(1500);
    const file = join(options.out, "og.png");
    await page.screenshot({ path: file });
    return await output(file, 1200 * options.scale, 630 * options.scale);
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
  const webpEncoder = await checkTools(options.og);
  await mkdir(options.out, { recursive: true });
  const browser = await chromium.launch({
    headless: true,
    // CDP screencast otherwise uses Chromium's process scale (1×), even with a 2× context.
    args: [`--force-device-scale-factor=${options.scale}`],
  });
  const rows: Output[] = [];
  try {
    if (options.og) {
      rows.push(await og(browser, options));
    } else {
      for (const demo of options.demos) {
        for (const theme of options.themes) {
          const stem = `${demo}-${theme}`;
          const temp = await mkdtemp(join(options.out, `.${stem}-`));
          try {
            const recording = await record(browser, options, demo, theme, temp);
            rows.push(...(await encode(recording, options, stem, temp, webpEncoder)));
          } finally {
            await rm(temp, { recursive: true, force: true });
          }
        }
      }
    }
  } finally {
    await browser.close();
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
