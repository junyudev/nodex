import { readFileSync, readdirSync } from "node:fs";
import { extname, relative, resolve } from "node:path";
import { parseTypeScriptSource, sourcePosition } from "../lib/oxc-source";

const projectRoot = resolve(import.meta.dirname, "../..");
const sourceRoots = [resolve(projectRoot, "src"), resolve(projectRoot, "third_party/blocknote")];
const sourceExtensions = new Set([".css", ".cts", ".mts", ".ts", ".tsx"]);
const typedSourceExtensions = new Set([".cts", ".mts", ".ts", ".tsx"]);

const baseUiRoots = [
  "src/renderer/components/ui/",
  "third_party/blocknote/packages/shadcn/",
] as const;

const floatingUiAllowlist = new Set([
  "src/renderer/components/board/editor/nfm-floating-popover.tsx",
  "src/renderer/components/board/editor/nfm-blocknote-floating-ui.ts",
  "src/renderer/components/board/editor/nfm-editor-floating-positioning.test.ts",
  "src/renderer/components/board/editor/nfm-side-menu.tsx",
  "src/renderer/components/ui/hover-card.tsx",
  "third_party/blocknote/packages/react/src/components/AttributionTooltip/AttributionTooltipController.tsx",
  "third_party/blocknote/packages/react/src/components/Comments/FloatingComposerController.tsx",
  "third_party/blocknote/packages/react/src/components/Comments/FloatingThreadController.tsx",
  "third_party/blocknote/packages/react/src/components/FilePanel/FilePanelController.tsx",
  "third_party/blocknote/packages/react/src/components/FormattingToolbar/FormattingToolbarController.tsx",
  "third_party/blocknote/packages/react/src/components/LinkToolbar/LinkToolbarController.tsx",
  "third_party/blocknote/packages/react/src/components/Popovers/FloatingUIOptions.ts",
  "third_party/blocknote/packages/react/src/components/Popovers/GenericPopover.tsx",
  "third_party/blocknote/packages/react/src/components/SideMenu/SideMenuController.tsx",
  "third_party/blocknote/packages/react/src/components/SuggestionMenu/GridSuggestionMenu/GridSuggestionMenuController.tsx",
  "third_party/blocknote/packages/react/src/components/SuggestionMenu/SuggestionMenuController.tsx",
  "third_party/blocknote/packages/react/src/components/TableHandles/TableHandlesController.tsx",
  "third_party/blocknote/packages/react/src/components/TableHandles/hooks/useExtendButtonsPositioning.ts",
  "third_party/blocknote/packages/react/src/components/TableHandles/hooks/useTableHandlesPositioning.ts",
]);

const forbiddenImplementationTokens = [
  { pattern: /data-radix-/g, token: "data-radix-*" },
  { pattern: /--radix-/g, token: "--radix-*" },
  { pattern: /\basChild\b/g, token: "asChild" },
] as const;

function listSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return listSourceFiles(path);
    if (!entry.isFile() || !sourceExtensions.has(extname(path))) return [];
    return [path];
  });
}

function projectPath(path: string): string {
  return relative(projectRoot, path).replaceAll("\\", "/");
}

function isAllowedBaseUiImport(path: string): boolean {
  return baseUiRoots.some((root) => path.startsWith(root));
}

const failures: string[] = [];
let checkedSourceFiles = 0;

for (const absolutePath of sourceRoots.flatMap(listSourceFiles)) {
  const path = projectPath(absolutePath);
  const sourceText = readFileSync(absolutePath, "utf8");
  checkedSourceFiles += 1;

  for (const { pattern, token } of forbiddenImplementationTokens) {
    pattern.lastIndex = 0;
    for (const match of sourceText.matchAll(pattern)) {
      const { line, column } = sourcePosition(sourceText, match.index);
      failures.push(`${path}:${line}:${column} uses forbidden UI implementation token ${token}.`);
    }
  }

  if (!typedSourceExtensions.has(extname(absolutePath))) continue;
  const program = parseTypeScriptSource(path, sourceText);
  for (const statement of program.body) {
    if (statement.type !== "ImportDeclaration") continue;
    const moduleName = statement.source.value;
    const { line, column } = sourcePosition(sourceText, statement.start);
    if (moduleName.startsWith("@radix-ui/")) {
      failures.push(`${path}:${line}:${column} imports forbidden Radix module ${moduleName}.`);
      continue;
    }
    if (moduleName.startsWith("@base-ui/react") && !isAllowedBaseUiImport(path)) {
      failures.push(
        `${path}:${line}:${column} imports ${moduleName} outside the app-owned UI or vendored shadcn adapter boundary.`,
      );
      continue;
    }
    if (moduleName.startsWith("@floating-ui/react") && !floatingUiAllowlist.has(path)) {
      failures.push(
        `${path}:${line}:${column} imports ${moduleName} outside the audited geometry-owner allowlist.`,
      );
    }
  }
}

const manifest = JSON.parse(readFileSync(resolve(projectRoot, "package.json"), "utf8")) as Record<
  string,
  Record<string, unknown> | undefined
>;
for (const dependencyGroup of [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
] as const) {
  for (const dependencyName of Object.keys(manifest[dependencyGroup] ?? {})) {
    if (!dependencyName.startsWith("@radix-ui/")) continue;
    failures.push(`package.json declares forbidden direct dependency ${dependencyName}.`);
  }
}

const lockfileText = readFileSync(resolve(projectRoot, "pnpm-lock.yaml"), "utf8");
const importerText = lockfileText.match(/\nimporters:\n([\s\S]*?)\npackages:\n/)?.[1] ?? "";
if (/^\s+['"]?@radix-ui\//m.test(importerText)) {
  failures.push("pnpm-lock.yaml has a direct workspace importer for @radix-ui/*.");
}

let snapshotOwner = "";
let insideSnapshots = false;
const unexpectedRadixOwners = new Set<string>();
for (const line of lockfileText.split("\n")) {
  if (line === "snapshots:") {
    insideSnapshots = true;
    continue;
  }
  if (!insideSnapshots) continue;
  const snapshotMatch = line.match(/^ {2}(['"]?)(\S.+)\1:$/);
  if (snapshotMatch) {
    snapshotOwner = snapshotMatch[2];
    continue;
  }
  const radixDependency = line.match(/^ {6}['"]?(@radix-ui\/[^'":]+)['"]?:/);
  if (!radixDependency || snapshotOwner.startsWith("@radix-ui/")) continue;
  if (snapshotOwner.startsWith("@excalidraw/excalidraw@")) continue;
  unexpectedRadixOwners.add(`${snapshotOwner} -> ${radixDependency[1]}`);
}
for (const owner of unexpectedRadixOwners) {
  failures.push(`pnpm-lock.yaml has a non-Excalidraw entry into the Radix graph: ${owner}.`);
}

if (failures.length > 0) {
  throw new Error(["Renderer UI boundary verification failed:", ...failures].join("\n- "));
}

console.log(
  `Renderer UI boundaries verified across ${checkedSourceFiles} source files; Radix remains transitive to Excalidraw only.`,
);
