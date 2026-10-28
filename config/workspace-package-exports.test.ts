import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { expect, test } from "vite-plus/test";

type ExportTarget = string | null | { readonly [condition: string]: ExportTarget };

const ROOT = path.resolve(import.meta.dirname, "..");
const SCRIPT_TARGET = /\.[cm]?[jt]sx?$/u;

function workspaceManifests(): readonly string[] {
  const workspace = readFileSync(path.join(ROOT, "pnpm-workspace.yaml"), "utf8");
  const globs = [...workspace.matchAll(/^ {2}- "([^"]+)"$/gmu)].map(
    ([, glob]) => `${glob}/package.json`,
  );
  return execFileSync("git", ["ls-files", "--", ...globs], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
}

/** The file an ESM import would load; conditional entries without one are not scripts. */
function importTarget(target: ExportTarget): string | null {
  if (typeof target === "string" || target === null) return target;
  return importTarget(target.import ?? target.default ?? null);
}

function scriptEntries(exports: Record<string, ExportTarget>) {
  const subpathMap = Object.keys(exports).some((key) => key.startsWith("."));
  return Object.entries(subpathMap ? exports : { ".": exports }).flatMap(([subpath, target]) => {
    const file = importTarget(target);
    return !subpath.includes("*") && file && SCRIPT_TARGET.test(file) ? [{ subpath, file }] : [];
  });
}

// Development seeding and other Node-direct tools load workspace source through CommonJS
// `require`; an entry reachable only through the `import` condition breaks them at startup.
test("every workspace script export resolves for CommonJS consumers", () => {
  const unresolved: string[] = [];
  let checked = 0;
  for (const manifest of workspaceManifests()) {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, manifest), "utf8")) as {
      readonly name?: string;
      readonly exports?: Record<string, ExportTarget>;
    };
    if (!pkg.name || !pkg.exports || typeof pkg.exports !== "object") continue;
    const packageDir = path.dirname(path.join(ROOT, manifest));
    const require = createRequire(path.join(packageDir, "package.json"));
    for (const { subpath, file } of scriptEntries(pkg.exports)) {
      checked += 1;
      const specifier = `${pkg.name}${subpath.slice(1)}`;
      try {
        expect(require.resolve(specifier)).toBe(path.join(packageDir, file));
      } catch {
        unresolved.push(specifier);
      }
    }
  }
  expect(checked).toBeGreaterThan(0);
  expect(unresolved).toEqual([]);
});
