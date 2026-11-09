import { execFile } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { parse } from "node-html-parser";
import { vitePlusCommand } from "../../../scripts/vite-plus-command";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import { ANDROID_LATEST_APK } from "../../../scripts/release/mobile";
import { windowsDownloadsAvailable } from "./lib/site";
import { SOCIAL_CARDS, type SocialCardId } from "./lib/social-cards";

const landingRoot = resolve(import.meta.dirname, "..");
const generated = resolve(landingRoot, "../../.generated");
mkdirSync(generated, { recursive: true });
const outputDir = mkdtempSync(join(generated, "landing-build-"));
const execFileAsync = promisify(execFile);

async function buildSite(root: string, outDir: string) {
  // Build the way the site ships, through the package's astro bin: it is what lets Astro resolve
  // its own tsconfig presets, whatever environment the tests run in. Its own process also keeps
  // Vite's module loader outside Vitest.
  const invocation = vitePlusCommand([
    "exec",
    "astro",
    "build",
    "--root",
    root,
    "--outDir",
    outDir,
  ]);
  await execFileAsync(invocation.command, invocation.args, {
    cwd: root,
    env: { ...process.env, ASTRO_TELEMETRY_DISABLED: "1" },
  });
}

beforeAll(() => buildSite(landingRoot, outputDir), 60_000);

afterAll(() => {
  rmSync(outputDir, { force: true, recursive: true });
});

function readPage(route: string) {
  return parse(readFileSync(join(outputDir, route, "index.html"), "utf8"));
}

test("builds independently of unrelated ancestor TypeScript projects", async () => {
  const parent = mkdtempSync(join(tmpdir(), "nodex-landing-tsconfig-"));
  const root = join(parent, "site");
  const outDir = join(root, "dist");
  try {
    mkdirSync(join(parent, "mobile"));
    writeFileSync(
      join(parent, "tsconfig.json"),
      JSON.stringify({ files: [], references: [{ path: "./mobile" }] }),
    );
    writeFileSync(
      join(parent, "mobile/tsconfig.json"),
      JSON.stringify({ extends: "uninstalled-platform/tsconfig.json" }),
    );
    mkdirSync(join(root, "src/pages"), { recursive: true });
    symlinkSync(join(landingRoot, "node_modules"), join(root, "node_modules"), "junction");
    copyFileSync(resolve(landingRoot, "../../.node-version"), join(root, ".node-version"));
    for (const file of ["astro.config.mjs", "tsconfig.json", "package.json"])
      copyFileSync(join(landingRoot, file), join(root, file));
    writeFileSync(join(root, "src/pages/index.astro"), "<h1>Isolated site</h1>");

    await buildSite(root, outDir);

    expect(
      parse(readFileSync(join(outDir, "index.html"), "utf8")).querySelector("h1")?.textContent,
    ).toBe("Isolated site");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
}, 60_000);

test("the static build emits each public page with its canonical URL", () => {
  for (const [route, heading] of [
    ["", "One inbox. Every agent. All local."],
    ["changelog", "Changelog"],
    ["download", "Download Nodex"],
    ["privacy", "Privacy"],
    ["terms", "Terms"],
  ]) {
    const page = readPage(route);
    const pathname = route ? `/${route}/` : "/";

    expect(page.querySelector("h1")?.textContent.replace(/\s+/g, " ").trim()).toBe(heading);
    expect(page.querySelector('link[rel="canonical"]')?.getAttribute("href")).toBe(
      `https://nodex.jyu.app${pathname}`,
    );
  }
});

test("the release stamp equals the root app version", () => {
  const packageJson = JSON.parse(
    readFileSync(resolve(landingRoot, "../../package.json"), "utf8"),
  ) as { version: string };

  expect(readPage("").querySelector(".landing-version-label")?.textContent).toBe(
    `v${packageJson.version}`,
  );
});

const RELEASE_ALIASES = {
  macos: "https://github.com/junyudev/nodex/releases/latest/download/Nodex-latest-arm64.dmg",
  "windows-x64":
    "https://github.com/junyudev/nodex/releases/latest/download/Nodex-latest-windows-x64.exe",
  "windows-arm64":
    "https://github.com/junyudev/nodex/releases/latest/download/Nodex-latest-windows-arm64.exe",
} as const;

// The APK alias is the one every stable Release Bundle must carry, so the link can never dangle.
const MOBILE_LISTINGS = {
  ios: "https://testflight.apple.com/join/Yz8Kpcty",
  android: `https://github.com/junyudev/nodex/releases/latest/download/${ANDROID_LATEST_APK}`,
} as const;

test("downloads and the copy control use the public install contracts", () => {
  const { version } = JSON.parse(
    readFileSync(resolve(landingRoot, "../../package.json"), "utf8"),
  ) as { version: string };
  const desktop = windowsDownloadsAvailable(version) ? Object.keys(RELEASE_ALIASES) : ["macos"];
  const links = { ...RELEASE_ALIASES, ...MOBILE_LISTINGS };

  for (const [route, offered] of [
    ["", desktop],
    ["download", [...desktop, ...Object.keys(MOBILE_LISTINGS)]],
  ] as const) {
    const page = readPage(route);
    const downloads = page.querySelectorAll("a[data-download]");
    const targets = new Set(downloads.map((link) => link.getAttribute("data-download")));

    expect(targets).toEqual(new Set(offered));
    for (const link of downloads) {
      const target = link.getAttribute("data-download") as keyof typeof links;
      expect(link.getAttribute("href")).toBe(links[target]);
    }
    const copies = page.querySelectorAll(".landing-brew-copy");
    expect(copies.length).toBeGreaterThan(0);
    for (const copy of copies) {
      expect(copy.getAttribute("data-command")).toBe("brew install --cask junyudev/tap/nodex");
      expect(copy.parentNode?.querySelector("code")?.textContent).toBe(
        "brew install --cask junyudev/tap/nodex",
      );
    }
  }
  const navigation = readPage("").querySelector('nav[aria-label="Primary"]');
  expect(
    navigation
      ?.querySelectorAll("a")
      .find((link) => link.textContent.trim() === "Download")
      ?.getAttribute("href"),
  ).toBe("/download/");
});

test("the homepage sends someone after the phone app to its listings on the download page", () => {
  const [path, anchor] = readPage("")
    .querySelector('a[href$="#mobile"]')
    ?.getAttribute("href")
    ?.split("#") ?? ["", ""];
  const listings = readPage(path!.replaceAll("/", ""))
    .getElementById(anchor!)
    ?.querySelectorAll("a[data-download]");

  expect(listings?.map((link) => link.getAttribute("data-download"))).toEqual(
    Object.keys(MOBILE_LISTINGS),
  );
});

test("every public page shares a complete preview, declaring its image's real size", () => {
  const cards: Readonly<Record<string, SocialCardId>> = {
    "": "home",
    download: "download",
    changelog: "changelog",
    privacy: "home",
    terms: "home",
  };

  for (const [route, id] of Object.entries(cards)) {
    const page = readPage(route);
    const tag = (name: string) =>
      page.querySelector(`meta[property="${name}"], meta[name="${name}"]`)?.getAttribute("content");
    const card = SOCIAL_CARDS[id];
    const image = `https://nodex.jyu.app/${card.file}`;
    const png = readFileSync(join(outputDir, card.file));

    expect(tag("og:site_name"), route).toBe("Nodex");
    expect(tag("og:url"), route).toBe(
      route ? `https://nodex.jyu.app/${route}/` : "https://nodex.jyu.app/",
    );
    expect(tag("og:image"), route).toBe(image);
    expect(tag("og:image:alt"), route).toBe(card.alt);
    expect(tag("twitter:card"), route).toBe("summary_large_image");
    expect(tag("twitter:image"), route).toBe(image);
    expect(tag("twitter:image:alt"), route).toBe(card.alt);
    // A PNG stores its width and height at these offsets of its first chunk.
    expect(tag("og:image:width"), route).toBe(String(png.readUInt32BE(16)));
    expect(tag("og:image:height"), route).toBe(String(png.readUInt32BE(20)));
  }
});

test("the home social card shows one Inbox sending messages to different places and models", () => {
  const page = readPage("capture/og/home");
  const distinct = (selector: string) =>
    new Set(page.querySelectorAll(selector).map((element) => element.textContent.trim())).size;

  expect(distinct('[data-cursor-target^="decision:"]')).toBeGreaterThanOrEqual(3);
  expect(distinct('[data-cursor-target^="model:"]')).toBeGreaterThanOrEqual(3);
  expect(page.querySelector('[aria-label="Send to Inbox"]')).not.toBeNull();
});

test("demo and social card capture pages stay out of search results", () => {
  for (const route of [
    "capture/hero",
    ...Object.keys(SOCIAL_CARDS).map((id) => `capture/og/${id}`),
  ]) {
    expect(
      readPage(route).querySelector('meta[name="robots"]')?.getAttribute("content"),
      route,
    ).toBe("noindex");
  }
  expect(readFileSync(join(outputDir, "robots.txt"), "utf8")).toContain("Disallow: /capture/");
});

test("the changelog marks the app's version as Latest, after any release in development", () => {
  const packageJson = JSON.parse(
    readFileSync(resolve(landingRoot, "../../package.json"), "utf8"),
  ) as { version: string };
  const releases = readPage("changelog").querySelectorAll("article[data-release]");
  const status = (release: (typeof releases)[number]) =>
    release.querySelector("[data-release-status]")?.textContent.trim();
  const dated = releases.filter((release) => release.id !== "unreleased");

  expect(dated[0]?.id).toBe(`v${packageJson.version}`);
  expect(releases.filter((release) => status(release) === "Latest")).toEqual([dated[0]]);
  expect(
    releases
      .filter((release) => release.id === "unreleased")
      .every((release) => release === releases[0] && status(release) === "In development"),
  ).toBe(true);
});

test("every release in the changelog rail jumps to that release", () => {
  const page = readPage("changelog");
  const releases = new Set(
    page.querySelectorAll("article[data-release]").map((release) => release.id),
  );
  const links = page.querySelectorAll("[data-release-link]");

  expect(links.length).toBe(releases.size);
  for (const link of links) {
    expect(releases.has(link.getAttribute("href")?.slice(1) ?? "")).toBe(true);
  }
});

test("the build preserves the custom domain and public asset bytes", () => {
  expect(readFileSync(join(outputDir, "CNAME"), "utf8").trim()).toBe("nodex.jyu.app");

  for (const asset of [
    "CNAME",
    ".nojekyll",
    "robots.txt",
    ...Object.values(SOCIAL_CARDS).map((card) => card.file),
    "favicon.png",
    "nodex-icon.svg",
    "nodex-icon.png",
    "fonts/geist-sans.woff2",
    "fonts/geist-mono.woff2",
  ]) {
    expect(
      readFileSync(join(outputDir, asset)).equals(readFileSync(join(landingRoot, "public", asset))),
      asset,
    ).toBe(true);
  }
});
