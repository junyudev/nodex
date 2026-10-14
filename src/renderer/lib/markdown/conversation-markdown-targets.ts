import type { FileLinkTarget } from "../../../shared/file-link-openers";
import type { CodexComposerSkill } from "../../../shared/types";

export interface ConversationFileTarget {
  readonly kind: "file";
  readonly reference: Readonly<FileLinkTarget>;
  readonly label: string;
  readonly tooltip: string;
}
export type ConversationMarkdownTarget =
  | ConversationFileTarget
  | {
      readonly kind: "thread";
      readonly threadId: string;
      readonly explicitHostId?: string;
      readonly label: string;
    }
  | {
      readonly kind: "skill";
      readonly name: string;
      readonly href?: string;
      readonly label: string;
    };

const longFileExtensions = new Set(
  "7zipx.accdb.asarpack.asciidoc.backup.backupdb.bundle.ccproj.cdrdao.code-workspace.config.debugin.deploy.design.docbook.dockerfile.dockerignore.editorconfig.eslintignore.gitattributes.gitignore.gitkeep.gradle.graphqls.ignore.ipynb.keychain.keynote.licensee.lockfile.lockfile.markdown.markup.matlab.mkdocs.models.module.msstyle.notebook.npmignore.output.packageinfo.parquet.pickle.plistx.policy.postcssrc.prettierignore.projectfile.python.readme.review.robots.schema.search.series.settingsjson.shader.sqlite.sqlite3.storyboard.styles.system.target.terraform.update.vertex.webapp.webdoc.webpackrc.widget.workspace.xcodeproj.yarnlock".split(
    ".",
  ),
);
const windowsDrive = /^[A-Za-z]:[\\/]/u;
const slashWindowsDrive = /^\/[A-Za-z]:[\\/]/u;
const nativeUnc = /^(?:\\\\[^\\]+\\[^\\]+|\/\/[^/]+\/[^/]+)/u;

export function isConversationNativePath(path: string): boolean {
  return (
    (path.startsWith("/") && !path.startsWith("//")) ||
    windowsDrive.test(path) ||
    nativeUnc.test(path)
  );
}
function stripDriveSlash(path: string): string {
  return slashWindowsDrive.test(path) ? path.slice(1) : path;
}
function nativeSpelling(path: string): string {
  const normalized = stripDriveSlash(path);
  return windowsDrive.test(normalized) || nativeUnc.test(normalized)
    ? normalized.replaceAll("/", "\\")
    : path;
}
function decodeAuthoredUri(value: string): string {
  try {
    return decodeURI(value);
  } catch {
    return value;
  }
}

/** Locations are authored syntax. Already resolved Files paths never enter this decoder. */
export function readConversationNativeReference(source: string): Readonly<FileLinkTarget> {
  const value = source.replaceAll("`", "").trim();
  const location =
    /^(.*?):(\d+)(?::(\d+))?(?:[-–](\d+)(?::(\d+))?)?$/u.exec(value) ??
    /^(.*?)#L(\d+)(?:C(\d+))?(?:-L(\d+)(?:C(\d+))?)?$/u.exec(value);
  if (!location) return { path: value };
  return {
    path: location[1]!,
    line: Number.parseInt(location[2]!, 10),
    ...(location[3] ? { column: Number.parseInt(location[3], 10) } : {}),
    ...(location[4] ? { endLine: Number.parseInt(location[4], 10) } : {}),
    ...(location[5] ? { endColumn: Number.parseInt(location[5], 10) } : {}),
  };
}

export function isConversationFileReference(source: string): boolean {
  const reference = readConversationNativeReference(source);
  const path = reference.path;
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(path) || /^www\.|^(?:mailto|tel):/iu.test(path))
    return false;
  if (reference.line !== undefined) return true;
  if (!/(?:^|[\\/])[^\\/]+\.(?!\d+$)[^\\/.]+$/iu.test(path)) return false;
  if (/[\\/]/u.test(path)) return true;
  const extension = path.split(".").at(-1) ?? "";
  if (/[a-z]/u.test(extension) && /[A-Z]/u.test(extension.slice(1))) return false;
  return extension.length <= 4 || longFileExtensions.has(extension.toLowerCase());
}

/** Interpret one authored file/native path stage, retaining malformed native percent spellings. */
export function interpretConversationFilePath(source: string): string | null {
  const reference = readConversationNativeReference(source);
  const path = reference.path.startsWith("sandbox:") ? reference.path.slice(8) : reference.path;
  if (isConversationNativePath(path)) {
    try {
      return stripDriveSlash(decodeURI(path)).replaceAll(/%23/giu, "#").replaceAll(/%3F/giu, "?");
    } catch {
      return path;
    }
  }
  try {
    const url = new URL(path);
    if (url.protocol !== "file:") return null;
    const pathname = stripDriveSlash(decodeURIComponent(url.pathname));
    return !url.host || url.host === "localhost" ? pathname : `//${url.host}${pathname}`;
  } catch {
    return null;
  }
}

function formatLocation(reference: Readonly<FileLinkTarget>): string {
  const { line, column, endLine, endColumn } = reference;
  const parts: string[] = [];
  if (line !== undefined)
    parts.push(
      endLine !== undefined && endLine !== line ? `lines ${line}-${endLine}` : `line ${line}`,
    );
  else if (endLine !== undefined) parts.push(`line ${endLine}`);
  if (column !== undefined)
    parts.push(
      endColumn !== undefined && endColumn !== column
        ? `columns ${column}-${endColumn}`
        : `column ${column}`,
    );
  else if (endColumn !== undefined) parts.push(`column ${endColumn}`);
  return parts.length ? ` (${parts.join(", ")})` : "";
}
function comparablePath(path: string): string {
  return path
    .replace(/^\\\\\?\\UNC\\/iu, "\\\\")
    .replace(/^\\\\\?\\(?=[A-Za-z]:[\\/])/u, "")
    .replaceAll("\\", "/")
    .replace(/\/+$/u, "")
    .toLowerCase();
}
export function presentConversationFileTarget(
  reference: Readonly<FileLinkTarget>,
  authoredLabel: string,
): ConversationFileTarget {
  const suffix = formatLocation(reference);
  const basename = reference.path.split(/[\\/]/u).at(-1) ?? reference.path;
  const tooltip = `${reference.path}${suffix}`;
  const label = authoredLabel.trim();
  if (!label || label === tooltip || label === reference.path)
    return { kind: "file", reference, label: `${basename}${suffix}`, tooltip };
  if (!suffix || label.endsWith(suffix)) return { kind: "file", reference, label, tooltip };
  const labelPath = readConversationNativeReference(label).path;
  const left = comparablePath(labelPath);
  const right = comparablePath(reference.path);
  const matchesPath =
    left === right ||
    (left && right.endsWith(`/${left}`)) ||
    (right && left.endsWith(`/${right}`)) ||
    ((left === left.split("/").at(-1) || right === right.split("/").at(-1)) &&
      left.split("/").at(-1) === right.split("/").at(-1));
  return { kind: "file", reference, label: `${matchesPath ? labelPath : label}${suffix}`, tooltip };
}

/** Parsed and recovered hrefs have different lexer stages; this closes their final native interpretation. */
export function resolveConversationFileLink(
  href: string,
  label: string,
): ConversationFileTarget | null {
  if (href.includes("\0")) return null;
  const decoded = decodeAuthoredUri(href);
  const predecoded =
    decoded.includes("/") && windowsDrive.test(stripDriveSlash(decoded))
      ? decoded.replaceAll("\\_", "_")
      : decoded;
  const directory =
    /[\\/]$/u.test(predecoded) &&
    !predecoded.startsWith("//") &&
    !/^[a-z][a-z0-9+.-]*:\/\//iu.test(predecoded) &&
    !/^www\.|^(?:mailto|tel):/iu.test(predecoded);
  const candidate =
    isConversationFileReference(predecoded) || isConversationNativePath(predecoded) || directory
      ? predecoded
      : interpretConversationFilePath(predecoded);
  if (candidate === null) return null;
  const reference = readConversationNativeReference(candidate);
  const path = nativeSpelling(interpretConversationFilePath(reference.path) ?? reference.path);
  if (!path || path.includes("\0")) return null;
  return presentConversationFileTarget({ ...reference, path }, label === candidate ? "" : label);
}

export function resolveConversationThreadLink(href: string) {
  if (!href.startsWith("thread://")) return null;
  const match = /^([A-Za-z0-9_-]+)(?:\?hostId=([^?#&/]+))?$/u.exec(href.slice(9));
  if (!match) return null;
  if (!match[2]) return { threadId: match[1]! };
  try {
    const explicitHostId = decodeURIComponent(match[2]);
    if (!/^[A-Za-z0-9._:-]+$/u.test(explicitHostId)) return null;
    return { threadId: match[1]!, explicitHostId };
  } catch {
    return null;
  }
}

export function readConversationSkillMention(source: string): string | null {
  const match = /^\$(?:\[([^\]\n]+)\]|([A-Za-z][\w-]*(?::[A-Za-z][\w-]*)?))$/u.exec(source);
  return match?.[1] ?? match?.[2] ?? null;
}

export function resolveConversationMarkdownLink(
  href: string,
  label: string,
): ConversationMarkdownTarget | null {
  if (/^\s*(?:javascript|vbscript|data):/iu.test(href)) return null;
  const thread = resolveConversationThreadLink(href);
  if (thread) return { kind: "thread", ...thread, label: label.trim() || href };
  const name = readConversationSkillMention(label.trim());
  if (name && !/^https?:/iu.test(href)) return { kind: "skill", name, href, label };
  return resolveConversationFileLink(href, label);
}

/** Inline code has its own native-path lane before complete-link and skill decoration. */
export function resolveConversationInlineCode(source: string): ConversationMarkdownTarget | null {
  const path = source.startsWith("@") ? source.slice(1) : null;
  if (path !== null && isConversationFileReference(path))
    return presentConversationFileTarget(readConversationNativeReference(path), "");
  const link = /^\[((?:\\.|[^\]\n])+)\]\(((?:\\.|[^)\n])+)\)$/u.exec(source);
  if (link) {
    const label = link[1]!.trim().replace(/\\([\p{P}\p{S}])/gu, "$1");
    const href = link[2]!.trim().replace(/\\([\p{P}\p{S}])/gu, "$1");
    const target = label && href ? resolveConversationMarkdownLink(href, label) : null;
    if (target) return target;
  }
  const name = readConversationSkillMention(source);
  return name ? { kind: "skill", name, label: source } : null;
}

export function resolveConversationSkill(
  target: Extract<ConversationMarkdownTarget, { kind: "skill" }>,
  skills: readonly CodexComposerSkill[],
  sourceHostId: string | null,
) {
  const matches = skills.filter((skill) =>
    target.href
      ? comparablePath(skill.path) === comparablePath(target.href)
      : skill.name === target.name || skill.displayName === target.name,
  );
  const skill = matches.length === 1 ? matches[0]! : null;
  const label = skill?.displayName || (target.name.includes(":") ? target.name : `$${target.name}`);
  const path = target.href ?? skill?.path;
  const reference =
    skill &&
    sourceHostId === "local" &&
    path &&
    isConversationNativePath(path) &&
    path.split(/[\\/]/u).at(-1)?.toLowerCase() === "skill.md"
      ? { path }
      : null;
  return { label, skill, reference };
}

/** Citations decode once; zero line positions do not become Files reveal locations. */
export function readConversationFileCitation(source: string) {
  const match = /^【([^\n]+?)†L(\d+)(?:-L(\d+))?】/u.exec(source);
  if (!match) return null;
  const encoded = match[1]!.trim();
  const explicit = encoded.startsWith("F:");
  const path = decodeAuthoredUri(explicit ? encoded.slice(2).trim() : encoded);
  if (!path || (!explicit && !isConversationNativePath(path))) return null;
  const positive = (value: string | undefined) => {
    const number = Number(value);
    return Number.isSafeInteger(number) && number > 0 ? number : undefined;
  };
  const line = positive(match[2]);
  const endLine = positive(match[3]);
  return {
    raw: match[0],
    reference: {
      path,
      ...(line === undefined ? {} : { line }),
      ...(endLine === undefined ? {} : { endLine }),
    },
  };
}

export interface ConversationTextDecoration {
  readonly index: number;
  readonly content: string;
  readonly type: "mention" | "color";
}
export function readConversationTextDecorations(
  source: string,
  preceding = "",
): readonly ConversationTextDecoration[] {
  const mentions = Array.from(
    source.matchAll(
      /\$(?:\[[^\]\n]+\]|[A-Za-z][\w-]*(?::[A-Za-z][\w-]*)?)|@[A-Za-z0-9][\w.-]*[\\/][\w./-]*/gu,
    ),
    (match): ConversationTextDecoration => ({
      index: match.index,
      content: match[0],
      type: "mention",
    }),
  );
  const prs = /\bprs?\b/iu.test(preceding + source);
  const colors = Array.from(source.matchAll(/(^|\s)(#[\da-f]{6})(?!\w)/giu)).flatMap(
    (match): ConversationTextDecoration[] => {
      const index = match.index + match[1]!.length;
      const before = preceding + source.slice(0, index);
      if (
        (before.length > 0 && !/\s$/u.test(before)) ||
        /\b(?:issue|pr)\W*$/iu.test(before) ||
        (prs && /^#\d{6}$/u.test(match[2]!))
      )
        return [];
      return [{ index, content: match[2]!, type: "color" }];
    },
  );
  return [...mentions, ...colors].sort((before, after) => before.index - after.index);
}
