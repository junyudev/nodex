import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";

const rendererDirectory = path.resolve("out/renderer");
const htmlPath = path.join(rendererDirectory, "index.html");
const obsoleteStartupPreloadPath = path.resolve("out/preload/application-startup.js");
const MAX_INLINE_HTML_BYTES = 24 * 1024;
const MAX_BOOTSTRAP_JAVASCRIPT_GZIP_BYTES = 20 * 1024;

function invariant(condition: unknown, message: string): asserts condition {
  if (condition) return;
  throw new Error(`Renderer bootstrap artifact check failed: ${message}`);
}

function resolveAsset(assetPath: string): string {
  return path.resolve(rendererDirectory, assetPath.replace(/^\.\//, ""));
}

const html = readFileSync(htmlPath, "utf8");
const entryMatch = html.match(/<script[^>]+type="module"[^>]+src="([^"]+\.js)"/u);
const modulePreloads = [...html.matchAll(/<link[^>]+rel="modulepreload"[^>]+href="([^"]+)"/gu)].map(
  ([, assetPath]) => assetPath,
);

invariant(entryMatch?.[1], "index.html has no module entry");
invariant(html.includes('class="nodex-startup-shell"'), "parser-time startup shell is absent");
invariant(html.includes('class="nodex-startup-logo-base"'), "base logo is absent");
invariant(html.includes("data-startup-visible-status"), "visible status node is absent");
invariant(!/<link[^>]+rel="stylesheet"/u.test(html), "external CSS is loaded before the gate");
invariant(
  modulePreloads.every((assetPath) =>
    path.basename(assetPath).startsWith("renderer-bootstrap-runtime-"),
  ),
  `unexpected eager module preload: ${modulePreloads.join(", ")}`,
);
invariant(
  Buffer.byteLength(html) <= MAX_INLINE_HTML_BYTES,
  `inline HTML is ${Buffer.byteLength(html)} bytes (budget ${MAX_INLINE_HTML_BYTES})`,
);
invariant(!existsSync(obsoleteStartupPreloadPath), "obsolete startup preload was emitted");

const classicScripts = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+\.js)"[^>]*>/gu)]
  .filter(([tag]) => !/\btype="module"/u.test(tag))
  .map(([, assetPath]) => assetPath);
const eagerJavaScriptPaths = [entryMatch[1], ...modulePreloads, ...classicScripts].map(
  resolveAsset,
);
const eagerJavaScript = eagerJavaScriptPaths.map((assetPath) => readFileSync(assetPath));
const eagerJavaScriptGzipBytes = eagerJavaScript.reduce(
  (total, source) => total + gzipSync(source).byteLength,
  0,
);
invariant(
  eagerJavaScriptGzipBytes <= MAX_BOOTSTRAP_JAVASCRIPT_GZIP_BYTES,
  `eager JavaScript is ${eagerJavaScriptGzipBytes} gzip bytes (budget ${MAX_BOOTSTRAP_JAVASCRIPT_GZIP_BYTES})`,
);

const entrySource = eagerJavaScript[0].toString("utf8");
const staticImports = [
  ...entrySource.matchAll(/^import\s.+?from\s*"([^"]+)";?$/gmu),
  ...entrySource.matchAll(/^import\s*"([^"]+)";?$/gmu),
].map(([, specifier]) => specifier);
invariant(
  staticImports.every((specifier) =>
    path.basename(specifier).startsWith("renderer-bootstrap-runtime-"),
  ),
  `renderer entry has an unexpected static dependency: ${staticImports.join(", ")}`,
);

process.stdout.write(
  `${JSON.stringify(
    {
      eagerJavaScript: eagerJavaScriptPaths.map((assetPath) =>
        path.relative(process.cwd(), assetPath),
      ),
      eagerJavaScriptGzipBytes,
      inlineHtmlBytes: Buffer.byteLength(html),
      classicScripts,
      modulePreloads,
    },
    null,
    2,
  )}\n`,
);
