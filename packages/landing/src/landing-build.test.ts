import { execFile } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { runInNewContext } from "node:vm";
import { motionValue } from "motion/react";
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parse } from "node-html-parser";
import {
  CHANGES_DIRECTORY,
  parseChangelog,
  readUnreleasedChanges,
} from "../../../src/shared/changelog";
import { decodeChangelogFeed } from "../../../src/shared/changelog-feed";
import { vitePlusCommand } from "../../../scripts/vite-plus-command";
import { afterAll, beforeAll, expect, test, vi } from "vite-plus/test";
import { ANDROID_LATEST_APK } from "../../../scripts/release/mobile";
import CaptureStage from "./demos/CaptureStage";
import { inlineHtml } from "./changelog";
import { CAPTURE_DEMOS, captureDemoPath, type CaptureDemoId } from "./demos/capture-demos";
import { GOOGLE_PLAY_URL, RELEASES_URL, windowsDownloadsAvailable } from "./lib/site";
import { SOCIAL_CARDS, type SocialCardId } from "./lib/social-cards";
import type { Timeline, TimelineScript } from "./demos/timeline";
import type { Stage } from "./replica/Stage";

// The build covers island wiring. Render each demo's last frame without a browser clock
// or width measurement so the test also covers the content behind that wiring.
vi.mock("./replica/Stage", () => ({
  Stage: ({ children }: ComponentProps<typeof Stage>) => children({ compact: false }),
}));

vi.mock("./demos/timeline", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./demos/timeline")>()),
  useTimeline: ({ cues, durationMs }: TimelineScript): Timeline => ({
    reached: (id) => cues.some((cue) => cue.id === id),
    elapsed: motionValue(durationMs),
    durationMs,
    loop: 0,
    playing: false,
    paused: false,
    still: true,
    toggle: () => {},
    seek: () => {},
  }),
}));

const landingRoot = resolve(import.meta.dirname, "..");
const repositoryRoot = resolve(landingRoot, "../..");
const generated = join(repositoryRoot, ".generated");
const publishedReleases = parseChangelog(
  readFileSync(join(repositoryRoot, "CHANGELOG.md"), "utf8"),
);
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
    // Resolve the installed CLI from the workspace. Astro uses --root to load the site.
    cwd: landingRoot,
    env: { ...process.env, ASTRO_TELEMETRY_DISABLED: "1" },
  });
}

beforeAll(() => buildSite(landingRoot, outputDir));

afterAll(() => {
  rmSync(outputDir, { force: true, recursive: true });
});

function readPage(route: string) {
  return parse(readFileSync(join(outputDir, route, "index.html"), "utf8"));
}

test("builds independently of unrelated ancestor TypeScript projects", async () => {
  const parent = mkdtempSync(join(generated, "landing-tsconfig-"));
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
    mkdirSync(join(root, "node_modules"));
    symlinkSync(
      realpathSync(join(landingRoot, "node_modules/astro")),
      join(root, "node_modules/astro"),
      "junction",
    );
    // Load the real config with its installed dependencies and build the fixture as its own site.
    const configUrl = pathToFileURL(join(landingRoot, "astro.config.mjs"));
    writeFileSync(
      join(root, "astro.config.mjs"),
      `export { default } from ${JSON.stringify(configUrl.href)};\n`,
    );
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ include: ["src"] }));
    writeFileSync(join(root, "src/pages/index.astro"), "<h1>Isolated site</h1>");

    await buildSite(root, outDir);

    expect(
      parse(readFileSync(join(outDir, "index.html"), "utf8")).querySelector("h1")?.textContent,
    ).toBe("Isolated site");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("the static build emits each public page with its canonical URL", () => {
  for (const [route, heading] of [
    ["", "One inbox. Every agent. All local."],
    ["zh-cn", "一个收件箱。 所有智能体。 一切存于本地。"],
    ["changelog", "Changelog"],
    ["download", "Download Nodex"],
    ["zh-cn/download", "下载 Nodex"],
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

test("each localized page links to its language counterpart and stays in language through downloads", () => {
  for (const [en, zh] of [
    ["", "zh-cn"],
    ["download", "zh-cn/download"],
  ] as const) {
    const enPath = en ? `/${en}/` : "/";
    const zhPath = `/${zh}/`;

    for (const [route, language, alternate, path] of [
      [en, "en", "zh-CN", zhPath],
      [zh, "zh-CN", "en", enPath],
    ] as const) {
      const page = readPage(route);
      expect(page.querySelector("html")?.getAttribute("lang")).toBe(language);
      expect(
        page.querySelector(`link[rel="alternate"][hreflang="${alternate}"]`)?.getAttribute("href"),
      ).toBe(`https://nodex.jyu.app${path}`);
      expect(page.querySelector(`nav a[hreflang="${alternate}"]`)?.getAttribute("href")).toBe(
        `${path}?lang=${alternate}`,
      );
    }
  }

  const home = readPage("zh-cn");
  expect(home.querySelector('nav a[href="/zh-cn/download/"]')).not.toBeNull();
  expect(home.querySelector('a[href="/zh-cn/download/#mobile"]')).not.toBeNull();
  expect(readPage("zh-cn/download").getElementById("mobile")).not.toBeNull();
});

test.each([
  {
    route: "",
    locale: "en",
    pauseLabel: "Pause demo",
    expected: {
      hero: "Dashboard cold start",
      fanout: "Passkey sign-in",
      agents: "Context handoff",
      pages: "Board",
      tidy: "Triage",
      mobile: "Passkey prompt flicker",
    },
  },
  {
    route: "zh-cn",
    locale: "zh-CN",
    pauseLabel: "暂停演示",
    expected: {
      hero: "仪表盘冷启动",
      fanout: "通行密钥登录",
      agents: "上下文交接",
      pages: "看板",
      tidy: "待分流",
      mobile: "通行密钥提示闪烁",
    },
  },
] as const)(
  "the $locale homepage hydrates each demo in its own language",
  ({ route, locale, pauseLabel, expected }) => {
    const page = readPage(route);
    const demos = page.querySelectorAll("astro-island");
    expect(demos).toHaveLength(Object.keys(CAPTURE_DEMOS).length);
    for (const demo of demos) {
      // Stage draws its content after measuring its width in the browser.
      const props = JSON.parse(demo.getAttribute("props") ?? "{}") as { locale?: [number, string] };
      expect(props.locale?.[1]).toBe(locale);
      expect(demo.closest("[lang]")?.getAttribute("lang")).toBe(locale);
    }
    expect(page.querySelector("[data-hero] astro-island button")?.textContent.trim()).toBe(
      pauseLabel,
    );
    if (locale === "zh-CN") expect(page.querySelector("div[lang=en]")).toBeNull();

    for (const demo of Object.keys(CAPTURE_DEMOS) as CaptureDemoId[]) {
      const rendered = parse(renderToStaticMarkup(createElement(CaptureStage, { demo, locale })));
      expect(rendered.textContent, demo).toContain(expected[demo]);
    }
  },
);

test("the homepage follows browser language until the visitor chooses a language", () => {
  const site = "https://nodex.jyu.app";
  const storage = new Map<string, string>();
  let dataset: Record<string, string> = {};

  function visit(path: string, browserLanguage: string, storageBlocked = false, referrer = "") {
    const url = new URL(path, site);
    const page = readPage(url.pathname.slice(1));
    const script = page.getElementById("site-language");
    if (!script) throw new Error(`Missing language startup script on ${path}`);
    dataset = {};
    const root = { lang: page.querySelector("html")?.getAttribute("lang"), dataset };
    const checkStorage = () => {
      if (storageBlocked) throw new Error("Storage blocked");
    };
    let current = url.href;
    const setUrl = (target: URL) => {
      current = target.href;
    };
    runInNewContext(script.rawText, {
      URL,
      document: { documentElement: root, referrer },
      navigator: { language: browserLanguage },
      location: { href: current, replace: setUrl },
      history: { replaceState: (_state: unknown, _title: string, target: URL) => setUrl(target) },
      localStorage: {
        getItem: (key: string) => {
          checkStorage();
          return storage.get(key);
        },
        setItem: (key: string, value: string) => {
          checkStorage();
          storage.set(key, value);
        },
      },
    });
    return new URL(current).href;
  }

  expect(visit("/", "en-US")).toBe(`${site}/`);
  expect(visit("/?utm_source=post#demo", "zh-TW", true)).toBe(
    `${site}/zh-cn/?utm_source=post&from=#demo`,
  );
  // The redirect carries only the referrer's origin, and the destination keeps it for analytics
  // instead of reporting the homepage it came through as an internal visit.
  expect(visit("/", "zh-CN", true, "https://www.v2ex.com/t/1?x=1")).toBe(
    `${site}/zh-cn/?from=https%3A%2F%2Fwww.v2ex.com`,
  );
  expect(visit("/zh-cn/?from=https%3A%2F%2Fwww.v2ex.com", "zh-CN")).toBe(`${site}/zh-cn/`);
  expect(dataset.languageReferrer).toBe("https://www.v2ex.com");
  expect(visit("/?lang=en", "zh-CN", true)).toBe(`${site}/?lang=en`);
  expect(visit("/download/?lang=en", "zh-CN")).toBe(`${site}/download/`);
  expect(visit("/", "zh-CN")).toBe(`${site}/`);
  expect(visit("/zh-cn/?lang=zh-CN", "en-US")).toBe(`${site}/zh-cn/`);
  expect(visit("/", "en-US")).toBe(`${site}/zh-cn/?from=`);
});

test("the release stamp matches the latest dated changelog release", () => {
  const [latest] = publishedReleases;

  expect(readPage("").querySelector(".landing-version-label")?.textContent).toBe(
    `v${latest?.version}`,
  );
});

const RELEASE_ALIASES = {
  macos: "https://github.com/junyudev/nodex/releases/latest/download/Nodex-latest-arm64.dmg",
  "windows-x64":
    "https://github.com/junyudev/nodex/releases/latest/download/Nodex-latest-windows-x64.exe",
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
  const links = {
    ...RELEASE_ALIASES,
    ...MOBILE_LISTINGS,
    ...(GOOGLE_PLAY_URL ? { "google-play": GOOGLE_PLAY_URL } : {}),
  };

  const mobile = [...Object.keys(MOBILE_LISTINGS), ...(GOOGLE_PLAY_URL ? ["google-play"] : [])];
  for (const [route, offered] of [
    ["", desktop],
    ["zh-cn", desktop],
    ["download", [...desktop, ...mobile]],
    ["zh-cn/download", [...desktop, ...mobile]],
  ] as const) {
    const page = readPage(route);
    for (const [target, href] of Object.entries(links)) {
      const downloads = page.querySelectorAll(`a[href="${href}"]`);
      expect(downloads.length > 0, `${route} offers ${target}`).toBe(offered.includes(target));
      for (const link of downloads) {
        expect(link.getAttribute("data-download")).toBe(target);
      }
    }
    const releases = page.querySelectorAll(`a[href="${RELEASES_URL}"]`);
    for (const link of releases) {
      expect(link.getAttribute("data-download")).toBe("github-releases");
    }
    const copies = page.querySelectorAll(".landing-brew-copy");
    expect(copies.length).toBeGreaterThan(0);
    for (const copy of copies) {
      expect(copy.getAttribute("data-download")).toBe("homebrew");
      expect(copy.getAttribute("data-command")).toBe("brew install --cask junyudev/tap/nodex");
      expect(copy.parentNode?.querySelector("code")?.textContent).toBe(
        "brew install --cask junyudev/tap/nodex",
      );
    }
  }
});

// Download intent counts actions that obtain Nodex. Opening the download page is already a page view,
// so counting it here as well would inflate conversion.
test("links to the download page are not counted as download intent", () => {
  for (const route of ["", "zh-cn", "download", "zh-cn/download", "changelog"]) {
    const target = route.startsWith("zh-cn") ? "/zh-cn/download/" : "/download/";
    const links = readPage(route).querySelectorAll(
      `a[href="${target}"]:not([hreflang]), a[href="${target}#mobile"]`,
    );
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(link.hasAttribute("data-download")).toBe(false);
    }
  }
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
    ...Object.keys(CAPTURE_DEMOS).flatMap((demo) => [`capture/${demo}`, `zh-cn/capture/${demo}`]),
    ...Object.keys(SOCIAL_CARDS).map((id) => `capture/og/${id}`),
  ]) {
    expect(
      readPage(route).querySelector('meta[name="robots"]')?.getAttribute("content"),
      route,
    ).toBe("noindex");
  }
  const robots = readFileSync(join(outputDir, "robots.txt"), "utf8");
  expect(robots).toContain("Disallow: /capture/");
  expect(robots).toContain("Disallow: /zh-cn/capture/");
});

test.each(Object.keys(CAPTURE_DEMOS) as CaptureDemoId[])(
  "the %s capture pages render their matching demo and locale",
  (demo) => {
    for (const locale of ["en", "zh-CN"] as const) {
      const page = readPage(captureDemoPath(demo, locale));
      expect(page.querySelector("html")?.getAttribute("lang")).toBe(locale);
      expect(page.querySelector("[data-capture-root]")).not.toBeNull();
      const props = JSON.parse(page.querySelector("astro-island")?.getAttribute("props") ?? "{}");
      expect(props.demo?.[1]).toBe(demo);
      expect(props.locale?.[1]).toBe(locale);
    }
  },
);

test("the changelog leads with the repository's unreleased changes, then every published release", () => {
  const changeFiles = readdirSync(join(repositoryRoot, CHANGES_DIRECTORY), {
    recursive: true,
    withFileTypes: true,
  })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const path = join(entry.parentPath, entry.name);
      return {
        path: relative(repositoryRoot, path).replaceAll("\\", "/"),
        content: readFileSync(path, "utf8"),
      };
    });
  const unreleased = readUnreleasedChanges(changeFiles).flatMap(({ entries }) => entries);
  const releases = readPage("changelog").querySelectorAll("article[data-release]");
  const status = (release: (typeof releases)[number]) =>
    release.querySelector("[data-release-status]")?.textContent.trim();
  const dated = releases.filter((release) => release.id !== "unreleased");

  expect(dated.map(({ id }) => id)).toEqual(publishedReleases.map(({ version }) => `v${version}`));
  expect(releases.filter((release) => status(release) === "Latest")).toEqual([dated[0]]);

  if (unreleased.length === 0) {
    expect(releases).toEqual(dated);
    return;
  }
  const [first] = releases;
  expect(first?.id).toBe("unreleased");
  expect(first?.querySelector("h2")?.textContent.trim()).toBe("Unreleased");
  expect(first && status(first)).toBe("In development");
  const normalize = (text: string) => text.replace(/\s+/gu, " ").trim();
  expect(
    first?.querySelectorAll("section li").map((entry) => normalize(entry.textContent)),
  ).toEqual(unreleased.map((entry) => normalize(parse(inlineHtml(entry)).textContent)));
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

test("the published changelog JSON uses the same headlines and anchors as the page", () => {
  const rawFeed: unknown = JSON.parse(readFileSync(join(outputDir, "changelog.json"), "utf8"));
  const feed = decodeChangelogFeed(rawFeed);
  expect(feed).toEqual(rawFeed);
  const datedReleases = readPage("changelog")
    .querySelectorAll("article[data-release]")
    .filter(({ id }) => id !== "unreleased");
  expect(feed.releases.map(({ url, headline }) => [new URL(url).hash.slice(1), headline])).toEqual(
    datedReleases
      .slice(0, 12)
      .map((release) => [release.id, release.querySelector("h2")?.textContent.trim()]),
  );
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
