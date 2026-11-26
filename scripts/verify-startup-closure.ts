import path from "node:path";
import { measureMainPreWindowClosure, measureWorkbenchClosure } from "./lib/startup-closure";

// Budgets sit about 2% above the measured closure. Raising one is a deliberate decision
// recorded with the change that needs the bytes, never a reaction to a failed build.
const MAX_WORKBENCH_JAVASCRIPT_BYTES = Math.round(10.99 * 1024 * 1024);
const MAX_WORKBENCH_CSS_BYTES = 712 * 1024;
/** What Main evaluates before its startup window; the application graph loads behind the window. */
const MAX_MAIN_PRE_WINDOW_BYTES = Math.round(1.28 * 1024 * 1024);
// Packages the Main build leaves external, native addons among them, load from node_modules and
// cost nothing in the byte budget. Only these may load before the startup window.
const MAIN_PRE_WINDOW_PACKAGES: readonly string[] = [
  "@formatjs/intl",
  "@sentry/electron",
  "electron",
];

// Packages whose surfaces load them on demand. None may enter the ordinary Workbench.
const ON_DEMAND_PACKAGES = [
  "@excalidraw/excalidraw",
  "@sentry/core",
  "@sentry/react",
  "@sentry/replay",
  "@streamdown/code",
  "@xterm/xterm",
  "cytoscape",
  "elkjs",
  "mermaid",
  "pdfjs-dist",
  "shiki",
] as const;

const workbench = measureWorkbenchClosure({
  rendererDirectory: path.resolve("out/renderer"),
  rootChunkName: "application-renderer",
  onDemandPackages: ON_DEMAND_PACKAGES,
});
// The bootstrap entry only enables the compile cache, then requires the Main application.
const main = measureMainPreWindowClosure(path.resolve("out/main"), "main-process.js");

process.stdout.write(
  `${JSON.stringify(
    {
      workbench: {
        root: workbench.root,
        javaScript: { ...workbench.javaScript, budgetBytes: MAX_WORKBENCH_JAVASCRIPT_BYTES },
        css: { ...workbench.css, budgetBytes: MAX_WORKBENCH_CSS_BYTES },
        onDemandPackages: Object.fromEntries(workbench.onDemandPackageFiles),
      },
      mainPreWindow: {
        files: main.files,
        bytes: main.bytes,
        budgetBytes: MAX_MAIN_PRE_WINDOW_BYTES,
        packages: main.packages.map(({ packageName }) => packageName),
      },
    },
    null,
    2,
  )}\n`,
);

const failures = [
  ...workbench.violations.map(
    (violation) =>
      `${violation.packageName} (${violation.modules} modules) is statically reachable: ${violation.chain.join(" -> ")}`,
  ),
  ...[...workbench.onDemandPackageFiles]
    .filter(([, files]) => files.length === 0)
    .map(([name]) => `${name} no longer appears in the renderer build; update the on-demand list`),
  ...(workbench.javaScript.bytes > MAX_WORKBENCH_JAVASCRIPT_BYTES
    ? [
        `Workbench JavaScript is ${workbench.javaScript.bytes} bytes (budget ${MAX_WORKBENCH_JAVASCRIPT_BYTES})`,
      ]
    : []),
  ...(workbench.css.bytes > MAX_WORKBENCH_CSS_BYTES
    ? [`Workbench CSS is ${workbench.css.bytes} bytes (budget ${MAX_WORKBENCH_CSS_BYTES})`]
    : []),
  ...main.packages
    .filter(({ packageName }) => !MAIN_PRE_WINDOW_PACKAGES.includes(packageName))
    .map(
      ({ packageName, chain }) =>
        `${packageName} loads before Main's first window: ${chain.join(" -> ")}`,
    ),
  ...MAIN_PRE_WINDOW_PACKAGES.filter(
    (name) => !main.packages.some(({ packageName }) => packageName === name),
  ).map((name) => `${name} no longer loads before Main's first window; update the allowed list`),
  ...(main.bytes > MAX_MAIN_PRE_WINDOW_BYTES
    ? [
        `Main code before the first window is ${main.bytes} bytes (budget ${MAX_MAIN_PRE_WINDOW_BYTES})`,
      ]
    : []),
];
if (failures.length > 0) {
  throw new Error(
    `Startup closure check failed:\n${failures.map((line) => `  ${line}`).join("\n")}`,
  );
}
