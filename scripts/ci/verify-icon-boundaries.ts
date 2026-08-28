import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import {
  Visitor,
  type ImportDeclaration,
  type JSXAttribute,
  type JSXElement,
  type JSXElementName,
  type Program,
} from "oxc-parser";
import { parseTypeScriptSource, sourcePosition } from "../lib/oxc-source";

const projectRoot = resolve(import.meta.dirname, "../..");
const rendererRoot = resolve(
  process.env.ICON_BOUNDARY_RENDERER_ROOT ?? resolve(projectRoot, "src/renderer"),
);
const sharedIconRoot = resolve(rendererRoot, "components/shared/icons");
const genericIconModule = resolve(sharedIconRoot, "generic-icons.tsx");
const inlineSvgBaselinePath = resolve(
  process.env.ICON_BOUNDARY_BASELINE_PATH ??
    resolve(import.meta.dirname, "icon-inline-svg-baseline.json"),
);
const writeGeometryBaseline = process.argv.includes("--update-geometry-baseline");

const sourceExtensions = new Set([".ts", ".tsx"]);
const iconSizeClassPattern = /\bicon-(?:3xs|xxs|2xs|xs|sm|base|md|lg)\b/;
const iconComponentNamePattern = /Icon$/;
const allowedInlineSvgReasonPattern =
  /diagram|data[- ]?mark|favicon|progress|brand|vendor|test[- ]?fixture|fixture|illustration|logo/i;
const allowedInlineSvgPathPattern =
  /(?:^|[-/_.])(?:diagram|data[-_]?mark|favicon|progress|brand|vendor)(?:[-/_.]|$)/i;
const geometryAttributeNames = new Set([
  "viewBox",
  "fill",
  "stroke",
  "strokeWidth",
  "strokeLinecap",
  "strokeLinejoin",
  "strokeMiterlimit",
  "strokeDasharray",
  "strokeDashoffset",
  "fillRule",
  "clipRule",
  "fillOpacity",
  "strokeOpacity",
  "opacity",
  "transform",
  "vectorEffect",
  "preserveAspectRatio",
  "d",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "width",
  "height",
  "x",
  "y",
  "x1",
  "x2",
  "y1",
  "y2",
  "points",
  "pathLength",
  "rotate",
  "offset",
  "stopColor",
  "stopOpacity",
  "clipPath",
  "mask",
  "filter",
]);
const ignoredGeometryAttributeNames = new Set([
  "class",
  "className",
  "aria-hidden",
  "aria-label",
  "aria-labelledby",
  "focusable",
  "xmlns",
  "role",
  "data-testid",
]);

interface InlineSvgException {
  readonly count: number;
  readonly reason: string;
}

type InlineSvgBaselineEntry = number | InlineSvgException;

interface GeometryBaselineGroup {
  readonly signature: string;
  readonly owners: readonly string[];
  readonly reason: string;
}

interface IconBaseline {
  readonly inlineSvg: Record<string, InlineSvgBaselineEntry>;
  readonly geometry: readonly GeometryBaselineGroup[];
}

interface SourceDeclaration {
  readonly name: string;
  readonly start: number;
  readonly end: number;
}

interface GeometryOccurrence {
  readonly owner: string;
  readonly signature: string;
  readonly line: number;
}

interface GenericImportBinding {
  readonly importedName: string;
  readonly localName: string;
  readonly identity: string;
  readonly line: number;
}

interface GenericExportBinding {
  readonly name: string;
  readonly sourceLocalName: string | null;
  readonly line: number;
}

function readBaseline(): IconBaseline {
  const raw = JSON.parse(readFileSync(inlineSvgBaselinePath, "utf8")) as unknown;
  if (!isRecord(raw) || !isRecord(raw.inlineSvg) || !Array.isArray(raw.geometry)) {
    throw new Error(
      "scripts/ci/icon-inline-svg-baseline.json must contain inlineSvg and geometry sections.",
    );
  }

  const inlineSvg: Record<string, InlineSvgBaselineEntry> = {};
  for (const [path, value] of Object.entries(raw.inlineSvg)) {
    if (typeof value === "number") {
      if (!Number.isInteger(value) || value < 0) {
        throw new Error(`Invalid inline SVG count for ${path}.`);
      }
      inlineSvg[path] = value;
      continue;
    }
    if (!isRecord(value) || typeof value.count !== "number" || typeof value.reason !== "string") {
      throw new Error(`Inline SVG exception ${path} must provide count and reason.`);
    }
    if (!Number.isInteger(value.count) || value.count < 0 || value.reason.trim().length === 0) {
      throw new Error(`Inline SVG exception ${path} must provide a non-negative count and reason.`);
    }
    inlineSvg[path] = { count: value.count, reason: value.reason.trim() };
  }

  const geometrySignatures = new Set<string>();
  const geometry = raw.geometry.map((value, index) => {
    if (!isRecord(value)) throw new Error(`Invalid geometry baseline entry at index ${index}.`);
    if (
      typeof value.signature !== "string" ||
      value.signature.trim().length === 0 ||
      !Array.isArray(value.owners) ||
      value.owners.some((owner) => typeof owner !== "string") ||
      typeof value.reason !== "string" ||
      value.reason.trim().length === 0
    ) {
      throw new Error(
        `Geometry baseline entry ${index} must provide signature, owners, and reason.`,
      );
    }
    const owners = [...new Set(value.owners)] as string[];
    if (owners.length < 2) {
      throw new Error(`Geometry baseline entry ${index} must describe at least two owners.`);
    }
    if (geometrySignatures.has(value.signature)) {
      throw new Error(`Geometry baseline repeats signature ${value.signature}.`);
    }
    geometrySignatures.add(value.signature);
    return {
      signature: value.signature,
      owners,
      reason: value.reason.trim(),
    } satisfies GeometryBaselineGroup;
  });

  return { inlineSvg, geometry };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function listSourceFiles(directory: string): string[] {
  return readdirSync(directory)
    .sort()
    .flatMap((entry) => {
      const path = resolve(directory, entry);
      const stats = statSync(path);
      if (stats.isDirectory()) return listSourceFiles(path);
      if (![...sourceExtensions].some((extension) => path.endsWith(extension))) return [];
      return [path];
    });
}

function projectPath(path: string): string {
  return relative(projectRoot, path).split(sep).join("/");
}

function isGenericIconImport(path: string, moduleName: string): boolean {
  if (moduleName === "@/components/shared/icons/generic-icons") return true;
  if (!moduleName.startsWith(".")) return false;
  const candidate = resolve(dirname(path), moduleName);
  return [candidate, `${candidate}.ts`, `${candidate}.tsx`].includes(genericIconModule);
}

function importedNames(declaration: ImportDeclaration): Array<{ imported: string; local: string }> {
  return declaration.specifiers.flatMap((specifier) => {
    if (specifier.type !== "ImportSpecifier") return [];
    const imported =
      specifier.imported.type === "Identifier" ? specifier.imported.name : specifier.imported.value;
    return [{ imported, local: specifier.local.name }];
  });
}

function normalizeLucideIdentity(importedName: string): string {
  return importedName.endsWith("Icon") ? importedName.slice(0, -"Icon".length) : importedName;
}

function getIdentifierName(node: unknown): string | null {
  if (!isRecord(node) || node.type !== "Identifier" || typeof node.name !== "string") return null;
  return node.name;
}

function getJsxName(node: JSXElementName): string {
  if (node.type === "JSXIdentifier") return node.name;
  if (node.type === "JSXNamespacedName") return `${node.namespace.name}:${node.name.name}`;
  return `${getJsxName(node.object)}.${node.property.name}`;
}

function getAttributeName(attribute: JSXAttribute): string | null {
  if (attribute.name.type === "JSXIdentifier") return attribute.name.name;
  return `${attribute.name.namespace.name}:${attribute.name.name.name}`;
}

function collectStaticBindings(program: Program, sourceText: string): Map<string, string> {
  const bindings = new Map<string, string>();
  new Visitor({
    VariableDeclarator(node) {
      const name = getIdentifierName(node.id);
      if (!name || !node.init) return;
      if (
        node.init.type === "Literal" &&
        (typeof node.init.value === "string" || typeof node.init.value === "number")
      ) {
        bindings.set(name, String(node.init.value));
        return;
      }
      if (node.init.type !== "TemplateLiteral" || node.init.expressions.length > 0) return;
      bindings.set(name, sourceText.slice(node.init.start + 1, node.init.end - 1));
    },
  }).visit(program);
  return bindings;
}

function staticExpressionValue(
  expression: unknown,
  bindings: ReadonlyMap<string, string>,
): string | null {
  if (!isRecord(expression) || typeof expression.type !== "string") return null;
  if (
    expression.type === "Literal" &&
    (typeof expression.value === "string" || typeof expression.value === "number")
  ) {
    return String(expression.value);
  }
  if (expression.type === "Identifier" && typeof expression.name === "string") {
    return bindings.get(expression.name) ?? null;
  }
  return null;
}

function attributeValue(
  attribute: JSXAttribute,
  sourceText: string,
  bindings: ReadonlyMap<string, string>,
): { readonly value: string; readonly complete: boolean } {
  if (attribute.value === null) return { value: "true", complete: true };
  if (attribute.value.type === "Literal") {
    const value = attribute.value.value;
    if (typeof value === "string" || typeof value === "number") {
      return { value: String(value), complete: true };
    }
    return { value: String(value), complete: false };
  }
  if (attribute.value.type !== "JSXExpressionContainer") {
    return { value: sourceText.slice(attribute.value.start, attribute.value.end), complete: false };
  }
  const expression = attribute.value.expression;
  const staticValue = staticExpressionValue(expression, bindings);
  if (staticValue !== null) return { value: staticValue, complete: true };
  return {
    value: sourceText.slice(expression.start, expression.end).replace(/\s+/g, " "),
    complete: false,
  };
}

function serializeGeometryElement(
  element: JSXElement,
  sourceText: string,
  bindings: ReadonlyMap<string, string>,
  isRoot = true,
): { readonly value: string; readonly complete: boolean } {
  const name = getJsxName(element.openingElement.name);
  let complete = true;
  const attributes = element.openingElement.attributes.flatMap((attribute) => {
    if (attribute.type !== "JSXAttribute") {
      complete = false;
      return [];
    }
    const attributeName = getAttributeName(attribute);
    if (!attributeName || ignoredGeometryAttributeNames.has(attributeName)) return [];
    if (!geometryAttributeNames.has(attributeName)) return [];
    if (isRoot && (attributeName === "width" || attributeName === "height")) return [];
    const resolved = attributeValue(attribute, sourceText, bindings);
    complete &&= resolved.complete;
    return [{ name: attributeName, value: resolved.value, complete: resolved.complete }];
  });
  const children = element.children.flatMap((child) => {
    if (child.type === "JSXElement") {
      return [serializeGeometryElement(child, sourceText, bindings, false)];
    }
    if (child.type === "JSXText" && child.value.trim().length === 0) return [];
    complete = false;
    return [];
  });
  attributes.sort((left, right) => left.name.localeCompare(right.name));
  return {
    value: JSON.stringify({
      name,
      attributes: attributes.map(({ name: attributeName, value }) => [attributeName, value]),
      children: children.map((child) => child.value),
    }),
    complete:
      complete &&
      attributes.every((attribute) => attribute.complete) &&
      children.every((child) => child.complete),
  };
}

function collectDeclarations(program: Program): SourceDeclaration[] {
  const declarations: SourceDeclaration[] = [];
  new Visitor({
    FunctionDeclaration(node) {
      const name = getIdentifierName(node.id);
      if (name && iconComponentNamePattern.test(name)) {
        declarations.push({ name, start: node.start, end: node.end });
      }
    },
    ClassDeclaration(node) {
      const name = getIdentifierName(node.id);
      if (name && iconComponentNamePattern.test(name)) {
        declarations.push({ name, start: node.start, end: node.end });
      }
    },
    VariableDeclarator(node) {
      const name = getIdentifierName(node.id);
      if (name && iconComponentNamePattern.test(name)) {
        declarations.push({ name, start: node.start, end: node.end });
      }
    },
  }).visit(program);
  return declarations;
}

function collectGeometryOccurrences(
  program: Program,
  sourceText: string,
  path: string,
): GeometryOccurrence[] {
  const bindings = collectStaticBindings(program, sourceText);
  const declarations = collectDeclarations(program);
  const svgElements: JSXElement[] = [];
  new Visitor({
    JSXElement(node) {
      if (getJsxName(node.openingElement.name) === "svg") svgElements.push(node);
    },
  }).visit(program);

  return svgElements.flatMap((element) => {
    const declaration = declarations
      .filter((candidate) => candidate.start <= element.start && candidate.end >= element.end)
      .sort((left, right) => left.end - left.start - (right.end - right.start))[0];
    if (!declaration) return [];
    const serialized = serializeGeometryElement(element, sourceText, bindings);
    if (!serialized.complete) return [];
    const signature = createHash("sha256").update(serialized.value).digest("hex").slice(0, 16);
    return [
      {
        owner: `${projectPath(path)}#${declaration.name}`,
        signature,
        line: sourcePosition(sourceText, element.start).line,
      },
    ];
  });
}

function exportedNames(program: Program): string[] {
  return program.body.flatMap((statement) => {
    if (statement.type !== "ExportNamedDeclaration") return [];
    const declaration = statement.declaration;
    if (!declaration) {
      return statement.specifiers.flatMap((specifier) => {
        if (specifier.exported.type === "Identifier") return [specifier.exported.name];
        return [specifier.exported.value];
      });
    }
    if (
      declaration.type === "FunctionDeclaration" ||
      declaration.type === "ClassDeclaration" ||
      declaration.type === "TSTypeAliasDeclaration" ||
      declaration.type === "TSInterfaceDeclaration" ||
      declaration.type === "TSEnumDeclaration"
    ) {
      const name = getIdentifierName(declaration.id);
      return name ? [name] : [];
    }
    if (declaration.type !== "VariableDeclaration") return [];
    return declaration.declarations.flatMap((item) => {
      const name = getIdentifierName(item.id);
      return name ? [name] : [];
    });
  });
}

function collectGenericBindings(
  program: Program,
  sourceText: string,
): { imports: GenericImportBinding[]; exports: GenericExportBinding[] } {
  const imports: GenericImportBinding[] = [];
  const exports: GenericExportBinding[] = [];
  for (const statement of program.body) {
    if (statement.type === "ImportDeclaration" && statement.source.value === "lucide-react") {
      for (const { imported, local } of importedNames(statement)) {
        imports.push({
          importedName: imported,
          localName: local,
          identity: normalizeLucideIdentity(imported),
          line: sourcePosition(sourceText, statement.start).line,
        });
      }
      continue;
    }
    if (statement.type !== "ExportNamedDeclaration") continue;
    const declaration = statement.declaration;
    if (!declaration || declaration.type !== "VariableDeclaration") continue;
    for (const item of declaration.declarations) {
      const name = getIdentifierName(item.id);
      if (!name) continue;
      let sourceLocalName: string | null = null;
      if (
        item.init?.type === "CallExpression" &&
        item.init.callee.type === "Identifier" &&
        item.init.callee.name === "createGenericIcon"
      ) {
        const firstArgument = item.init.arguments[0];
        if (firstArgument?.type !== "SpreadElement") {
          sourceLocalName = getIdentifierName(firstArgument ?? null);
        }
      }
      exports.push({
        name,
        sourceLocalName,
        line: sourcePosition(sourceText, item.start).line,
      });
    }
  }
  return { imports, exports };
}

function verifySharedIconIntrinsicSizing(
  sourceFile: Program,
  sourceText: string,
  path: string,
  failures: string[],
): void {
  new Visitor({
    JSXOpeningElement(node) {
      if (node.name.type !== "JSXIdentifier" || node.name.name !== "svg") return;

      const attributes = node.attributes.filter(
        (attribute): attribute is JSXAttribute => attribute.type === "JSXAttribute",
      );
      const className = attributes.find(
        (attribute) =>
          attribute.name.type === "JSXIdentifier" && attribute.name.name === "className",
      );
      const classNameSource = className ? sourceText.slice(className.start, className.end) : "";
      if (!iconSizeClassPattern.test(classNameSource)) return;

      const attributeNames = new Set(
        attributes.map((attribute) =>
          attribute.name.type === "JSXIdentifier" ? attribute.name.name : "",
        ),
      );
      if (attributeNames.has("width") && attributeNames.has("height")) return;

      failures.push(
        `${projectPath(path)}:${sourcePosition(sourceText, node.start).line} gives a shared SVG an icon-* default without intrinsic width and height.`,
      );
    },
  }).visit(sourceFile);
}

function baselineCount(entry: InlineSvgBaselineEntry | undefined): number {
  if (typeof entry === "number") return entry;
  return entry?.count ?? 0;
}

function baselineReason(entry: InlineSvgBaselineEntry | undefined): string | null {
  return typeof entry === "number" ? null : (entry?.reason ?? null);
}

function isTestFixturePath(path: string): boolean {
  return /\.(?:test|spec|stories)\.[cm]?[jt]sx?$/.test(path);
}

function verifyInlineSvgBoundary(
  sourceFile: Program,
  sourceText: string,
  path: string,
  baseline: IconBaseline,
  failures: string[],
): number {
  const inlineSvgCount = sourceText.match(/<svg\b/g)?.length ?? 0;
  if (inlineSvgCount === 0) return 0;
  const relativePath = projectPath(path);
  const entry = baseline.inlineSvg[relativePath];
  const allowedCount = baselineCount(entry);
  const reason = baselineReason(entry);
  if (!entry) {
    failures.push(
      `${relativePath} introduces ${inlineSvgCount} inline SVG${inlineSvgCount === 1 ? "" : "s"}; add a baseline entry with an explicit reason only for a reviewed diagram/data mark/favicon/progress/brand/vendor/test fixture exception.`,
    );
  } else if (inlineSvgCount !== allowedCount) {
    const direction = inlineSvgCount > allowedCount ? "exceeds" : "is below";
    failures.push(
      `${relativePath} contains ${inlineSvgCount} inline SVG${inlineSvgCount === 1 ? "" : "s"}; baseline ${allowedCount} ${direction} the current count. Update or remove the stale baseline entry after reviewing the change.`,
    );
  }

  const declarations = collectDeclarations(sourceFile);
  const iconNamesWithInlineSvg = declarations
    .filter((declaration) => /<svg\b/.test(sourceText.slice(declaration.start, declaration.end)))
    .map((declaration) => declaration.name);
  if (iconNamesWithInlineSvg.length === 0) return inlineSvgCount;

  const isAllowedException =
    isTestFixturePath(relativePath) ||
    allowedInlineSvgPathPattern.test(relativePath) ||
    iconNamesWithInlineSvg.some((name) =>
      /(?:Diagram|Mark|Favicon|Progress|Brand|Vendor|ThirdParty|Logo|Illustration)(?:Icon)?$/.test(
        name,
      ),
    );
  const isNewOrChanged = !entry || inlineSvgCount > allowedCount;
  if (
    isNewOrChanged &&
    (!reason || !isAllowedException || !allowedInlineSvgReasonPattern.test(reason))
  ) {
    failures.push(
      `${relativePath} defines reusable ${iconNamesWithInlineSvg.join(", ")} with new inline SVG geometry; move it to components/shared/icons or provide an explicit reason for a diagram/data mark/favicon/progress/brand/vendor/test fixture exception.`,
    );
  }
  return inlineSvgCount;
}

function verifyInlineSvgBaselineCompleteness(
  actualInlineSvgCounts: ReadonlyMap<string, number>,
  baseline: IconBaseline,
  failures: string[],
  reports: string[],
): void {
  for (const [path, entry] of Object.entries(baseline.inlineSvg)) {
    const actualCount = actualInlineSvgCounts.get(path) ?? 0;
    if (actualCount > 0) continue;
    reports.push(
      `stale inline SVG baseline: ${path} (${baselineCount(entry)} recorded, 0 present)`,
    );
    failures.push(`baseline contains stale inline SVG entry ${path}; remove it from the baseline.`);
  }
}

function verifyGenericLucideDuplicates(
  imports: readonly GenericImportBinding[],
  exports: readonly GenericExportBinding[],
  failures: string[],
): void {
  const importsByLocalName = new Map(imports.map((binding) => [binding.localName, binding]));
  const importsByIdentity = new Map<string, GenericImportBinding[]>();
  for (const binding of imports) {
    const current = importsByIdentity.get(binding.identity) ?? [];
    current.push(binding);
    importsByIdentity.set(binding.identity, current);
  }
  const exportsByIdentity = new Map<string, GenericExportBinding[]>();
  for (const binding of exports) {
    if (!binding.sourceLocalName) continue;
    const importBinding = importsByLocalName.get(binding.sourceLocalName);
    if (!importBinding) continue;
    const current = exportsByIdentity.get(importBinding.identity) ?? [];
    current.push(binding);
    exportsByIdentity.set(importBinding.identity, current);
  }
  for (const [identity, importBindings] of importsByIdentity) {
    const exportBindings = exportsByIdentity.get(identity) ?? [];
    if (importBindings.length < 2 && exportBindings.length < 2) continue;
    const importedNames = importBindings.map((binding) => binding.importedName).join(" / ");
    const exportedNames = exportBindings.map((binding) => binding.name).join(" / ");
    failures.push(
      `generic-icons.tsx repeats lucide-react component ${identity} through imports ${importedNames || "(none)"}${exportedNames ? ` and exports ${exportedNames}` : ""}; keep one generic adapter and migrate semantic aliases to app-owned icons.`,
    );
  }
}

function verifyGenericUsage(
  genericExports: readonly GenericExportBinding[],
  usedGenericIcons: ReadonlySet<string>,
  failures: string[],
): void {
  for (const binding of genericExports) {
    if (usedGenericIcons.has(binding.name)) continue;
    failures.push(
      `generic-icons.tsx exports unused ${binding.name}; keep the generic adapter curated to active call sites.`,
    );
  }
}

function verifyGenericAppNameConflicts(
  genericExports: readonly GenericExportBinding[],
  appOwnedNames: ReadonlyMap<string, string[]>,
  failures: string[],
): void {
  for (const binding of genericExports) {
    const owners = appOwnedNames.get(binding.name);
    if (!owners || owners.length === 0) continue;
    failures.push(
      `generic export ${binding.name} conflicts with app-owned export(s) ${owners.join(", ")}; public icon names must have one owner across the shared icon boundary.`,
    );
  }
}

function collectGeometryGroups(
  occurrences: readonly GeometryOccurrence[],
): Array<{ signature: string; owners: string[]; locations: string[] }> {
  const groups = new Map<string, { owners: Set<string>; locations: string[] }>();
  for (const occurrence of occurrences) {
    const group = groups.get(occurrence.signature) ?? { owners: new Set(), locations: [] };
    group.owners.add(occurrence.owner);
    group.locations.push(`${occurrence.owner}:${occurrence.line}`);
    groups.set(occurrence.signature, group);
  }
  return [...groups.entries()]
    .filter(([, group]) => group.owners.size > 1)
    .map(([signature, group]) => ({
      signature,
      owners: [...group.owners].sort(),
      locations: [...new Set(group.locations)].sort(),
    }))
    .sort((left, right) => left.signature.localeCompare(right.signature));
}

function verifyGeometryGroups(
  groups: readonly { signature: string; owners: string[]; locations: string[] }[],
  baseline: IconBaseline,
  failures: string[],
  reports: string[],
): void {
  const known = baseline.geometry;
  for (const group of groups) {
    const matchingBaseline = known.find(
      (entry) =>
        entry.signature === group.signature &&
        group.owners.every((owner) => entry.owners.includes(owner)),
    );
    reports.push(
      `exact geometry collision ${group.signature}: ${group.owners.join(", ")} (${matchingBaseline ? "baseline alias" : "new"})`,
    );
    if (matchingBaseline) continue;
    failures.push(
      `new exact geometry collision ${group.signature} at ${group.locations.join(", ")}; share one private glyph and declare semantic aliases in icon-inline-svg-baseline.json before landing.`,
    );
  }

  for (const entry of known) {
    const currentGroup = groups.find((group) => group.signature === entry.signature);
    if (!currentGroup) {
      reports.push(
        `stale geometry baseline ${entry.signature}: ${entry.owners.join(", ")} (${entry.reason})`,
      );
      continue;
    }
    const currentOwners = new Set(currentGroup.owners);
    const baselineOwners = new Set(entry.owners);
    if (
      currentOwners.size === baselineOwners.size &&
      [...currentOwners].every((owner) => baselineOwners.has(owner))
    ) {
      continue;
    }
    reports.push(
      `geometry baseline owner drift ${entry.signature}: baseline ${entry.owners.join(", ")}; current ${currentGroup.owners.join(", ")} (${entry.reason})`,
    );
  }
}

function geometryReason(owners: readonly string[]): string {
  const names = owners.map((owner) => owner.slice(owner.lastIndexOf("#") + 1));
  const has = (...tokens: string[]) => tokens.every((token) => names.includes(token));

  if (has("CreatedTaskIcon", "ProjectTaskIcon")) {
    return "Activity and project task wrappers retain distinct product semantics while sharing the task-bubble glyph.";
  }
  if (has("DownloadIcon", "SettingsImportIcon")) {
    return "Download and settings-import wrappers retain distinct product semantics while sharing the transfer glyph.";
  }
  if (has("ExpandPanelIcon", "ProjectCollapseAllIcon")) {
    return "Panel expansion and project collapse actions retain opposite workflow semantics while sharing the directional glyph.";
  }
  if (
    names.some((name) =>
      ["SidePanelSideChatIcon", "SidebarCreatedIcon", "SlashSideIcon"].includes(name),
    )
  ) {
    return "Sidebar, side-panel, and slash-command surfaces retain context-specific semantics while sharing the side-chat glyph.";
  }
  if (has("ShortcutResetIcon", "ImageUndoIcon")) {
    return "Shortcut reset and image undo wrappers retain distinct actions while sharing the undo glyph.";
  }
  if (
    names.some((name) =>
      ["AutomationMoreIcon", "ProjectActionsIcon", "QueuePendingInfoIcon"].includes(name),
    )
  ) {
    return "Automation, project-action, and queued-work surfaces retain distinct semantics while sharing the more-actions glyph.";
  }
  if (has("NfmSideMenuCommentIcon", "TextActionCommentIcon")) {
    return "NFM side-menu and text-action wrappers retain editor-specific semantics while sharing the comment glyph.";
  }
  if (has("NfmSideMenuTextBlockIcon", "TextActionNormalTextIcon")) {
    return "NFM text-block and normal-text wrappers retain editor-specific semantics while sharing the text-block glyph.";
  }
  if (has("LinkToolbarDeleteIcon", "NfmSideMenuDeleteIcon")) {
    return "Link-toolbar and NFM delete actions retain host-specific semantics while sharing the delete glyph.";
  }
  if (has("ActivitySearchIcon", "SettingsSearchIcon")) {
    return "Activity and settings search wrappers retain domain-specific semantics while sharing the search glyph.";
  }
  if (has("BrowserExternalIcon", "ProjectOpenActionIcon")) {
    return "Browser and project open actions retain host-specific semantics while sharing the external-open glyph.";
  }
  if (has("ComputerUseIcon", "SettingsComputerUseIcon")) {
    return "Activity and settings computer-use wrappers retain domain-specific semantics while sharing the computer-use glyph.";
  }
  if (has("PlanSidePanelOpenIcon", "ProjectReopenPreviousIcon")) {
    return "Plan side-panel and project reopen actions retain host-specific semantics while sharing the open glyph.";
  }
  if (has("TerminalActivityIcon", "SidePanelTerminalIcon")) {
    return "Activity and side-panel terminal wrappers retain host-specific semantics while sharing the terminal glyph.";
  }
  if (has("ComposerPlanModeCloseIcon", "GoalClearIcon")) {
    return "Composer plan-mode close and goal-clear actions retain workflow-specific semantics while sharing the clear glyph.";
  }
  if (
    has("PanelLeftVisibleIcon", "PanelRightHiddenIcon") ||
    has("PanelLeftHiddenIcon", "PanelRightVisibleIcon")
  ) {
    return "Panel state wrappers express opposite directions with shared visibility geometry; public names preserve target-state semantics.";
  }
  if (has("PermissionDefaultIcon", "SettingsAgentIcon")) {
    return "Permission-default and settings-agent wrappers retain policy and settings semantics while sharing the agent glyph.";
  }
  if (has("SkillIcon", "SlashSkillIcon")) {
    return "Activity and slash-command skill wrappers retain host-specific semantics while sharing the skill glyph.";
  }
  if (has("BrowserAnnotateIcon", "ImageCommentIcon")) {
    return "Browser annotation and image comment wrappers retain host-specific semantics while sharing the comment-plus glyph.";
  }
  if (has("SidePanelReviewIcon", "ReviewDisableWordDiffsIcon")) {
    return "Review side-panel and diff word-disable actions retain review-specific semantics while sharing the review glyph.";
  }
  if (has("ActivityListFilesIcon", "FolderIcon")) {
    return "Activity file listing and folder identity wrappers retain domain-specific semantics while sharing the folder glyph.";
  }
  if (has("TextActionLinkIcon", "NfmSideMenuCopyLinkIcon")) {
    return "Text-action link and NFM copy-link wrappers retain editor-specific semantics while sharing the link glyph.";
  }
  if (has("SidePanelPlusIcon", "PlusIcon")) {
    return "Side-panel add and generic add actions retain host-specific semantics while sharing the plus glyph.";
  }
  if (has("QueuePauseIcon", "SessionPinIcon")) {
    return "Queue pause and session pin wrappers share path data but remain a semantic-drift review pair until their product meanings are reconciled.";
  }
  if (
    names.some((name) =>
      ["ConnectorGlobeIcon", "RemoteStatusIcon", "SidePanelBrowserIcon"].includes(name),
    )
  ) {
    return "Connector, remote-status, and browser wrappers retain host-specific semantics while sharing the globe glyph.";
  }
  if (has("GoalChevronRightIcon", "ReviewFileToggleChevronIcon")) {
    return "Goal navigation and review file toggles retain workflow-specific semantics while sharing the chevron glyph.";
  }
  if (has("SettingsWorktreeIcon", "WorktreeStatusIcon")) {
    return "Settings and worktree-status wrappers retain destination and status semantics while sharing the worktree glyph.";
  }
  if (has("BrowserHideIcon", "CloseIcon")) {
    return "Browser hide and close wrappers retain host-specific semantics while sharing the close glyph.";
  }
  if (has("ReviewCommitOrPushIcon", "ThreadSummaryPushIcon")) {
    return "Review and thread-summary actions retain workflow-specific semantics while sharing the push glyph.";
  }
  if (has("AutomationRunNowIcon", "RunActionIcon")) {
    return "Automation and generic run actions retain workflow-specific semantics while sharing the run glyph.";
  }
  if (has("NfmSideMenuSuggestEditsIcon", "TextActionCommentPencilIcon")) {
    return "NFM and text-action editing surfaces retain host-specific semantics while sharing the suggest-edits glyph.";
  }
  if (has("SlashModelIcon", "WorktreeSetupStatusIcon")) {
    return "Slash-model and worktree-setup status wrappers retain domain-specific semantics while sharing the status glyph.";
  }
  if (has("ConfigStatusIcon", "ToolActionIcon")) {
    return "Configuration status and tool-action wrappers retain domain-specific semantics while sharing the tool glyph.";
  }
  return "Reviewed exact geometry alias; wrappers retain distinct product semantics while sharing one visual glyph.";
}

function updateGeometryBaseline(
  baseline: IconBaseline,
  groups: readonly { signature: string; owners: string[]; locations: string[] }[],
): IconBaseline {
  const geometry = groups.map(({ signature, owners }) => ({
    signature,
    owners,
    reason: geometryReason(owners),
  }));
  const nextBaseline = { inlineSvg: baseline.inlineSvg, geometry };
  writeFileSync(inlineSvgBaselinePath, `${JSON.stringify(nextBaseline, null, 2)}\n`);
  console.log(
    `Updated ${projectPath(inlineSvgBaselinePath)} with ${geometry.length} geometry groups.`,
  );
  return nextBaseline;
}

const baseline = readBaseline();
const failures: string[] = [];
const reports: string[] = [];
const actualInlineSvgCounts = new Map<string, number>();
const usedGenericIcons = new Set<string>();
const genericImports: GenericImportBinding[] = [];
const genericExports: GenericExportBinding[] = [];
const appOwnedNames = new Map<string, string[]>();
const geometryOccurrences: GeometryOccurrence[] = [];

for (const path of listSourceFiles(rendererRoot)) {
  if (path.includes("/third_party/")) continue;
  const sourceText = readFileSync(path, "utf8");
  const relativePath = projectPath(path);
  let sourceFile: Program;
  try {
    sourceFile = parseTypeScriptSource(path, sourceText);
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
    const inlineSvgCount = sourceText.match(/<svg\b/g)?.length ?? 0;
    if (inlineSvgCount > 0 && !path.startsWith(sharedIconRoot)) {
      actualInlineSvgCounts.set(relativePath, inlineSvgCount);
    }
    continue;
  }
  for (const statement of sourceFile.body) {
    if (statement.type === "ImportDeclaration") {
      const moduleName = statement.source.value;
      if (moduleName === "lucide-react" && path !== genericIconModule) {
        failures.push(
          `${relativePath} imports lucide-react directly; use the shared icon boundary.`,
        );
      }
      if (isGenericIconImport(path, moduleName)) {
        importedNames(statement).forEach(({ imported }) => usedGenericIcons.add(imported));
      }
    }
  }

  if (path === genericIconModule) {
    const bindings = collectGenericBindings(sourceFile, sourceText);
    genericImports.push(...bindings.imports);
    genericExports.push(...bindings.exports);
  } else if (path.startsWith(sharedIconRoot) && !isTestFixturePath(relativePath)) {
    for (const name of exportedNames(sourceFile)) {
      const owners = appOwnedNames.get(name) ?? [];
      owners.push(`${relativePath}#${name}`);
      appOwnedNames.set(name, owners);
    }
    geometryOccurrences.push(...collectGeometryOccurrences(sourceFile, sourceText, path));
  }

  const prefixedIconName = sourceText.match(
    /\b(?:function|const|class)\s+(Codex[A-Za-z0-9_]*Icon(?:Svg|Sprite)?)\b/,
  );
  if (prefixedIconName) {
    failures.push(
      `${relativePath} declares ${prefixedIconName[1]}; app-owned icon names must describe semantics, not provenance.`,
    );
  }

  if (path.startsWith(sharedIconRoot)) {
    verifySharedIconIntrinsicSizing(sourceFile, sourceText, path, failures);
    continue;
  }
  const inlineSvgCount = verifyInlineSvgBoundary(sourceFile, sourceText, path, baseline, failures);
  if (inlineSvgCount > 0) actualInlineSvgCounts.set(relativePath, inlineSvgCount);
}

verifyInlineSvgBaselineCompleteness(actualInlineSvgCounts, baseline, failures, reports);
verifyGenericLucideDuplicates(genericImports, genericExports, failures);
verifyGenericUsage(genericExports, usedGenericIcons, failures);
verifyGenericAppNameConflicts(genericExports, appOwnedNames, failures);

const geometryGroups = collectGeometryGroups(geometryOccurrences);
const effectiveBaseline = writeGeometryBaseline
  ? updateGeometryBaseline(baseline, geometryGroups)
  : baseline;
verifyGeometryGroups(geometryGroups, effectiveBaseline, failures, reports);

if (reports.length > 0) {
  console.log(["Icon boundary reports:", ...reports.map((report) => `- ${report}`)].join("\n"));
}

if (failures.length > 0) {
  throw new Error(["Icon boundary verification failed:", ...failures].join("\n- "));
}

console.log(
  `Icon boundaries verified: ${genericExports.length} generic glyphs, ${Object.keys(baseline.inlineSvg).length} inline-SVG baseline entries, ${geometryGroups.length} exact geometry collision groups.`,
);
