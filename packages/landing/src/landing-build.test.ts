import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { parse } from "node-html-parser";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";

const landingRoot = resolve(import.meta.dirname, "..");
const outputDir = mkdtempSync(join(tmpdir(), "nodex-landing-build-"));
const execFileAsync = promisify(execFile);

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const astroPackagePath = require.resolve("astro/package.json");
  const astroPackage = JSON.parse(readFileSync(astroPackagePath, "utf8")) as {
    bin: { astro: string };
  };
  const astroCli = resolve(dirname(astroPackagePath), astroPackage.bin.astro);

  // Run the real CLI in its own process so Vite's module loader stays outside Vitest.
  await execFileAsync(
    process.execPath,
    [astroCli, "build", "--root", landingRoot, "--outDir", outputDir],
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
    ["", "Nodex"],
    ["changelog", "Changelog"],
    ["privacy", "Privacy"],
    ["terms", "Terms"],
  ]) {
    const page = readPage(route);
    const pathname = route ? `/${route}/` : "/";

    expect(page.querySelector("h1")?.textContent).toBe(heading);
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

  expect(page.querySelector("#landing-download-button")?.getAttribute("href")).toBe(
    "https://github.com/junyudev/nodex/releases/latest/download/Nodex-latest-arm64.dmg",
  );
  expect(page.querySelector(".landing-brew-copy")?.getAttribute("data-command")).toBe(
    "brew install --cask junyudev/tap/nodex",
  );
  expect(page.querySelector("code")?.textContent).toBe("brew install --cask junyudev/tap/nodex");
});

test("the changelog starts with Unreleased and its in-development status", () => {
  const firstRelease = readPage("changelog").querySelector(".changelog-feed article");

  expect(firstRelease?.id).toBe("unreleased");
  expect(firstRelease?.querySelector("h2")?.textContent).toBe("Unreleased");
  expect(firstRelease?.querySelector("header p")?.textContent).toBe("In development");
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
