import type { CodexDynamicToolCallView } from "../../../../lib/types";
import type {
  NodexAgentV2ToolName,
  NodexAgentV3ToolName,
} from "../../../../../shared/nodex-agent-tools/identity";
export type NodexDynamicToolPresentationIcon =
  | "database"
  | "read"
  | "search"
  | "transfer"
  | "write";
export type NodexMarkdownDiffLineKind = "added" | "removed" | "separator";

export interface NodexMarkdownDiffLine {
  readonly kind: NodexMarkdownDiffLineKind;
  readonly text: string;
}

export interface NodexMarkdownChangePreview {
  readonly label: string;
  readonly additions: number;
  readonly deletions: number;
  readonly lines: readonly NodexMarkdownDiffLine[];
  readonly omittedLineCount: number;
}

export interface NodexDynamicToolCallPresentation {
  readonly label: string;
  readonly icon: NodexDynamicToolPresentationIcon;
  readonly markdownChange: NodexMarkdownChangePreview | null;
}

const MAX_LABEL_VALUE_LENGTH = 96;
const MAX_MARKDOWN_DIFF_LINES = 80;
const MAX_MARKDOWN_PATCH_SIDE_PREVIEW_LINES = 32;
const MAX_COLLAPSED_TOOL_DERIVATION_CHARS = 32_000;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function numberValue(record: Record<string, unknown> | null, key: string): number | null {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function quoted(value: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  const visible =
    normalized.length > MAX_LABEL_VALUE_LENGTH
      ? `${normalized.slice(0, MAX_LABEL_VALUE_LENGTH - 1).trimEnd()}…`
      : normalized;
  return `“${visible}”`;
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function parseToolOutput(call: CodexDynamicToolCallView): Record<string, unknown> | null {
  const texts = (call.contentItems ?? []).flatMap((item) =>
    item.type === "inputText" ? [item.text] : [],
  );
  for (let index = texts.length - 1; index >= 0; index -= 1) {
    if ((texts[index]?.length ?? 0) > MAX_COLLAPSED_TOOL_DERIVATION_CHARS) continue;
    try {
      const output = asRecord(JSON.parse(texts[index] ?? ""));
      if (output) return output;
    } catch {
      continue;
    }
  }
  return null;
}

function outputData(call: CodexDynamicToolCallView): Record<string, unknown> | null {
  return asRecord(parseToolOutput(call)?.data);
}

function textInputPlainText(value: unknown): string | null {
  const input = asRecord(value);
  if (input?.kind === "plain") return stringValue(input, "text");
  if (input?.kind !== "rich") return null;

  const text = asArray(input.richText)
    .flatMap((segment) => {
      const item = asRecord(segment);
      if (item?.type === "linebreak") return [" "];
      const segmentText = stringValue(item, "text");
      return segmentText ? [segmentText] : [];
    })
    .join("")
    .trim();
  return text.length > 0 ? text : null;
}

function isFailed(call: CodexDynamicToolCallView): boolean {
  return call.status === "failed" || (call.completed && call.success === false);
}

function phaseLabel(
  call: CodexDynamicToolCallView,
  labels: { active: string; completed: string; failed: string },
): string {
  if (isFailed(call)) return labels.failed;
  return call.completed ? labels.completed : labels.active;
}

function contentLineCount(content: string): number {
  if (content.length === 0) return 0;
  let count = 1;
  for (const character of content) {
    if (character === "\n") count += 1;
  }
  return count;
}

function appendContentPreviewLines(
  target: NodexMarkdownDiffLine[],
  content: string,
  kind: Extract<NodexMarkdownDiffLineKind, "added" | "removed">,
  maximum = MAX_MARKDOWN_DIFF_LINES,
): void {
  const remaining = Math.min(MAX_MARKDOWN_DIFF_LINES - target.length, maximum);
  if (remaining <= 0 || content.length === 0) return;
  target.push(...content.split("\n", remaining).map((text) => ({ kind, text })));
}

function buildMarkdownChangePreview(
  body: Record<string, unknown> | null,
): NodexMarkdownChangePreview | null {
  const kind = stringValue(body, "kind");
  if (kind === "markdown.insert" || kind === "insert") {
    const content =
      typeof body?.content === "string"
        ? body.content
        : typeof body?.markdown === "string"
          ? body.markdown
          : "";
    if (content.length > MAX_COLLAPSED_TOOL_DERIVATION_CHARS) return null;
    const additions = contentLineCount(content);
    const lines: NodexMarkdownDiffLine[] = [];
    appendContentPreviewLines(lines, content, "added");
    return {
      label: kind === "insert" ? "Nested Markdown insertion" : "NFM insertion",
      additions,
      deletions: 0,
      lines,
      omittedLineCount: additions - lines.length,
    };
  }

  if (kind === "markdown.replace" || kind === "replace") {
    const content =
      typeof body?.content === "string"
        ? body.content
        : typeof body?.markdown === "string"
          ? body.markdown
          : "";
    if (content.length > MAX_COLLAPSED_TOOL_DERIVATION_CHARS) return null;
    const additions = contentLineCount(content);
    const lines: NodexMarkdownDiffLine[] = [];
    appendContentPreviewLines(lines, content, "added");
    return {
      label: kind === "replace" ? "Nested Markdown replacement" : "NFM replacement content",
      additions,
      deletions: 0,
      lines,
      omittedLineCount: additions - lines.length,
    };
  }

  if (kind !== "markdown.patch" && kind !== "patch") return null;

  const patches = asArray(body?.patches);
  const lines: NodexMarkdownDiffLine[] = [];
  let additions = 0;
  let deletions = 0;
  let inspectedCharacters = 0;
  for (const [patchIndex, patch] of patches.entries()) {
    const value = asRecord(patch);
    const oldMarkdown =
      typeof value?.oldNfm === "string"
        ? value.oldNfm
        : typeof value?.oldMarkdown === "string"
          ? value.oldMarkdown
          : "";
    const newMarkdown =
      typeof value?.newNfm === "string"
        ? value.newNfm
        : typeof value?.newMarkdown === "string"
          ? value.newMarkdown
          : "";
    inspectedCharacters += oldMarkdown.length + newMarkdown.length;
    if (inspectedCharacters > MAX_COLLAPSED_TOOL_DERIVATION_CHARS) return null;
    additions += contentLineCount(newMarkdown);
    deletions += contentLineCount(oldMarkdown);
    if (patchIndex > 0 && lines.length < MAX_MARKDOWN_DIFF_LINES) {
      lines.push({ kind: "separator", text: `Patch ${patchIndex + 1}` });
    }
    appendContentPreviewLines(lines, oldMarkdown, "removed", MAX_MARKDOWN_PATCH_SIDE_PREVIEW_LINES);
    appendContentPreviewLines(lines, newMarkdown, "added", MAX_MARKDOWN_PATCH_SIDE_PREVIEW_LINES);
  }
  const renderedChangeLineCount = lines.filter((line) => line.kind !== "separator").length;
  return {
    label:
      kind === "patch"
        ? plural(patches.length, "Nested Markdown patch", "Nested Markdown patches")
        : plural(patches.length, "NFM patch", "NFM patches"),
    additions,
    deletions,
    lines,
    omittedLineCount: additions + deletions - renderedChangeLineCount,
  };
}

function resultCountSuffix(count: number | null, noun: string): string {
  return count === null ? "" : ` · ${plural(count, noun)}`;
}

function pageKeySuffix(keys: readonly string[]): string {
  if (keys.length === 0) return "";
  const visible = keys.slice(0, 2).join(", ");
  const remaining = keys.length - Math.min(keys.length, 2);
  return ` · ${visible}${remaining > 0 ? ` +${remaining}` : ""}`;
}

function resolveGetContext(call: CodexDynamicToolCallView): NodexDynamicToolCallPresentation {
  const include = asRecord(asRecord(call.arguments)?.include);
  const contextParts = [
    include?.databases === true ? "databases" : null,
    include?.nfmGuide === true ? "NFM guide" : null,
    include?.markdownGuide === true ? "Nested Markdown guide" : null,
  ].filter((value): value is string => value !== null);
  const suffix = contextParts.length > 0 ? ` with ${contextParts.join(" and ")}` : "";
  return {
    label: `${phaseLabel(call, {
      active: "Reading project context",
      completed: "Read project context",
      failed: "Failed to read project context",
    })}${suffix}`,
    icon: "read",
    markdownChange: null,
  };
}

function resolveGetBlock(call: CodexDynamicToolCallView): NodexDynamicToolCallPresentation {
  const args = asRecord(call.arguments);
  const data = outputData(call);
  const block = asRecord(data?.block);
  const outputTitle = textInputPlainText(block?.title);
  const blockId = stringValue(args, "blockId");
  const document = asRecord(asRecord(args?.include)?.document);
  const format = stringValue(document, "format");
  const target = outputTitle ? quoted(outputTitle) : blockId ? `block ${quoted(blockId)}` : "block";
  const suffix = format ? ` as ${format.toUpperCase()}` : "";
  return {
    label: `${phaseLabel(call, {
      active: `Reading ${target}`,
      completed: `Read ${target}`,
      failed: `Failed to read ${target}`,
    })}${suffix}`,
    icon: "read",
    markdownChange: null,
  };
}

function resolveSearch(call: CodexDynamicToolCallView): NodexDynamicToolCallPresentation {
  const args = asRecord(call.arguments);
  const query = stringValue(args, "query");
  const target = args?.target === "blocks" ? "blocks" : "pages";
  const data = outputData(call);
  const results = asArray(data?.results);
  const count = call.completed && data ? results.length : null;
  const pageKeys = results.flatMap((result) => {
    const pageKey = stringValue(asRecord(result), "pageKey");
    return pageKey ? [pageKey] : [];
  });
  const subject = query ? `${target} for ${quoted(query)}` : target;
  return {
    label: `${phaseLabel(call, {
      active: `Searching ${subject}`,
      completed: `Searched ${subject}`,
      failed: `Failed to search ${subject}`,
    })}${resultCountSuffix(count, "result")}${pageKeySuffix(pageKeys)}`,
    icon: "search",
    markdownChange: null,
  };
}

function resolveQueryDatabase(call: CodexDynamicToolCallView): NodexDynamicToolCallPresentation {
  const data = outputData(call);
  const database = asRecord(data?.database);
  const view = asRecord(data?.view);
  const name = stringValue(view, "name") ?? stringValue(database, "name");
  const rows = asArray(data?.rows);
  const count = call.completed && data ? rows.length : null;
  const target = name ? quoted(name) : "database";
  return {
    label: `${phaseLabel(call, {
      active: `Querying ${target}`,
      completed: `Queried ${target}`,
      failed: `Failed to query ${target}`,
    })}${resultCountSuffix(count, "row")}`,
    icon: "database",
    markdownChange: null,
  };
}

function resolveCreate(call: CodexDynamicToolCallView): NodexDynamicToolCallPresentation {
  const args = asRecord(call.arguments);
  const resource = asRecord(args?.resource);
  const title = textInputPlainText(resource?.title);
  const target = title ? quoted(title) : "page";
  const data = outputData(call);
  const outputResource = asRecord(data?.resource);
  const count =
    call.completed && data
      ? (numberValue(outputResource, "bodyBlockCount") ??
        asArray(outputResource?.createdBodyBlockIds).length)
      : null;
  return {
    label: `${phaseLabel(call, {
      active: `Creating ${target}`,
      completed: `Created ${target}`,
      failed: `Failed to create ${target}`,
    })}${resultCountSuffix(count, "body block")}`,
    icon: "write",
    markdownChange: null,
  };
}

function resolveEditDocument(call: CodexDynamicToolCallView): NodexDynamicToolCallPresentation {
  const args = asRecord(call.arguments);
  const title = textInputPlainText(asRecord(args?.title)?.value ?? args?.title);
  const body = asRecord(args?.body);
  const markdownChange = buildMarkdownChangePreview(body);
  const bodyKind = stringValue(body, "kind");
  const blockEditCount = bodyKind === "blocks" ? asArray(body?.edits).length : null;
  const target = title ? ` ${quoted(title)}` : " document";
  const action = phaseLabel(call, {
    active: `Editing${target}`,
    completed: `Edited${target}`,
    failed: `Failed to edit${target}`,
  });
  const change = markdownChange
    ? ` · ${markdownChange.label}`
    : blockEditCount !== null
      ? ` · ${plural(blockEditCount, "block change")}`
      : title
        ? " · title"
        : "";
  return {
    label: `${action}${change}`,
    icon: "write",
    markdownChange,
  };
}

function resolveTransferBlocks(call: CodexDynamicToolCallView): NodexDynamicToolCallPresentation {
  const args = asRecord(call.arguments);
  const mode = args?.mode === "copy" ? "copy" : "move";
  const itemCount = asArray(args?.blockIds).length;
  const destination =
    pageDestinationLabel(args?.destination) ?? stringValue(asRecord(args?.destination), "kind");
  const target = plural(itemCount, "block");
  const destinationSuffix = destination ? ` to ${destination}` : "";
  return {
    label: `${phaseLabel(
      call,
      mode === "copy"
        ? {
            active: `Copying ${target}`,
            completed: `Copied ${target}`,
            failed: `Failed to copy ${target}`,
          }
        : {
            active: `Moving ${target}`,
            completed: `Moved ${target}`,
            failed: `Failed to move ${target}`,
          },
    )}${destinationSuffix}`,
    icon: "transfer",
    markdownChange: null,
  };
}

function resolveEditDatabase(call: CodexDynamicToolCallView): NodexDynamicToolCallPresentation {
  const args = asRecord(call.arguments);
  const edits = asArray(args?.edits);
  const placementCount = edits
    .filter((edit) => asRecord(edit)?.kind === "view.place")
    .flatMap((edit) => asArray(asRecord(edit)?.items)).length;
  const valueCount =
    edits.length - edits.filter((edit) => asRecord(edit)?.kind === "view.place").length;
  const changeParts = [
    valueCount > 0 ? plural(valueCount, "value change") : null,
    placementCount > 0 ? plural(placementCount, "placement") : null,
  ].filter((value): value is string => value !== null);
  const suffix = changeParts.length > 0 ? ` · ${changeParts.join(", ")}` : "";
  return {
    label: `${phaseLabel(call, {
      active: "Updating database",
      completed: "Updated database",
      failed: "Failed to update database",
    })}${suffix}`,
    icon: "database",
    markdownChange: null,
  };
}

function inlineMarkdownLabel(value: string): string {
  return value
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/[*_~`]/gu, "")
    .replace(/<[^>]+>/gu, "")
    .trim();
}

function pageDestinationLabel(value: unknown): string | null {
  const destination = asRecord(value);
  const kind = stringValue(destination, "kind");
  if (kind === "library") return "Library";
  if (kind === "page") {
    const pageId = stringValue(destination, "pageId");
    return pageId ? `page ${quoted(pageId)}` : "a parent page";
  }
  if (kind === "data_source") {
    const dataSourceId = stringValue(destination, "dataSourceId");
    return dataSourceId ? `data source ${quoted(dataSourceId)}` : "a data source";
  }
  return null;
}

function compactTitleList(titles: readonly string[]): string {
  const visible = titles.slice(0, 2).map(quoted).join(", ");
  const remaining = Math.max(0, titles.length - 2);
  return remaining > 0 ? `${visible} +${remaining}` : visible;
}

function resolveFetch(call: CodexDynamicToolCallView): NodexDynamicToolCallPresentation {
  const args = asRecord(call.arguments);
  const data = outputData(call);
  const resource = asRecord(data?.resource);
  const title = stringValue(asRecord(resource?.title), "markdown");
  const pageKey = stringValue(resource, "pageKey");
  const id = stringValue(args, "id");
  const format = stringValue(args, "format") ?? "markdown";
  const target = title
    ? `${pageKey ? `${pageKey} · ` : ""}${quoted(inlineMarkdownLabel(title))}`
    : id
      ? quoted(id)
      : "item";
  return {
    label: `${phaseLabel(call, {
      active: `Fetching ${target}`,
      completed: `Fetched ${target}`,
      failed: `Failed to fetch ${target}`,
    })} as ${format}`,
    icon: "read",
    markdownChange: null,
  };
}

function resolveQueryDatabaseV3(
  call: CodexDynamicToolCallView,
  kind: "view" | "data source",
): NodexDynamicToolCallPresentation {
  const args = asRecord(call.arguments);
  const data = outputData(call);
  const view = asRecord(data?.view);
  const fallbackId =
    kind === "view" ? stringValue(args, "viewId") : stringValue(args, "dataSourceId");
  const name =
    kind === "view" ? stringValue(view, "name") : stringValue(asRecord(data?.dataSource), "name");
  const target = name
    ? `${kind} ${quoted(name)}`
    : fallbackId
      ? `${kind} ${quoted(fallbackId)}`
      : kind;
  const count = call.completed && data ? asArray(data?.rows).length : null;
  return {
    label: `${phaseLabel(call, {
      active: `Querying ${target}`,
      completed: `Queried ${target}`,
      failed: `Failed to query ${target}`,
    })}${resultCountSuffix(count, "row")}`,
    icon: "database",
    markdownChange: null,
  };
}

function resolveCreatePages(call: CodexDynamicToolCallView): NodexDynamicToolCallPresentation {
  const args = asRecord(call.arguments);
  const drafts = asArray(args?.pages)
    .map(asRecord)
    .filter((draft): draft is Record<string, unknown> => draft !== null);
  const titles = drafts.flatMap((draft) => {
    const title = stringValue(draft, "title");
    return title ? [inlineMarkdownLabel(title)] : [];
  });
  const count = drafts.length;
  const subject =
    count === 1 && titles[0]
      ? quoted(titles[0])
      : `${plural(count, "page")}${titles.length > 0 ? `: ${compactTitleList(titles)}` : ""}`;
  const outputPages = asArray(outputData(call)?.pages);
  const pageKeys = outputPages.flatMap((page) => {
    const pageKey = stringValue(asRecord(page), "pageKey");
    return pageKey ? [pageKey] : [];
  });
  const bodyBlockCount =
    call.completed && outputPages.length > 0
      ? outputPages.reduce<number>(
          (total, page) => total + (numberValue(asRecord(page), "bodyBlocksCreated") ?? 0),
          0,
        )
      : null;
  const destination = pageDestinationLabel(args?.destination);
  return {
    label: `${phaseLabel(call, {
      active: `Creating ${subject}`,
      completed: `Created ${subject}`,
      failed: `Failed to create ${subject}`,
    })}${destination ? ` in ${destination}` : ""}${resultCountSuffix(bodyBlockCount, "body block")}${pageKeySuffix(pageKeys)}`,
    icon: "write",
    markdownChange: null,
  };
}

function resolveUpdatePage(call: CodexDynamicToolCallView): NodexDynamicToolCallPresentation {
  const args = asRecord(call.arguments);
  const pageId = stringValue(args, "pageId");
  const title = stringValue(asRecord(args?.title), "markdown");
  const body = asRecord(args?.body);
  const markdownChange = buildMarkdownChangePreview(body);
  const target = title
    ? quoted(inlineMarkdownLabel(title))
    : pageId
      ? `page ${quoted(pageId)}`
      : "page";
  const changes = [title ? "title" : null, markdownChange?.label ?? null].filter(
    (value): value is string => value !== null,
  );
  return {
    label: `${phaseLabel(call, {
      active: `Updating ${target}`,
      completed: `Updated ${target}`,
      failed: `Failed to update ${target}`,
    })}${changes.length > 0 ? ` · ${changes.join(", ")}` : ""}`,
    icon: "write",
    markdownChange,
  };
}

function resolveAdvancedUpdatePage(
  call: CodexDynamicToolCallView,
): NodexDynamicToolCallPresentation {
  const args = asRecord(call.arguments);
  const pageId = stringValue(args, "pageId");
  const edits = asArray(args?.edits);
  const deletes = edits.filter((edit) => asRecord(edit)?.kind === "delete").length;
  const target = pageId ? `page ${quoted(pageId)}` : "page";
  const suffix =
    edits.length > 0
      ? ` · ${plural(edits.length, "stable block change")}${deletes > 0 ? `, ${plural(deletes, "delete")}` : ""}`
      : "";
  return {
    label: `${phaseLabel(call, {
      active: `Updating ${target}`,
      completed: `Updated ${target}`,
      failed: `Failed to update ${target}`,
    })}${suffix}`,
    icon: "write",
    markdownChange: null,
  };
}

function resolveMovePages(call: CodexDynamicToolCallView): NodexDynamicToolCallPresentation {
  const args = asRecord(call.arguments);
  const count = asArray(args?.pageIds).length;
  const destination = pageDestinationLabel(args?.destination);
  const subject = plural(count, "page");
  const pageKeys = asArray(outputData(call)?.pages).flatMap((page) => {
    const pageKey = stringValue(asRecord(page), "pageKey");
    return pageKey ? [pageKey] : [];
  });
  return {
    label: `${phaseLabel(call, {
      active: `Moving ${subject}`,
      completed: `Moved ${subject}`,
      failed: `Failed to move ${subject}`,
    })}${destination ? ` to ${destination}` : ""}${pageKeySuffix(pageKeys)}`,
    icon: "transfer",
    markdownChange: null,
  };
}

function resolveDuplicatePage(call: CodexDynamicToolCallView): NodexDynamicToolCallPresentation {
  const args = asRecord(call.arguments);
  const sourceId = stringValue(args, "pageId");
  const resultData = outputData(call);
  const resultId = stringValue(resultData, "pageId");
  const resultPageKey = stringValue(resultData, "pageKey");
  const source = sourceId ? `page ${quoted(sourceId)}` : "page";
  const result = resultPageKey ? ` → ${resultPageKey}` : resultId ? ` → ${quoted(resultId)}` : "";
  const destination = pageDestinationLabel(args?.destination);
  return {
    label: `${phaseLabel(call, {
      active: `Duplicating ${source}`,
      completed: `Duplicated ${source}${result}`,
      failed: `Failed to duplicate ${source}`,
    })}${destination ? ` to ${destination}` : ""}`,
    icon: "transfer",
    markdownChange: null,
  };
}

export function resolveNodexDynamicToolCallPresentation(
  call: CodexDynamicToolCallView,
): NodexDynamicToolCallPresentation | null {
  if (call.namespace !== "nodex_app") return null;

  switch (call.tool as NodexAgentV2ToolName | NodexAgentV3ToolName) {
    case "get_context":
      return resolveGetContext(call);
    case "get_block":
      return resolveGetBlock(call);
    case "fetch":
      return resolveFetch(call);
    case "search":
      return resolveSearch(call);
    case "query_database":
      return resolveQueryDatabase(call);
    case "query_database_view":
      return resolveQueryDatabaseV3(call, "view");
    case "query_data_source":
      return resolveQueryDatabaseV3(call, "data source");
    case "create":
      return resolveCreate(call);
    case "create_pages":
      return resolveCreatePages(call);
    case "edit_document":
      return resolveEditDocument(call);
    case "update_page":
      return resolveUpdatePage(call);
    case "advanced_update_page":
      return resolveAdvancedUpdatePage(call);
    case "transfer_blocks":
      return resolveTransferBlocks(call);
    case "move_pages":
      return resolveMovePages(call);
    case "duplicate_page":
      return resolveDuplicatePage(call);
    case "edit_database":
      return resolveEditDatabase(call);
    default:
      return null;
  }
}
