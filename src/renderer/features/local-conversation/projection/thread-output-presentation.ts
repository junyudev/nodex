import { formatDisplayPath, normalizeDisplayPath } from "@/lib/display-path";
import type { ThreadSummaryPanelOutputRow } from "./thread-summary-panel-output-model";

export interface ThreadOutputLocation {
  /** Leading folders, ending in `/`; the part that yields to truncation. */
  readonly head: string;
  /** The innermost folder, kept visible when the location is truncated. */
  readonly tail: string;
}

export interface ThreadOutputPresentation {
  readonly title: string;
  /** Short human kind, such as `HTML`, `Markdown`, `Website` or `Google Docs`. */
  readonly kind: string;
  /** Containing folder for file outputs, omitted at the working directory itself. */
  readonly location: ThreadOutputLocation | null;
  /** Path that selects file-type artwork; web resources have none. */
  readonly iconPath: string | null;
}

export type ThreadOutputOpenAction =
  | { readonly type: "web"; readonly url: string }
  | { readonly type: "image-preview"; readonly path: string }
  | { readonly type: "default-app"; readonly path: string }
  | { readonly type: "files"; readonly path: string };

const GENERIC_ENTRY_NAMES = new Set(["index.html", "index.htm", "index.md", "readme.md", "readme"]);
const IMAGE_EXTENSIONS = new Set(["apng", "avif", "gif", "jpeg", "jpg", "png", "svg", "webp"]);
const HTML_EXTENSIONS = new Set(["htm", "html", "xhtml"]);
const KIND_BY_EXTENSION: Readonly<Record<string, string>> = {
  csv: "CSV",
  doc: "Word document",
  docx: "Word document",
  htm: "HTML",
  html: "HTML",
  key: "Keynote",
  markdown: "Markdown",
  md: "Markdown",
  mdx: "Markdown",
  numbers: "Numbers",
  pages: "Pages",
  pdf: "PDF",
  ppt: "Presentation",
  pptx: "Presentation",
  tex: "LaTeX",
  tsv: "TSV",
  txt: "Text",
  xhtml: "HTML",
  xls: "Spreadsheet",
  xlsm: "Spreadsheet",
  xlsx: "Spreadsheet",
};
const GOOGLE_DRIVE_KIND = {
  document: "Google Docs",
  spreadsheet: "Google Sheets",
  presentation: "Google Slides",
  drive: "Google Drive",
} as const;

function splitPath(path: string): { readonly directory: string | null; readonly name: string } {
  const normalized = normalizeDisplayPath(path);
  const index = normalized.lastIndexOf("/");
  if (index < 0) return { directory: null, name: normalized };
  return {
    directory: index === 0 ? "/" : normalized.slice(0, index),
    name: normalized.slice(index + 1),
  };
}

function extensionOf(name: string): string | null {
  const index = name.lastIndexOf(".");
  return index > 0 && index < name.length - 1 ? name.slice(index + 1).toLowerCase() : null;
}

function describeFileKind(name: string): string {
  const extension = extensionOf(name);
  if (!extension) return "File";
  if (IMAGE_EXTENSIONS.has(extension)) return "Image";
  return KIND_BY_EXTENSION[extension] ?? extension.toUpperCase();
}

function describeLocation(
  directory: string | null,
  cwd: string | null | undefined,
): ThreadOutputLocation | null {
  if (!directory) return null;
  const display = formatDisplayPath(directory, cwd);
  if (display === ".") return null;
  const relative = display.startsWith("./") ? display.slice(2) : display;
  const index = relative.lastIndexOf("/");
  if (index < 0 || index === relative.length - 1) return { head: "", tail: relative };
  return { head: relative.slice(0, index + 1), tail: relative.slice(index + 1) };
}

function describePathOutput(
  row: Extract<ThreadSummaryPanelOutputRow, { path: string }>,
  cwd: string | null | undefined,
): ThreadOutputPresentation {
  const { directory, name } = splitPath(row.path);
  const parent = directory && directory !== "/" ? splitPath(directory) : null;
  // `report/index.html` names a document; a bare `index.html` names nothing.
  const qualified = parent?.name && GENERIC_ENTRY_NAMES.has(name.toLowerCase());
  return {
    title: row.kind === "generated-image" ? row.label : qualified ? `${parent.name}/${name}` : name,
    kind: row.kind === "generated-image" ? "Image" : describeFileKind(name),
    location: describeLocation(qualified ? parent.directory : directory, cwd),
    iconPath: row.path,
  };
}

/** One reading of an output for every surface that lists it. */
export function describeThreadOutput(
  row: ThreadSummaryPanelOutputRow,
  cwd?: string | null,
): ThreadOutputPresentation {
  switch (row.kind) {
    case "file":
    case "image":
    case "generated-image":
      return describePathOutput(row, cwd);
    case "website":
      if (!/^https?:\/\//iu.test(row.target))
        return describePathOutput({ ...row, kind: "file", path: row.target }, cwd);
      return {
        title: row.label,
        kind: "Website",
        location: null,
        iconPath: null,
      };
    case "google-drive":
      return {
        title: row.label,
        kind: GOOGLE_DRIVE_KIND[row.resourceKind],
        location: null,
        iconPath: null,
      };
    case "appgen-app":
      return { title: row.label, kind: "App", location: null, iconPath: null };
  }
}

/**
 * Images open in the in-place viewer and HTML renders in the default browser on this
 * device; every other file opens in Files. Remote files always stay in Files, whose host
 * identity reaches them.
 */
export function resolveThreadOutputOpenAction(
  row: ThreadSummaryPanelOutputRow,
  hostId: string,
): ThreadOutputOpenAction {
  switch (row.kind) {
    case "google-drive":
    case "appgen-app":
      return { type: "web", url: row.url };
    case "website":
      if (/^https?:\/\//iu.test(row.target)) return { type: "web", url: row.target };
      return resolvePathOpenAction(row.target, false, hostId);
    case "file":
    case "image":
    case "generated-image":
      return resolvePathOpenAction(row.path, row.kind !== "file", hostId);
  }
}

function resolvePathOpenAction(
  path: string,
  image: boolean,
  hostId: string,
): ThreadOutputOpenAction {
  if (hostId !== "local") return { type: "files", path };
  const extension = extensionOf(splitPath(path).name);
  if (image || (extension && IMAGE_EXTENSIONS.has(extension)))
    return { type: "image-preview", path };
  if (extension && HTML_EXTENSIONS.has(extension)) return { type: "default-app", path };
  return { type: "files", path };
}

/** Whether opening leaves Nodex, which surfaces mark with an open-in affordance. */
export function isExternalThreadOutputOpen(
  row: ThreadSummaryPanelOutputRow,
  hostId: string,
): boolean {
  const { type } = resolveThreadOutputOpenAction(row, hostId);
  return type === "web" || type === "default-app";
}
