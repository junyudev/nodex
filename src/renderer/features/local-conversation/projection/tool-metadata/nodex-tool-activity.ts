import type { MarkdownBlock } from "../../../../../shared/nodex-markdown";
import type { CodexDynamicToolCallView } from "../../../../lib/types";
import { formatToolResultText, unwrapToolResult } from "./tool-output-envelope";
import { parseCanonicalPageKey } from "../../../../../shared/page-key";

/** The kind of thing a Nodex tool acted on; rows and group headers show it as their icon. */
export type NodexToolActivityIcon =
  | "account"
  | "chat"
  | "database"
  | "inbox"
  | "page"
  | "plugin"
  | "project"
  | "schedule"
  | "search"
  | "task"
  | "terminal"
  | "workspace";

/**
 * One piece of an activity sentence. Pages and chats stay references: a row resolves
 * their current name when it renders, so an identity never has to reach the reader.
 */
export type NodexToolActivityPart =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "page"; readonly pageId: string; readonly title: string | null }
  | {
      readonly kind: "chat";
      readonly sessionId: string;
      readonly threadId: string | null;
      readonly title: string | null;
    };

export interface NodexMarkdownDiffLine {
  readonly kind: "added" | "removed" | "separator";
  readonly text: string;
}

export interface NodexMarkdownChangePreview {
  readonly label: string;
  readonly additions: number;
  readonly deletions: number;
  readonly lines: readonly NodexMarkdownDiffLine[];
  readonly omittedLineCount: number;
}

/** A Page the call found, created or moved, listed when the reader opens the row. */
export interface NodexToolRelatedPage {
  readonly pageId: string;
  readonly title: string | null;
  readonly pageKey: string | null;
  readonly excerpt: string | null;
}

/** How several settled calls of this kind read together in a collapsed group. */
export interface NodexToolActivityRepeat {
  readonly key: string;
  readonly label: (count: number) => string;
}

export interface NodexToolActivity {
  readonly icon: NodexToolActivityIcon;
  readonly parts: readonly NodexToolActivityPart[];
  /** The sentence as text, for surfaces that cannot resolve a name. */
  readonly label: string;
  readonly change: NodexMarkdownChangePreview | null;
  /** Whether opening the row gives a person something to read; the exact call is always inspectable. */
  readonly expandable: boolean;
  readonly repeat: NodexToolActivityRepeat | null;
}

/** What an opened row shows: the call's result as a person reads it, never its JSON. */
export interface NodexToolDetail {
  /** The Markdown a read returned. */
  readonly document: string | null;
  /** Text the Agent wrote to someone. */
  readonly message: string | null;
  readonly pages: readonly NodexToolRelatedPage[];
  /** A failure in the tool's own words. */
  readonly failure: string | null;
}

type UnknownRecord = Record<string, unknown>;

/** A verb in each phase of a call: `Reading`, `Read`, `Couldn't read`. */
interface ActivityVerb {
  readonly active: string;
  readonly completed: string;
  readonly failed: string;
}

const verb = (active: string, completed: string, infinitive: string): ActivityVerb => ({
  active,
  completed,
  failed: `Couldn't ${infinitive}`,
});

const MAX_QUOTED_LENGTH = 96;
const MAX_MARKDOWN_DIFF_LINES = 80;
const MAX_PATCH_SIDE_PREVIEW_LINES = 32;
const MAX_DERIVED_OUTPUT_CHARS = 32_000;
const MAX_RELATED_PAGES = 20;

const asRecord = (value: unknown): UnknownRecord | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;

const asArray = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);

function stringValue(record: UnknownRecord | null, key: string): string | null {
  const value = record?.[key];
  if (typeof value !== "string") return null;
  return value.trim() || null;
}

const rawString = (record: UnknownRecord | null, key: string): string =>
  typeof record?.[key] === "string" ? record[key] : "";

const plural = (count: number, singular: string, pluralForm = `${singular}s`): string =>
  `${count} ${count === 1 ? singular : pluralForm}`;

function quoted(value: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return `“${
    normalized.length > MAX_QUOTED_LENGTH
      ? `${normalized.slice(0, MAX_QUOTED_LENGTH - 1).trimEnd()}…`
      : normalized
  }”`;
}

function inlineMarkdownText(value: string | null): string | null {
  const text = value
    ?.replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/[*_~`]/gu, "")
    .replace(/<[^>]+>/gu, "")
    .trim();
  return text || null;
}

const firstOutputText = (call: CodexDynamicToolCallView): string | null =>
  call.contentItems?.find((item) => item.type === "inputText")?.text ?? null;

/** The settled timeline carries a compact digest in the result's shape; an opened row, all of it. */
function outputData(call: CodexDynamicToolCallView): UnknownRecord | null {
  const text = firstOutputText(call);
  if (text === null || text.length > MAX_DERIVED_OUTPUT_CHARS) return null;
  const output = unwrapToolResult(text);
  return asRecord(output?.data) ?? output;
}

const isFailed = (call: CodexDynamicToolCallView): boolean =>
  call.status === "failed" || (call.completed && call.success === false);

function phrase(call: CodexDynamicToolCallView, words: ActivityVerb): string {
  if (isFailed(call)) return words.failed;
  return call.completed ? words.completed : words.active;
}

const text = (value: string): NodexToolActivityPart => ({ kind: "text", text: value });

const pagePart = (pageId: string, title: string | null = null): NodexToolActivityPart => ({
  kind: "page",
  pageId,
  title,
});

/** The sentence without live names: a known title in quotes, an unknown Page by its kind. */
function formatActivityLabel(parts: readonly NodexToolActivityPart[]): string {
  return parts
    .flatMap((part) => {
      if (part.kind === "text") return [part.text];
      if (part.title) return [quoted(part.title)];
      return part.kind === "page" ? ["page"] : [];
    })
    .join(" ");
}

function activity(
  call: CodexDynamicToolCallView,
  icon: NodexToolActivityIcon,
  words: ActivityVerb,
  parts: readonly NodexToolActivityPart[] = [],
  details: Partial<Pick<NodexToolActivity, "change" | "expandable" | "repeat">> = {},
): NodexToolActivity {
  const sentence = [text(phrase(call, words)), ...parts];
  const change = details.change ?? null;
  return {
    icon,
    parts: sentence,
    label: formatActivityLabel(sentence),
    change,
    expandable: isFailed(call) || change !== null || details.expandable === true,
    repeat: details.repeat ?? null,
  };
}

/** How many results a settled call reports, or null while that is unknown. */
function resultCount(
  call: CodexDynamicToolCallView,
  data: UnknownRecord | null,
  collection: string,
): number | null {
  if (!call.completed || !data) return null;
  if (typeof data.resultCount === "number") return data.resultCount;
  return Array.isArray(data[collection]) ? data[collection].length : null;
}

const resultCountParts = (count: number | null, noun: string): readonly NodexToolActivityPart[] =>
  count === null ? [] : [text(`· ${plural(count, noun)}`)];

function contentLineCount(content: string): number {
  if (content.length === 0) return 0;
  let count = 1;
  for (const character of content) if (character === "\n") count += 1;
  return count;
}

function appendPreviewLines(
  target: NodexMarkdownDiffLine[],
  content: string,
  kind: "added" | "removed",
  maximum = MAX_MARKDOWN_DIFF_LINES,
): void {
  const remaining = Math.min(MAX_MARKDOWN_DIFF_LINES - target.length, maximum);
  if (remaining <= 0 || content.length === 0) return;
  target.push(...content.split("\n", remaining).map((line) => ({ kind, text: line })));
}

function buildMarkdownChangePreview(body: UnknownRecord | null): NodexMarkdownChangePreview | null {
  const kind = stringValue(body, "kind");
  if (kind === "insert" || kind === "replace") {
    const content = rawString(body, "markdown");
    if (content.length > MAX_DERIVED_OUTPUT_CHARS) return null;
    const additions = contentLineCount(content);
    const lines: NodexMarkdownDiffLine[] = [];
    appendPreviewLines(lines, content, "added");
    return {
      label: kind === "insert" ? "Added content" : "Replaced content",
      additions,
      deletions: 0,
      lines,
      omittedLineCount: additions - lines.length,
    };
  }
  if (kind !== "patch") return null;

  const patches = asArray(body?.patches);
  const lines: NodexMarkdownDiffLine[] = [];
  let additions = 0;
  let deletions = 0;
  let inspectedCharacters = 0;
  for (const [patchIndex, patch] of patches.entries()) {
    const value = asRecord(patch);
    const oldMarkdown = rawString(value, "oldMarkdown");
    const newMarkdown = rawString(value, "newMarkdown");
    inspectedCharacters += oldMarkdown.length + newMarkdown.length;
    if (inspectedCharacters > MAX_DERIVED_OUTPUT_CHARS) return null;
    additions += contentLineCount(newMarkdown);
    deletions += contentLineCount(oldMarkdown);
    if (patchIndex > 0 && lines.length < MAX_MARKDOWN_DIFF_LINES)
      lines.push({ kind: "separator", text: `Edit ${patchIndex + 1}` });
    appendPreviewLines(lines, oldMarkdown, "removed", MAX_PATCH_SIDE_PREVIEW_LINES);
    appendPreviewLines(lines, newMarkdown, "added", MAX_PATCH_SIDE_PREVIEW_LINES);
  }
  const shownLineCount = lines.filter((line) => line.kind !== "separator").length;
  return {
    label: plural(patches.length, "edit"),
    additions,
    deletions,
    lines,
    omittedLineCount: additions + deletions - shownLineCount,
  };
}

/** Where a Page went: a Page stays a reference, and a Data Source reads by what the reader sees. */
function destinationParts(
  value: unknown,
  preposition: "in" | "to",
): readonly NodexToolActivityPart[] {
  const destination = asRecord(value);
  switch (stringValue(destination, "kind")) {
    case "library":
      return preposition === "to" ? [text("to Library")] : [];
    case "page": {
      const pageId = stringValue(destination, "pageId");
      return pageId ? [text(preposition), pagePart(pageId)] : [];
    }
    case "data_source":
      return [text(`${preposition} a database`)];
    default:
      return [];
  }
}

function relatedPage(
  pageId: string | null,
  source: UnknownRecord | null,
  title: string | null,
  excerpt: string | null = null,
): readonly NodexToolRelatedPage[] {
  return pageId ? [{ pageId, title, pageKey: stringValue(source, "pageKey"), excerpt }] : [];
}

const repeatAs = (key: string, label: (count: number) => string): NodexToolActivityRepeat => ({
  key,
  label,
});

const REPEAT_READ_PAGES = repeatAs("read-pages", (count) => `Read ${count} pages`);
const REPEAT_UPDATE_PAGES = repeatAs("update-pages", (count) => `Updated ${count} pages`);
const REPEAT_SEARCHES = repeatAs("searches", (count) => `Ran ${count} searches`);
const REPEAT_QUERIES = repeatAs("queries", (count) => `Ran ${count} queries`);
const REPEAT_READ_CHATS = repeatAs("read-chats", (count) => `Read ${count} chats`);

const READ = verb("Reading", "Read", "read");

function resolveFetch(call: CodexDynamicToolCallView): NodexToolActivity {
  const resource = asRecord(outputData(call)?.resource);
  const id = stringValue(asRecord(call.arguments), "id") ?? stringValue(resource, "id");
  const title = inlineMarkdownText(stringValue(asRecord(resource?.title), "markdown"));
  const type = stringValue(resource, "type");
  const format = stringValue(asRecord(call.arguments), "format");
  const details = {
    repeat: REPEAT_READ_PAGES,
    // Only a Page read as text has something to read here; Blocks stay with the exact output.
    expandable: call.completed && format !== "blocks" && (type === null || type === "page"),
  };
  if (type && type !== "page") {
    const isDatabase = type === "database";
    return activity(
      call,
      isDatabase ? "database" : "page",
      READ,
      [text(title ? quoted(title) : isDatabase ? "database" : "block")],
      details,
    );
  }
  return activity(call, "page", READ, id ? [pagePart(id, title)] : [text("page")], details);
}

function resolveSearch(call: CodexDynamicToolCallView): NodexToolActivity {
  const args = asRecord(call.arguments);
  const query = stringValue(args, "query");
  const subject = args?.target === "blocks" ? "blocks" : "pages";
  const count = resultCount(call, outputData(call), "results");
  return activity(
    call,
    "search",
    verb("Searching", "Searched", "search"),
    [
      text(query ? `${subject} for ${quoted(query)}` : subject),
      ...resultCountParts(count, "result"),
    ],
    { expandable: call.completed && count !== 0, repeat: REPEAT_SEARCHES },
  );
}

function resolveQuery(
  call: CodexDynamicToolCallView,
  noun: "view" | "data source",
): NodexToolActivity {
  const data = outputData(call);
  const name = stringValue(asRecord(noun === "view" ? data?.view : data?.dataSource), "name");
  const count = resultCount(call, data, "rows");
  return activity(
    call,
    "database",
    verb("Querying", "Queried", "query"),
    [text(name ? `${noun} ${quoted(name)}` : noun), ...resultCountParts(count, "row")],
    { expandable: call.completed && count !== 0, repeat: REPEAT_QUERIES },
  );
}

function resolveCreatePages(call: CodexDynamicToolCallView): NodexToolActivity {
  const args = asRecord(call.arguments);
  const drafts = asArray(args?.pages).map(asRecord);
  const results = asArray(outputData(call)?.pages).map(asRecord);
  const count = results.length || drafts.length;
  const onlyTitle =
    count === 1 ? inlineMarkdownText(stringValue(drafts[0] ?? null, "title")) : null;
  const onlyId = count === 1 ? stringValue(results[0] ?? null, "pageId") : null;
  const subject: NodexToolActivityPart = onlyId
    ? pagePart(onlyId, onlyTitle)
    : text(onlyTitle ? quoted(onlyTitle) : count > 1 ? plural(count, "page") : "page");
  return activity(
    call,
    "page",
    verb("Creating", "Created", "create"),
    [subject, ...destinationParts(args?.destination, "in")],
    { expandable: call.completed && count > 1 && results.length > 0 },
  );
}

function resolveUpdatePage(call: CodexDynamicToolCallView): NodexToolActivity {
  const args = asRecord(call.arguments);
  const pageId = stringValue(args, "pageId") ?? stringValue(outputData(call), "pageId");
  const newTitle = inlineMarkdownText(stringValue(asRecord(args?.title), "markdown"));
  const change = buildMarkdownChangePreview(asRecord(args?.body));
  const page = pageId ? pagePart(pageId) : text("page");
  if (newTitle && !args?.body)
    return activity(call, "page", verb("Renaming", "Renamed", "rename"), [
      page,
      text(`to ${quoted(newTitle)}`),
    ]);
  return activity(call, "page", verb("Updating", "Updated", "update"), [page], {
    change,
    repeat: REPEAT_UPDATE_PAGES,
  });
}

function resolveAdvancedUpdatePage(call: CodexDynamicToolCallView): NodexToolActivity {
  const args = asRecord(call.arguments);
  const pageId = stringValue(args, "pageId") ?? stringValue(outputData(call), "pageId");
  const edits = asArray(args?.edits);
  return activity(
    call,
    "page",
    verb("Updating", "Updated", "update"),
    [
      pageId ? pagePart(pageId) : text("page"),
      ...(edits.length > 0 ? [text(`· ${plural(edits.length, "block change")}`)] : []),
    ],
    { repeat: REPEAT_UPDATE_PAGES },
  );
}

function resolveSetPageProperties(call: CodexDynamicToolCallView): NodexToolActivity {
  const updates = asArray(asRecord(call.arguments)?.updates);
  const pageIds = new Set(
    updates
      .flatMap((update) => asArray(asRecord(update)?.pageIds))
      .filter((id) => typeof id === "string"),
  );
  const pageId = pageIds.size === 1 ? pageIds.values().next().value : null;
  return activity(call, "page", verb("Updating", "Updated", "update"), [
    text("properties on"),
    pageId ? pagePart(pageId) : text(pageIds.size > 1 ? plural(pageIds.size, "page") : "pages"),
  ]);
}

function resolveMovePages(call: CodexDynamicToolCallView): NodexToolActivity {
  const args = asRecord(call.arguments);
  const pageIds = asArray(args?.pageIds).filter(
    (value): value is string => typeof value === "string",
  );
  const only = pageIds.length === 1 ? pageIds[0]! : null;
  return activity(
    call,
    "page",
    verb("Moving", "Moved", "move"),
    [
      only ? pagePart(only) : text(pageIds.length > 1 ? plural(pageIds.length, "page") : "pages"),
      ...destinationParts(args?.destination, "to"),
    ],
    { expandable: pageIds.length > 1 },
  );
}

function resolveDuplicatePage(call: CodexDynamicToolCallView): NodexToolActivity {
  const args = asRecord(call.arguments);
  const pageId = stringValue(outputData(call), "pageId") ?? stringValue(args, "pageId");
  return activity(call, "page", verb("Duplicating", "Duplicated", "duplicate"), [
    pageId ? pagePart(pageId) : text("page"),
    ...destinationParts(args?.destination, "to"),
  ]);
}

/** The argument that carries what the Agent wrote to someone, for each tool that writes. */
const AUTHORED_MESSAGE_ARGUMENTS: Readonly<Record<string, string>> = {
  create_session: "prompt",
  send_message_to_session: "prompt",
  send_to_inbox: "body",
  report_work: "summary",
  hand_back_message: "reason",
  write_turn_note: "body",
  answer_inbox_question: "body",
  reply_to_origin: "body",
};

/** What the Agent wrote to another chat, the Inbox or a Page; a person may want to read it verbatim. */
function readAuthoredMessage(call: CodexDynamicToolCallView): string | null {
  if (!Object.hasOwn(AUTHORED_MESSAGE_ARGUMENTS, call.tool)) return null;
  return stringValue(asRecord(call.arguments), AUTHORED_MESSAGE_ARGUMENTS[call.tool]!);
}

const authored = (call: CodexDynamicToolCallView) => ({
  expandable: readAuthoredMessage(call) !== null,
});

/** The chat a call addressed, or the one its result created; omitted means the calling chat. */
function chatPart(
  call: CodexDynamicToolCallView,
  source: "argument" | "result",
  title: string | null = null,
): readonly NodexToolActivityPart[] {
  const output = call.completed && call.success !== false ? outputData(call) : null;
  const argumentSessionId = stringValue(asRecord(call.arguments), "sessionId");
  const sessionId =
    source === "result"
      ? stringValue(output, "sessionId")
      : (argumentSessionId ?? stringValue(output, "sessionId"));
  if (!sessionId) return title ? [text(quoted(title))] : [];
  return [{ kind: "chat", sessionId, threadId: stringValue(output, "threadId"), title }];
}

const chatTitleArgument = (call: CodexDynamicToolCallView) =>
  stringValue(asRecord(call.arguments), "title");

function resolveSessionQueue(call: CodexDynamicToolCallView): NodexToolActivity {
  switch (stringValue(asRecord(call.arguments), "action")) {
    case "edit":
      return activity(
        call,
        "chat",
        verb("Editing queued message", "Edited queued message", "edit queued message"),
      );
    case "remove":
      return activity(
        call,
        "chat",
        verb("Removing queued message", "Removed queued message", "remove queued message"),
      );
    case "reorder":
      return activity(
        call,
        "chat",
        verb("Reordering queued messages", "Reordered queued messages", "reorder queued messages"),
      );
    case "steer":
      return activity(
        call,
        "chat",
        verb("Sending queued message", "Sent queued message", "send queued message"),
      );
    default:
      return activity(
        call,
        "chat",
        verb("Reading message queue", "Read message queue", "read message queue"),
      );
  }
}

function resolveAutomation(call: CodexDynamicToolCallView): NodexToolActivity {
  const args = asRecord(call.arguments);
  const name = stringValue(args, "name");
  const named = name ? [text(quoted(name))] : [];
  switch (stringValue(args, "operation")) {
    case "list":
      return activity(
        call,
        "schedule",
        verb("Listing automations", "Listed automations", "list automations"),
      );
    case "view":
      return activity(
        call,
        "schedule",
        verb("Reading automation", "Read automation", "read automation"),
        named,
      );
    case "create":
      return activity(
        call,
        "schedule",
        verb("Creating automation", "Created automation", "create automation"),
        named,
      );
    case "update":
      return activity(
        call,
        "schedule",
        verb("Updating automation", "Updated automation", "update automation"),
        named,
      );
    case "delete":
      return activity(
        call,
        "schedule",
        verb("Deleting automation", "Deleted automation", "delete automation"),
        named,
      );
    case "suggested_update":
      return activity(
        call,
        "schedule",
        verb(
          "Proposing automation change",
          "Proposed automation change",
          "propose automation change",
        ),
        named,
      );
    default:
      return activity(
        call,
        "schedule",
        verb("Proposing automation", "Proposed automation", "propose automation"),
        named,
      );
  }
}

/** A Page a work tool names: a Page key reads as itself, an identity resolves to its name. */
function workPagePart(value: string | null, fallback: string): NodexToolActivityPart {
  if (!value) return text(fallback);
  return parseCanonicalPageKey(value.toUpperCase()) ? text(value) : pagePart(value);
}

function resolveReportWork(call: CodexDynamicToolCallView): NodexToolActivity {
  const args = asRecord(call.arguments);
  const page = workPagePart(stringValue(args, "pageId"), "work");
  switch (stringValue(args, "outcome")) {
    case "ready":
      return activity(
        call,
        "task",
        verb("Marking", "Marked", "mark"),
        [page, text("ready for review")],
        authored(call),
      );
    case "dropped":
      return activity(call, "task", verb("Dropping", "Dropped", "drop"), [page], authored(call));
    case "blocked":
    case "failed":
      return activity(
        call,
        "task",
        verb("Reporting", "Reported", "report"),
        [page, text(stringValue(args, "outcome")!)],
        authored(call),
      );
    default:
      return activity(
        call,
        "task",
        verb("Reporting on", "Reported on", "report on"),
        [page],
        authored(call),
      );
  }
}

/** A followed GitHub thread by the number its readers know it by. */
function resolveFollowThread(call: CodexDynamicToolCallView): NodexToolActivity {
  const url = stringValue(asRecord(call.arguments), "url");
  const match = url?.match(/\/(pull|issues)\/(\d+)(?:[/?#]|$)/u);
  const thread = match
    ? `${match[1] === "pull" ? "pull request" : "issue"} #${match[2]}`
    : "GitHub thread";
  return activity(call, "task", verb("Following", "Followed", "follow"), [text(thread)]);
}

/** How many distinct Inbox messages a routing response covers. */
function routedMessageCount(call: CodexDynamicToolCallView): number {
  const pageIds = asArray(asRecord(call.arguments)?.suggestions).flatMap((suggestion) =>
    asArray(asRecord(suggestion)?.page_ids).filter((id) => typeof id === "string"),
  );
  return new Set(pageIds).size;
}

/** The surface a tab or presentation call opens, by the name the reader knows it by. */
function resolveOpen(call: CodexDynamicToolCallView): NodexToolActivity {
  const target = asRecord(asRecord(call.arguments)?.target);
  const open = verb("Opening", "Opened", "open");
  const pageId = stringValue(target, "pageId");
  switch (stringValue(target, "kind")) {
    case "page":
      return activity(call, "page", open, [pageId ? pagePart(pageId) : text("page")]);
    case "page_file":
      return activity(call, "page", open, [text("Page file")]);
    case "file": {
      const path = stringValue(target, "path");
      return activity(call, "workspace", open, [
        text(path ? path.split(/[\\/]/u).at(-1)! : "file"),
      ]);
    }
    case "view":
      return activity(call, "database", open, [text("view")]);
    case "canvas":
      return activity(call, "workspace", open, [text("canvas")]);
    case "browser":
      return activity(call, "workspace", open, [text("browser tab")]);
    case "files":
      return activity(call, "workspace", open, [text("files")]);
    case "review":
      return activity(call, "workspace", open, [text("review")]);
    case "terminal":
      return activity(call, "terminal", open, [text("terminal")]);
    default:
      return activity(call, "workspace", open, [text("tab")]);
  }
}

type Resolver = (call: CodexDynamicToolCallView) => NodexToolActivity;

/** A tool whose sentence never varies. */
const fixed =
  (icon: NodexToolActivityIcon, active: string, completed: string, infinitive: string): Resolver =>
  (call) =>
    activity(call, icon, verb(active, completed, infinitive));

const NODEX_TOOL_ACTIVITY = {
  // Pages and Databases
  fetch: resolveFetch,
  search: resolveSearch,
  query_database_view: (call) => resolveQuery(call, "view"),
  query_data_source: (call) => resolveQuery(call, "data source"),
  create_pages: resolveCreatePages,
  update_page: resolveUpdatePage,
  set_page_properties: resolveSetPageProperties,
  advanced_update_page: resolveAdvancedUpdatePage,
  move_pages: resolveMovePages,
  duplicate_page: resolveDuplicatePage,
  get_context: fixed(
    "project",
    "Reading project context",
    "Read project context",
    "read project context",
  ),
  query_content: fixed(
    "database",
    "Querying Library content",
    "Queried Library content",
    "query Library content",
  ),
  describe_content_schema: fixed(
    "database",
    "Reading Library schema",
    "Read Library schema",
    "read Library schema",
  ),
  list_projects: fixed("project", "Listing projects", "Listed projects", "list projects"),

  // Chats
  create_session: (call) => {
    const title = chatTitleArgument(call);
    return activity(
      call,
      "chat",
      verb("Creating chat", "Created chat", "create chat"),
      chatPart(call, "result", title),
      authored(call),
    );
  },
  fork_session: (call) =>
    activity(
      call,
      "chat",
      verb("Forking chat", "Forked chat", "fork chat"),
      chatPart(call, "result"),
    ),
  merge_session_back: fixed("chat", "Merging fork back", "Merged fork back", "merge fork back"),
  send_message_to_session: (call) =>
    activity(
      call,
      "chat",
      verb("Messaging chat", "Messaged chat", "message chat"),
      chatPart(call, "argument"),
      authored(call),
    ),
  read_session: (call) =>
    activity(
      call,
      "chat",
      verb("Reading chat", "Read chat", "read chat"),
      chatPart(call, "argument"),
      { repeat: REPEAT_READ_CHATS },
    ),
  list_sessions: (call) => {
    const query = stringValue(asRecord(call.arguments), "query");
    return activity(
      call,
      "chat",
      verb("Listing chats", "Listed chats", "list chats"),
      query ? [text(`matching ${quoted(query)}`)] : [],
    );
  },
  list_archived_sessions: fixed(
    "chat",
    "Listing archived chats",
    "Listed archived chats",
    "list archived chats",
  ),
  search_sessions: (call) => {
    const query = stringValue(asRecord(call.arguments), "query");
    return activity(
      call,
      "search",
      verb("Searching chats", "Searched chats", "search chats"),
      query ? [text(`for ${quoted(query)}`)] : [],
    );
  },
  wait_sessions: (call) => {
    const targets = asArray(asRecord(call.arguments)?.targets);
    const only = targets.length === 1 ? stringValue(asRecord(targets[0]), "sessionId") : null;
    const wait = (subject: string) =>
      verb(`Waiting for ${subject}`, `Waited for ${subject}`, `wait for ${subject}`);
    return only
      ? activity(call, "chat", wait("chat"), [
          { kind: "chat", sessionId: only, threadId: null, title: null },
        ])
      : activity(call, "chat", wait(targets.length > 1 ? plural(targets.length, "chat") : "chats"));
  },
  session_question: (call) =>
    stringValue(asRecord(call.arguments), "action") === "respond"
      ? activity(call, "chat", verb("Answering question", "Answered question", "answer question"))
      : activity(call, "chat", verb("Reading questions", "Read questions", "read questions")),
  session_queue: resolveSessionQueue,
  handoff_session: (call) =>
    activity(
      call,
      "chat",
      verb("Handing off chat", "Handed off chat", "hand off chat"),
      chatPart(call, "argument"),
    ),
  get_handoff_status: fixed(
    "chat",
    "Checking handoff status",
    "Checked handoff status",
    "check handoff status",
  ),
  set_session_title: (call) => {
    const title = chatTitleArgument(call);
    return activity(
      call,
      "chat",
      verb("Renaming chat", "Renamed chat", "rename chat"),
      title ? [text(`to ${quoted(title)}`)] : [],
    );
  },
  set_session_archived: (call) =>
    asRecord(call.arguments)?.archived === false
      ? activity(
          call,
          "chat",
          verb("Restoring chat", "Restored chat", "restore chat"),
          chatPart(call, "argument"),
        )
      : activity(
          call,
          "chat",
          verb("Archiving chat", "Archived chat", "archive chat"),
          chatPart(call, "argument"),
        ),
  set_session_pinned: (call) =>
    asRecord(call.arguments)?.pinned === false
      ? activity(
          call,
          "chat",
          verb("Unpinning chat", "Unpinned chat", "unpin chat"),
          chatPart(call, "argument"),
        )
      : activity(
          call,
          "chat",
          verb("Pinning chat", "Pinned chat", "pin chat"),
          chatPart(call, "argument"),
        ),
  set_session_reminder: (call) =>
    asRecord(call.arguments)?.remindAt === null
      ? activity(
          call,
          "chat",
          verb("Clearing chat reminder", "Cleared chat reminder", "clear chat reminder"),
        )
      : activity(
          call,
          "chat",
          verb("Setting chat reminder", "Set chat reminder", "set chat reminder"),
        ),
  set_session_unread: (call) =>
    asRecord(call.arguments)?.unread === false
      ? activity(call, "chat", verb("Marking chat read", "Marked chat read", "mark chat read"))
      : activity(
          call,
          "chat",
          verb("Marking chat unread", "Marked chat unread", "mark chat unread"),
        ),
  stop_session: (call) =>
    activity(
      call,
      "chat",
      verb("Stopping chat", "Stopped chat", "stop chat"),
      chatPart(call, "argument"),
    ),
  navigate_to_session: (call) =>
    activity(
      call,
      "chat",
      verb("Opening chat", "Opened chat", "open chat"),
      chatPart(call, "argument"),
    ),
  read_session_terminal: fixed("terminal", "Reading terminal", "Read terminal", "read terminal"),

  // Workspace
  get_session_context: fixed("workspace", "Reading workspace", "Read workspace", "read workspace"),
  list_session_tabs: fixed("workspace", "Listing open tabs", "Listed open tabs", "list open tabs"),
  list_tab_groups: fixed("workspace", "Listing tab groups", "Listed tab groups", "list tab groups"),
  read_tab_content: fixed("workspace", "Reading open tab", "Read open tab", "read open tab"),
  query_displayed_view: fixed(
    "database",
    "Reading displayed view",
    "Read displayed view",
    "read displayed view",
  ),
  open_tab: resolveOpen,
  open_in_nodex: resolveOpen,
  activate_tab: fixed("workspace", "Switching tab", "Switched tab", "switch tab"),
  close_tab: fixed("workspace", "Closing tab", "Closed tab", "close tab"),
  move_tab: fixed("workspace", "Moving tab", "Moved tab", "move tab"),
  reorder_tabs: fixed("workspace", "Reordering tabs", "Reordered tabs", "reorder tabs"),
  split_tab_group: fixed("workspace", "Splitting tab group", "Split tab group", "split tab group"),
  merge_tab_group: fixed(
    "workspace",
    "Merging tab groups",
    "Merged tab groups",
    "merge tab groups",
  ),
  set_panel_state: fixed(
    "workspace",
    "Updating panel layout",
    "Updated panel layout",
    "update panel layout",
  ),

  // Sidebar
  list_sidebar_sections: fixed(
    "workspace",
    "Listing sidebar sections",
    "Listed sidebar sections",
    "list sidebar sections",
  ),
  list_sidebar_section_items: fixed(
    "workspace",
    "Listing sidebar section",
    "Listed sidebar section",
    "list sidebar section",
  ),
  list_sidebar_order: fixed(
    "workspace",
    "Reading sidebar order",
    "Read sidebar order",
    "read sidebar order",
  ),
  reorder_sidebar_projects: fixed(
    "workspace",
    "Reordering sidebar projects",
    "Reordered sidebar projects",
    "reorder sidebar projects",
  ),
  reorder_section: fixed(
    "workspace",
    "Reordering sidebar section",
    "Reordered sidebar section",
    "reorder sidebar section",
  ),
  reorder_sidebar_sections: fixed(
    "workspace",
    "Reordering sidebar sections",
    "Reordered sidebar sections",
    "reorder sidebar sections",
  ),
  create_sidebar_section: (call) => {
    const name = stringValue(asRecord(call.arguments), "name");
    return activity(
      call,
      "workspace",
      verb("Creating sidebar section", "Created sidebar section", "create sidebar section"),
      name ? [text(quoted(name))] : [],
    );
  },
  rename_sidebar_section: (call) => {
    const name = stringValue(asRecord(call.arguments), "name");
    return activity(
      call,
      "workspace",
      verb("Renaming sidebar section", "Renamed sidebar section", "rename sidebar section"),
      name ? [text(`to ${quoted(name)}`)] : [],
    );
  },
  delete_sidebar_section: fixed(
    "workspace",
    "Deleting sidebar section",
    "Deleted sidebar section",
    "delete sidebar section",
  ),
  move_project_to_sidebar_section: fixed(
    "workspace",
    "Moving project in sidebar",
    "Moved project in sidebar",
    "move project in sidebar",
  ),
  move_session_to_sidebar_section: fixed(
    "workspace",
    "Moving chat in sidebar",
    "Moved chat in sidebar",
    "move chat in sidebar",
  ),

  // Account, plugins, Inbox and automations
  get_usage_limits: fixed(
    "account",
    "Checking usage limits",
    "Checked usage limits",
    "check usage limits",
  ),
  consume_usage_reset: fixed(
    "account",
    "Using a usage reset",
    "Used a usage reset",
    "use a usage reset",
  ),
  uninstall_plugin: (call) => {
    const plugin = stringValue(asRecord(call.arguments), "plugin");
    return activity(
      call,
      "plugin",
      verb("Uninstalling plugin", "Uninstalled plugin", "uninstall plugin"),
      plugin ? [text(quoted(plugin))] : [],
    );
  },
  send_to_inbox: (call) => {
    const title = chatTitleArgument(call);
    return activity(
      call,
      "inbox",
      verb("Sending to Inbox", "Sent to Inbox", "send to Inbox"),
      title ? [text(quoted(title))] : [],
      authored(call),
    );
  },
  automations_update: resolveAutomation,
  load_workspace_dependencies: fixed(
    "account",
    "Loading workspace dependencies",
    "Loaded workspace dependencies",
    "load workspace dependencies",
  ),
  get_app_capabilities: fixed(
    "account",
    "Checking available tools",
    "Checked available tools",
    "check available tools",
  ),

  // Page work and coordination
  start_work: (call) =>
    activity(call, "task", verb("Starting work on", "Started work on", "start work on"), [
      workPagePart(stringValue(asRecord(call.arguments), "pageId"), "page"),
    ]),
  report_work: resolveReportWork,
  follow_thread: resolveFollowThread,
  hand_back_message: (call) =>
    activity(
      call,
      "inbox",
      verb(
        "Handing message back to Inbox",
        "Handed message back to Inbox",
        "hand message back to Inbox",
      ),
      [],
      authored(call),
    ),
  reply_to_origin: (call) =>
    activity(
      call,
      "task",
      verb("Replying on GitHub about", "Replied on GitHub about", "reply on GitHub about"),
      [workPagePart(stringValue(asRecord(call.arguments), "pageId"), "work")],
      authored(call),
    ),
  inbox_suggest: (call) => {
    const count = routedMessageCount(call);
    return activity(call, "inbox", verb("Routing", "Routed", "route"), [
      text(count > 0 ? plural(count, "Inbox message") : "Inbox messages"),
    ]);
  },
  write_turn_note: (call) =>
    activity(
      call,
      "task",
      verb("Writing note on", "Wrote note on", "write note on"),
      [workPagePart(stringValue(asRecord(call.arguments), "pageId"), "page")],
      authored(call),
    ),
  answer_inbox_question: (call) =>
    activity(
      call,
      "inbox",
      verb("Answering Inbox question", "Answered Inbox question", "answer Inbox question"),
      [],
      authored(call),
    ),
  automation_assessment_read: fixed(
    "schedule",
    "Reading automation evidence",
    "Read automation evidence",
    "read automation evidence",
  ),
  automation_assessment_submit: (call) => {
    const count = asArray(asRecord(call.arguments)?.automation_assessments).length;
    return activity(call, "schedule", verb("Judging", "Judged", "judge"), [
      text(count > 0 ? plural(count, "automation") : "automations"),
    ]);
  },

  // Delegated tasks
  list_agent_models: fixed(
    "task",
    "Listing Agent models",
    "Listed Agent models",
    "list Agent models",
  ),
  delegate_task: fixed("task", "Delegating task", "Delegated task", "delegate task"),
  task_status: fixed(
    "task",
    "Checking delegated task",
    "Checked delegated task",
    "check delegated task",
  ),
  task_wait: fixed(
    "task",
    "Waiting for delegated task",
    "Waited for delegated task",
    "wait for delegated task",
  ),
  task_send: fixed(
    "task",
    "Messaging delegated task",
    "Messaged delegated task",
    "message delegated task",
  ),
  task_question: fixed(
    "task",
    "Answering delegated task",
    "Answered delegated task",
    "answer delegated task",
  ),
  task_read: fixed("task", "Reading delegated task", "Read delegated task", "read delegated task"),
  task_cancel: fixed(
    "task",
    "Cancelling delegated task",
    "Cancelled delegated task",
    "cancel delegated task",
  ),
  stop_workflow: fixed("task", "Stopping workflow", "Stopped workflow", "stop workflow"),
} satisfies Record<string, Resolver>;

export const NODEX_TOOL_ACTIVITY_TOOLS = Object.keys(NODEX_TOOL_ACTIVITY);

/** Bounds a row's expanded list; the exact output stays available beside it. */
export const boundNodexRelatedPages = (pages: readonly NodexToolRelatedPage[]) => ({
  shown: pages.slice(0, MAX_RELATED_PAGES),
  hiddenCount: Math.max(0, pages.length - MAX_RELATED_PAGES),
});

function readResultPages(call: CodexDynamicToolCallView, data: UnknownRecord | null) {
  const args = asRecord(call.arguments);
  switch (call.tool) {
    case "search":
      return asArray(data?.results).flatMap((value) => {
        const result = asRecord(value);
        return result?.kind === "block"
          ? relatedPage(
              stringValue(result, "ownerPageId"),
              result,
              null,
              stringValue(result, "excerpt"),
            )
          : relatedPage(stringValue(result, "id"), result, stringValue(result, "title"));
      });
    case "query_database_view":
    case "query_data_source":
      return asArray(data?.rows).flatMap((value) => {
        const row = asRecord(value);
        return relatedPage(stringValue(row, "pageId"), row, stringValue(row, "title"));
      });
    case "create_pages": {
      const drafts = asArray(args?.pages).map(asRecord);
      return asArray(data?.pages).flatMap((value, index) => {
        const page = asRecord(value);
        return relatedPage(
          stringValue(page, "pageId"),
          page,
          inlineMarkdownText(stringValue(drafts[index] ?? null, "title")),
        );
      });
    }
    case "move_pages":
      return asArray(args?.pageIds).flatMap((pageId) =>
        typeof pageId === "string" ? relatedPage(pageId, null, null) : [],
      );
    default:
      return [];
  }
}

const IDENTITY_PATTERN = /\s*\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/giu;

/** A failure's words reach a person without the identities they cite; the inspector keeps them. */
const withoutIdentities = (message: string): string => message.replace(IDENTITY_PATTERN, "");

/**
 * The result of an opened row. It may parse a whole Page, so only an opened row asks for it, and
 * a settled row's digest is not mistaken for a result: withheld output reads as nothing yet.
 */
export function readNodexToolDetail(call: CodexDynamicToolCallView): NodexToolDetail {
  const text = call.outputOmitted ? null : firstOutputText(call);
  const output = text === null ? null : unwrapToolResult(text);
  const data = asRecord(output?.data) ?? output;
  if (isFailed(call)) {
    return {
      document: null,
      message: null,
      pages: [],
      failure:
        text === null
          ? null
          : withoutIdentities(stringValue(output, "message") ?? formatToolResultText(text)),
    };
  }
  const content = call.tool === "fetch" ? asRecord(data?.content) : null;
  const document =
    content?.format === "markdown"
      ? rawString(content, "markdown")
      : content?.format === "summary"
        ? rawString(content, "text")
        : null;
  return {
    document,
    message: readAuthoredMessage(call),
    pages: readResultPages(call, data),
    failure: null,
  };
}

const RESOURCE_BLOCK_TYPES: ReadonlySet<string> = new Set([
  "database",
  "canvas",
  "databaseViewRef",
  "syncedBlockRef",
]);

/**
 * A read Page's body for reading: child Pages lift out to links under their own names, and blocks
 * that only embed another resource leave, since all a read-only line could show for them is an
 * identity. Opening the Page shows them in place.
 */
export function splitNodexDocumentBlocks(blocks: readonly MarkdownBlock[]): {
  readonly blocks: readonly MarkdownBlock[];
  readonly childPageIds: readonly string[];
} {
  const childPageIds: string[] = [];
  const keep = (items: readonly MarkdownBlock[]): MarkdownBlock[] =>
    items.flatMap((block) => {
      if (block.type === "page") {
        if (block.id) childPageIds.push(block.id);
        return [];
      }
      if (RESOURCE_BLOCK_TYPES.has(block.type)) return [];
      return block.children ? [{ ...block, children: keep(block.children) }] : [block];
    });
  return { blocks: keep(blocks), childPageIds };
}

export function resolveNodexToolActivity(call: CodexDynamicToolCallView): NodexToolActivity | null {
  if (call.namespace !== "nodex_app" || !Object.hasOwn(NODEX_TOOL_ACTIVITY, call.tool)) return null;
  return NODEX_TOOL_ACTIVITY[call.tool as keyof typeof NODEX_TOOL_ACTIVITY](call);
}

/** Lowercases a clause that follows another in a group summary, keeping proper nouns intact. */
export function asFollowingClause(sentence: string): string {
  return sentence.charAt(0).toLowerCase() + sentence.slice(1);
}

/** A sentence for rendering: adjacent words stay one string so they read and wrap as prose. */
export function joinNodexActivityParts(
  parts: readonly NodexToolActivityPart[],
  following: boolean,
): ReadonlyArray<string | Exclude<NodexToolActivityPart, { kind: "text" }>> {
  const segments: Array<string | Exclude<NodexToolActivityPart, { kind: "text" }>> = [];
  const appendProse = (words: string) => {
    const previous = segments.at(-1);
    if (typeof previous === "string") segments[segments.length - 1] = `${previous}${words}`;
    else if (words) segments.push(words);
  };
  parts.forEach((part, index) => {
    const spacer = index === 0 ? "" : " ";
    if (part.kind === "text") {
      appendProse(
        `${spacer}${index === 0 && following ? asFollowingClause(part.text) : part.text}`,
      );
      return;
    }
    appendProse(spacer);
    segments.push(part);
  });
  return segments;
}

/**
 * Settled calls of one kind read as a single clause in a collapsed group. Returns, per call, the
 * clause to show, or null when an earlier call's clause already accounts for it. Calls without a
 * repeat form, and lone calls of a kind, keep their own sentence (undefined).
 */
export function summarizeRepeatedNodexCalls(
  calls: readonly CodexDynamicToolCallView[],
): ReadonlyMap<string, string | null> {
  const callsByKey = new Map<string, { label: NodexToolActivityRepeat["label"]; ids: string[] }>();
  for (const call of calls) {
    const repeat = isFailed(call) ? null : resolveNodexToolActivity(call)?.repeat;
    if (!repeat) continue;
    const group = callsByKey.get(repeat.key) ?? { label: repeat.label, ids: [] };
    group.ids.push(call.callId);
    callsByKey.set(repeat.key, group);
  }
  const clauses = new Map<string, string | null>();
  for (const { label, ids } of callsByKey.values()) {
    if (ids.length < 2) continue;
    ids.forEach((id, index) => clauses.set(id, index === 0 ? label(ids.length) : null));
  }
  return clauses;
}
