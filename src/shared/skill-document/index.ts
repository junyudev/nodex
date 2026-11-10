import {
  readLocatedMarkdown,
  writeMarkdown,
  writePortableMarkdown,
  type MarkdownBlock,
  type MarkdownInline,
  type MarkdownSourceSpan,
} from "../nodex-markdown";
import { markdownBlocksForEditor } from "../nodex-markdown/blocknote";
import { createUuidV7 } from "../uuid-v7";
import {
  patchSkillHeader,
  readSkillHeader,
  type SkillFrontmatter,
  type SkillFrontmatterPatch,
} from "./frontmatter";
import { inspectPortableSource } from "./portable-source";

export type { SkillFrontmatter, SkillFrontmatterPatch };

export type SkillRichAvailability =
  | { readonly editable: true }
  | { readonly editable: false; readonly reason: string };
export type SkillSourceEdit =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: string };

export interface SkillBodyBlock extends MarkdownBlock {
  readonly id: string;
  readonly children: readonly SkillBodyBlock[];
}

/** A top-level editor block and all its descendants. Offsets address the original JS string. */
export interface SkillSourceUnit extends MarkdownSourceSpan {
  readonly id: string;
}

export interface SkillSource {
  readonly text: string;
  readonly frontmatter: SkillFrontmatter;
  readonly bodyStart: number;
  readonly units: readonly SkillSourceUnit[];
  readonly blocks: readonly SkillBodyBlock[];
  readonly rich: SkillRichAvailability;
}

interface SourceBlock {
  readonly block: SkillBodyBlock;
  readonly spans: readonly MarkdownSourceSpan[];
}

interface LocatedSkillSource extends SkillSource {
  readonly ownLines: ReadonlyMap<string, SourceBlock>;
  readonly opaque: readonly MarkdownSourceSpan[];
}

export const skillBodyBlockTypes = [
  "paragraph",
  "heading",
  "bulletListItem",
  "numberedListItem",
  "checkListItem",
  "codeBlock",
  "table",
  "quote",
  "divider",
  "callout",
] as const;
const supportedBlocks = new Set<string>(skillBodyBlockTypes);
const supportedStyles = new Set(["bold", "italic", "strike", "code"]);

function unsupportedInline(content: unknown): boolean {
  return (
    Array.isArray(content) &&
    (content as readonly MarkdownInline[]).some(
      (item) =>
        (item.type !== "text" && item.type !== "link") ||
        Object.entries(item.styles ?? {}).some(
          ([key, value]) => value && !supportedStyles.has(key),
        ) ||
        unsupportedInline(item.content),
    )
  );
}

function supported(block: MarkdownBlock): boolean {
  if (
    !supportedBlocks.has(block.type) ||
    block.props?.isToggleable === true ||
    Number(block.props?.level ?? 1) > 4
  )
    return false;
  if (block.props?.textAlignment && block.props.textAlignment !== "left") return false;
  if (block.type === "table") {
    const table = block.content as { rows?: { cells: { content?: unknown }[] }[] } | undefined;
    return !table?.rows?.some((row) => row.cells.some((cell) => unsupportedInline(cell.content)));
  }
  return !unsupportedInline(block.content);
}

const refusal = (reason: string): SkillSourceEdit => ({ ok: false, reason });
const problem = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

function flatten<T extends MarkdownBlock>(blocks: readonly T[]): T[] {
  return blocks.flatMap((block) => [block, ...flatten((block.children ?? []) as readonly T[])]);
}

function isEmptyParagraph(block: MarkdownBlock | undefined): boolean {
  return (
    block?.type === "paragraph" &&
    !block.children?.length &&
    (block.content === undefined || (Array.isArray(block.content) && block.content.length === 0)) &&
    writeMarkdown([{ ...block, id: undefined }]) === ""
  );
}

const semantic = (block: MarkdownBlock): MarkdownBlock => ({
  ...block,
  id: undefined,
  children: block.children?.map(semantic),
});
const signature = (blocks: readonly MarkdownBlock[]): string => writeMarkdown(blocks.map(semantic));
const ownSignature = (block: MarkdownBlock): string => signature([{ ...block, children: [] }]);

/**
 * Project one complete disk snapshot into editor blocks and retain the ranges needed to edit it.
 * Supply IDs in preorder when adopting a validated save, or match IDs on clean reload.
 */
export function parseSkillSource(
  text: string,
  allocateBlockId?: (block: MarkdownBlock) => string,
): SkillSource {
  return locateSkillSource(text, allocateBlockId);
}

function locateSkillSource(
  text: string,
  allocateBlockId: (block: MarkdownBlock) => string = createUuidV7,
): LocatedSkillSource {
  const { bodyStart, fields, reason: headerReason } = readSkillHeader(text);
  const body = text.slice(bodyStart);
  const base = {
    text,
    bodyStart,
    frontmatter: {
      name: { value: fields.name.value, patchable: !!fields.name.span },
      description: { value: fields.description.value, patchable: !!fields.description.span },
    },
  };
  const ownLines = new Map<string, SourceBlock>();
  const units: SkillSourceUnit[] = [];
  const unavailable = (
    reason: string,
    blocks: readonly SkillBodyBlock[] = [],
  ): LocatedSkillSource => ({
    ...base,
    units,
    blocks,
    ownLines,
    opaque: [],
    rich: { editable: false, reason },
  });

  if (/[\uD800-\uDFFF]/u.test(text)) return unavailable("The file cannot be represented as UTF-8.");
  if (text.includes("\0")) return unavailable("The file contains a null character.");
  let located: ReturnType<typeof readLocatedMarkdown>;
  let inspection: ReturnType<typeof inspectPortableSource>;
  try {
    located = readLocatedMarkdown(body, "document");
    inspection = inspectPortableSource(body);
  } catch (error) {
    return unavailable(problem(error));
  }

  function identify(block: MarkdownBlock): SkillBodyBlock {
    const id = allocateBlockId(block);
    return { ...block, id, children: (block.children ?? []).map(identify) };
  }
  const blocks = markdownBlocksForEditor(located.blocks.map(identify)) as SkillBodyBlock[];
  const all = flatten(blocks);
  const { opaque, reason } = inspection;
  if (headerReason || reason) return unavailable(headerReason ?? reason!, blocks);
  if (all.some((block) => !supported(block))) {
    return unavailable("The body contains content that the file editor cannot represent.", blocks);
  }

  if (all.length !== located.locations.length) {
    return unavailable("Markdown block boundaries could not be identified.", blocks);
  }
  all.forEach((block, index) => {
    const spans = located.locations[index]!.map(({ start, end }) => ({
      start: bodyStart + start,
      end: bodyStart + end,
    }));
    ownLines.set(block.id, { block, spans });
  });
  const synthetic = all.length === 1 && isEmptyParagraph(all[0]) && !located.locations[0]?.length;
  if (synthetic) ownLines.clear();
  for (const block of synthetic ? [] : blocks) {
    const spans = flatten([block])
      .flatMap((child) => ownLines.get(child.id)!.spans)
      .sort((a, b) => a.start - b.start);
    const start = spans[0]?.start;
    const end = spans.at(-1)?.end;
    if (start === undefined || end === undefined || start < (units.at(-1)?.end ?? bodyStart)) {
      return unavailable("Markdown block boundaries overlap or have no source.", blocks);
    }
    let cursor = start;
    for (const span of spans) {
      if (span.start < cursor || /\S/.test(text.slice(cursor, span.start))) {
        return unavailable(
          "A block contains source that cannot be assigned to an editable line.",
          blocks,
        );
      }
      cursor = span.end;
    }
    units.push({ id: block.id, start, end });
  }

  const gaps = opaque.map(({ start, end }) => ({ start: start + bodyStart, end: end + bodyStart }));
  const coverage = [...units, ...gaps].sort((a, b) => a.start - b.start);
  let cursor = bodyStart;
  for (const span of coverage) {
    if (span.start < cursor || /\S/.test(text.slice(cursor, span.start))) {
      return unavailable("The body contains source without a safe block boundary.", blocks);
    }
    cursor = span.end;
  }
  if (/\S/.test(text.slice(cursor)))
    return unavailable("The body contains unassigned source.", blocks);

  return { ...base, units, blocks, ownLines, opaque: gaps, rich: { editable: true } };
}

/** Patch only the selected manifest scalar values. The body and other YAML bytes are retained. */
export function setSkillFrontmatter(
  source: SkillSource,
  patch: SkillFrontmatterPatch,
): SkillSourceEdit {
  return patchSkillHeader(source.text, patch);
}

function ending(text: string): string {
  if (text.endsWith("\r\n")) return "\r\n";
  const last = text.at(-1);
  return last === "\r" || last === "\n" ? last : "";
}
const isList = (block: MarkdownBlock): boolean =>
  block.type === "bulletListItem" ||
  block.type === "numberedListItem" ||
  block.type === "checkListItem";

function portable(block: MarkdownBlock): string {
  const result = writePortableMarkdown([semantic(block)], { lineBreaks: "document" });
  if (!result.exact) throw new Error("This edit cannot be represented as portable Markdown.");
  return result.markdown;
}

/** Retain list markers, task spelling, indentation, and descendant lines during item text edits. */
function listLine(
  block: MarkdownBlock,
  original: MarkdownBlock,
  raw: string,
  newline: string,
): string {
  const marker = /^([ \t]*(?:[-+*]|\d{1,9}[.)]) +)(\[[ xX]\] +)?/.exec(raw);
  if (!marker || block.type !== original.type || block.props?.start !== original.props?.start) {
    throw new Error("This list edit needs to change the source markers.");
  }
  const prefix = marker[1]!;
  const task = block.type === "checkListItem" ? (marker[2] ?? "") : "";
  const checked = block.props?.checked === true;
  const token =
    block.type === "checkListItem" && checked !== (original.props?.checked === true)
      ? task.replace(/\[[ xX]\]/, checked ? "[x]" : "[ ]")
      : task;
  const content = portable({ type: "paragraph", content: block.content });
  return (
    prefix + token + content.replaceAll("\n", newline + " ".repeat(prefix.length)) + ending(raw)
  );
}

/** A code-only edit can retain the opening info string and both fence lines. */
function retainFence(raw: string, markdown: string): string | null {
  const fence = /^( {0,3})(\x60{3,}|~{3,})[^\r\n]*(\r\n|\r|\n)/.exec(raw);
  if (!fence) return null;
  const lastLine = /(?:\r\n|\r|\n)( {0,3}(?:\x60{3,}|~{3,})[ \t]*(?:\r\n|\r|\n)?)$/.exec(raw);
  const delimiter = fence[2]!;
  if (!lastLine || !lastLine[1]!.trimStart().startsWith(delimiter)) {
    throw new Error("Editing this code block would change its unclosed fence.");
  }
  const newline = fence[3]!;
  const lines = markdown.split("\n").slice(1, -1);
  return (
    fence[0] + lines.map((line) => (line ? fence[1] + line : "") + newline).join("") + lastLine[1]
  );
}

function rewriteUnit(
  source: LocatedSkillSource,
  unit: SkillSourceUnit,
  edited: MarkdownBlock,
  newline: string,
): string {
  const raw = source.text.slice(unit.start, unit.end);
  const original = source.ownLines.get(unit.id)!.block;
  const originalTree = flatten([original]);
  const editedTree = flatten([edited]);
  const sameTree =
    originalTree.length === editedTree.length &&
    originalTree.every(
      (block, index) =>
        block.id === editedTree[index]?.id &&
        block.children.length === (editedTree[index]?.children?.length ?? 0),
    );

  if (sameTree && signature([edited]) === signature([original])) return raw;
  if (!original.children.length && !edited.children?.length && !isList(original)) {
    const markdown = portable(edited);
    if (original.type === "codeBlock") {
      if (
        edited.type !== original.type ||
        (edited.props?.language ?? "text") !== (original.props?.language ?? "text")
      ) {
        throw new Error("Changing a code fence or its language requires Source.");
      }
      const retained = retainFence(raw, markdown);
      if (retained !== null) return retained;
    }
    return markdown.replaceAll("\n", ending(raw) || newline) + ending(raw);
  }

  if (!sameTree) {
    throw new Error("This structural edit would rewrite other lines in a nested block.");
  }

  const edits = editedTree.flatMap((block, index) => {
    const before = originalTree[index]!;
    if (ownSignature(block) === ownSignature(before)) return [];
    const spans = source.ownLines.get(before.id)!.spans;
    if (!isList(before) || spans.length !== 1) {
      throw new Error("The edited lines cannot be separated from their enclosing block.");
    }
    const span = spans[0]!;
    const item = source.text.slice(span.start, span.end);
    return [
      { ...span, text: listLine(block, before, item, /\r\n|\r|\n/.exec(item)?.[0] ?? newline) },
    ];
  });
  let result = raw;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    result =
      result.slice(0, edit.start - unit.start) + edit.text + result.slice(edit.end - unit.start);
  }
  return result;
}

/**
 * Splice only owned lines. A full document read verifies the requested semantics and source
 * ownership before returning a write candidate. A sole or trailing empty paragraph is a caret.
 */
export function applySkillBodyEdit(
  source: SkillSource,
  editedBlocks: readonly MarkdownBlock[],
): SkillSourceEdit {
  if (!source.rich.editable) return refusal(source.rich.reason);
  try {
    return spliceBody(source as LocatedSkillSource, editedBlocks);
  } catch (error) {
    return refusal(problem(error));
  }
}

function spliceBody(source: LocatedSkillSource, input: readonly MarkdownBlock[]): SkillSourceEdit {
  const blocks = isEmptyParagraph(input.at(-1)) ? input.slice(0, -1) : input;
  const all = flatten(blocks);
  if (all.some((block) => !supported(block))) {
    return refusal("This edit contains content that the file editor cannot represent.");
  }
  const ids = new Set(all.map((block) => block.id));
  if (ids.has(undefined) || ids.has("") || ids.size !== all.length) {
    return refusal("Each edited block needs a unique, stable identity.");
  }
  const previous = source.units.map(({ id }) => source.ownLines.get(id)!.block);
  const previousIds = flatten(previous).map((block) => block.id);
  if (
    all.length === previousIds.length &&
    all.every(({ id }, index) => id === previousIds[index]) &&
    signature(blocks) === signature(previous)
  )
    return { ok: true, text: source.text };

  const unitsById = new Map(source.units.map((unit) => [unit.id, unit]));
  const nextIndex = new Map(blocks.map((block, index) => [block.id, index]));
  for (const block of all) {
    const root = nextIndex.has(block.id);
    if (source.ownLines.has(block.id!) && root !== unitsById.has(block.id!)) {
      return refusal("Moving blocks into or out of a nested group requires Source.");
    }
  }

  // A gap with hidden content must retain both neighbors, including document edges.
  const gaps = new Map<string | undefined, string>();
  let gap = "";
  let start = source.bodyStart;
  let left: string | undefined;
  for (const unit of [
    ...source.units,
    { id: undefined, start: source.text.length, end: source.text.length },
  ]) {
    const right = unit.id;
    const raw = source.text.slice(start, unit.start);
    if (source.units.length && /\S/.test(raw)) {
      const before = left === undefined ? -1 : nextIndex.get(left);
      const after = right === undefined ? blocks.length : nextIndex.get(right);
      if (before === undefined || after !== before + 1) {
        return refusal("This edit would move or remove a boundary beside preserved Markdown.");
      }
    }
    gap += raw;
    if (right === undefined || nextIndex.has(right)) {
      gaps.set(right, gap);
      gap = "";
    }
    start = unit.end;
    left = right;
  }

  // With no editable units, the existing body is a prelude to the first inserted block.
  if (!source.units.length && blocks.length) {
    gaps.set(blocks[0]!.id, gaps.get(undefined) ?? "");
    gaps.delete(undefined);
  }

  const newline = /\r\n|\r|\n/.exec(source.text)?.[0] ?? "\n";
  const positions: { start: number; end: number; raw: string }[] = [];
  const oldIndex = new Map(source.units.map(({ id }, index) => [id, index]));
  let text = source.text.slice(0, source.bodyStart);
  for (const [index, block] of blocks.entries()) {
    const unit = unitsById.get(block.id!);
    const gap = gaps.get(block.id) ?? "";
    const prior = blocks[index - 1];
    if (prior) {
      const priorIndex = oldIndex.get(prior.id!);
      const originalNeighbors =
        priorIndex !== undefined && oldIndex.get(block.id!) === priorIndex + 1;
      if (!ending(text)) text += newline;
      if (!originalNeighbors && !gap && !(isList(prior) && isList(block))) text += newline;
    }
    text += gap;
    if (text.length > source.bodyStart && !ending(text) && /[^ 	]/.test(gap)) text += newline;
    const raw = unit
      ? rewriteUnit(source, unit, block, newline)
      : portable(block).replaceAll("\n", newline) +
        (index + 1 < blocks.length || ending(source.text.slice(source.bodyStart)) ? newline : "");
    positions.push({ start: text.length, end: text.length + raw.length, raw });
    text += raw;
  }
  text += gaps.get(undefined) ?? "";

  const candidate = locateSkillSource(text);
  if (!candidate.rich.editable) return refusal(candidate.rich.reason);
  if (
    candidate.bodyStart !== source.bodyStart ||
    candidate.units.length !== blocks.length ||
    signature(candidate.units.length ? candidate.blocks : []) !== signature(blocks)
  ) {
    return refusal("The edited Markdown would read differently from the editor.");
  }
  const opaqueBytes = (file: LocatedSkillSource) =>
    file.opaque.map(({ start, end }) => file.text.slice(start, end));
  const preserved = opaqueBytes(source);
  const reparsed = opaqueBytes(candidate);
  if (
    preserved.length !== reparsed.length ||
    preserved.some((raw, index) => raw !== reparsed[index])
  ) {
    return refusal("The edit would change preserved Markdown.");
  }
  if (
    candidate.units.some((unit, index) => {
      const intended = positions[index]!;
      return (
        unit.start !== intended.start ||
        unit.end < intended.end ||
        text.slice(unit.start, intended.end) !== intended.raw ||
        (unit.end !== intended.end && text.slice(intended.end, unit.end) !== newline)
      );
    })
  )
    return refusal("The edited Markdown would change the ownership of surrounding lines.");

  return { ok: true, text };
}
