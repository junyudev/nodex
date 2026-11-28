import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { rolldown, type OutputChunk, type RolldownOptions } from "vite/rolldown";

import {
  readCombinedLegalFiles,
  readLegalDocuments,
  renderThirdPartyNotices,
  type ThirdPartyLegalEntry,
} from "../../../scripts/generate-third-party-notices";
import { PREVIEW_DATA_SLOT } from "../src/page/data";
import { PREVIEW_CSP } from "../src/server";

const root = new URL("../", import.meta.url);
const dist = new URL("dist/", root);

async function bundle(
  entry: string,
  options: Omit<RolldownOptions, "input">,
): Promise<OutputChunk> {
  const build = await rolldown({ ...options, input: fileURLToPath(new URL(entry, root)) });
  try {
    const format = options.platform === "node" ? "es" : "iife";
    const { output } = await build.generate({ format, codeSplitting: false, minify: true });
    const [chunk] = output;
    if (output.length !== 1 || chunk?.type !== "chunk") {
      throw new Error(`Expected one JavaScript bundle for ${entry}`);
    }
    if (format === "iife" && (chunk.imports.length || chunk.dynamicImports.length)) {
      throw new Error("The preview script must be self-contained");
    }
    return chunk;
  } finally {
    await build.close();
  }
}

function packageDirectories(chunks: readonly OutputChunk[]): string[] {
  const directories = new Set<string>();
  for (const chunk of chunks) {
    for (const [id, module] of Object.entries(chunk.modules)) {
      if (module.renderedLength === 0) continue;
      // The last node_modules segment is the package root in both flat and pnpm installs.
      const path = id.replaceAll("\\", "/");
      const dependency = path.match(/^(.*\/node_modules\/(?:@[^/]+\/)?[^/.][^/]*)(?=\/)/);
      if (dependency?.[1]) directories.add(dependency[1]);
    }
  }
  return [...directories];
}

async function npmNotice(directory: string): Promise<ThirdPartyLegalEntry> {
  const manifest = JSON.parse(await readFile(`${directory}/package.json`, "utf8")) as {
    name: string;
    version: string;
    homepage?: string;
    license?: string;
  };
  const identity = `${manifest.name}@${manifest.version}`;
  const legalText = await readLegalDocuments(directory);
  if (!legalText) throw new Error(`No license text found for ${identity}`);
  return {
    identity,
    license: manifest.license ?? "Not declared",
    homepage: manifest.homepage ?? null,
    legalText,
  };
}

async function notices(chunks: readonly OutputChunk[]): Promise<string> {
  const ccusage = dirname(fileURLToPath(import.meta.resolve("ccusage/package.json")));
  const geist = fileURLToPath(import.meta.resolve("@nodex/insights-cards/fonts/OFL.txt"));
  const entries = await Promise.all([...packageDirectories(chunks), ccusage].map(npmNotice));
  const legalText = await readCombinedLegalFiles([geist]);
  if (!legalText) throw new Error("No license text found for Geist");
  return renderThirdPartyNotices([
    ...entries,
    {
      identity: "Geist Sans and Geist Mono",
      license: "OFL-1.1",
      homepage: "https://github.com/vercel/geist-font",
      legalText,
    },
  ]);
}

function makeHtml(template: string, css: string, script: string): string {
  if (/<(?:!--|\/?script\b)/i.test(script) || /<\/style\b/i.test(css)) {
    throw new Error("The preview contains content unsafe to inline in HTML");
  }
  if (!template.includes(PREVIEW_DATA_SLOT)) throw new Error("Missing preview data script");
  return template
    .replace("<!-- preview-csp -->", () => PREVIEW_CSP)
    .replace("/* preview-styles */", () => css)
    .replace("/* preview-script */", () => script);
}

const [cli, page, template, css] = await Promise.all([
  bundle("src/cli.ts", {
    platform: "node",
    external: /^ccusage(?:\/|$)/,
    transform: { target: "node20" },
  }),
  bundle("src/page/main.ts", {
    platform: "browser",
    moduleTypes: { ".woff2": "dataurl" },
    transform: { target: "es2022" },
  }),
  readFile(new URL("src/page/template.html", root), "utf8"),
  readFile(new URL("src/page/styles.css", root), "utf8"),
]);

/**
 * `dist/` is the package as published: the bundle, its page and notices, and a manifest that keeps
 * only what an installer needs. Workspace links and build scripts stay behind.
 */
async function publishedManifest(): Promise<string> {
  const source = JSON.parse(await readFile(new URL("package.json", root), "utf8")) as Record<
    string,
    unknown
  >;
  const fields = [
    "name",
    "version",
    "description",
    "keywords",
    "homepage",
    "repository",
    "license",
    "type",
    "engines",
    "dependencies",
  ] as const;
  const manifest: Record<string, unknown> = Object.fromEntries(
    fields.filter((field) => source[field] !== undefined).map((field) => [field, source[field]]),
  );
  manifest.bin = { "nodex-insights": "./cli.js" };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

const html = makeHtml(template, css, page.code);
const legal = await notices([cli, page]);
await rm(dist, { recursive: true, force: true });
await mkdir(dist);
await Promise.all([
  writeFile(new URL("cli.js", dist), `#!/usr/bin/env node\n${cli.code}`, { mode: 0o755 }),
  writeFile(new URL("preview.html", dist), html),
  writeFile(new URL("THIRD_PARTY_NOTICES.txt", dist), legal),
  publishedManifest().then((manifest) => writeFile(new URL("package.json", dist), manifest)),
  ...["LICENSE", "NOTICE", "README.md"].map((file) =>
    copyFile(new URL(file, root), new URL(file, dist)),
  ),
]);
