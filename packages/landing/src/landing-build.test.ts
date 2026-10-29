import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { parse } from "node-html-parser";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";

const landingRoot = resolve(import.meta.dirname, "..");
const outputDir = mkdtempSync(join(tmpdir(), "nodex-landing-build-"));
const execFileAsync = promisify(execFile);

beforeAll(async () => {
  // Build the way the site ships, through the package's astro bin: it is what lets Astro resolve
  // its own tsconfig presets, whatever environment the tests run in. Its own process also keeps
  // Vite's module loader outside Vitest.
  await execFileAsync(
    join(landingRoot, "node_modules", ".bin", "astro"),
    ["build", "--root", landingRoot, "--outDir", outputDir],
    {
      cwd: landingRoot,
      env: { ...process.env, ASTRO_TELEMETRY_DISABLED: "1" },
    },
  );
}, 60_000);

afterAll(() => {
  rmSync(outputDir, { force: true, recursive: true });
});

function readPage(route: string) {
  return parse(readFileSync(join(outputDir, route, "index.html"), "utf8"));
}

test("the static build emits each public page with its canonical URL", () => {
  for (const [route, heading] of [
    ["", "One inbox. Every agent. All local."],
    ["changelog", "Changelog"],
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

test("downloads and the copy control use the public install contracts", () => {
  const page = readPage("");

  const downloads = page.querySelectorAll("a[data-download]");
  const copies = page.querySelectorAll(".landing-brew-copy");

  expect(downloads.length).toBeGreaterThan(0);
  for (const link of downloads) {
    expect(link.getAttribute("href")).toBe(
      "https://github.com/junyudev/nodex/releases/latest/download/Nodex-latest-arm64.dmg",
    );
  }
  expect(copies.length).toBeGreaterThan(0);
  for (const copy of copies) {
    expect(copy.getAttribute("data-command")).toBe("brew install --cask junyudev/tap/nodex");
    expect(copy.parentNode?.querySelector("code")?.textContent).toBe(
      "brew install --cask junyudev/tap/nodex",
    );
  }
});

test("demo capture pages stay out of search results", () => {
  expect(
    readPage("capture/hero").querySelector('meta[name="robots"]')?.getAttribute("content"),
  ).toBe("noindex");
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
    "og.png",
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
