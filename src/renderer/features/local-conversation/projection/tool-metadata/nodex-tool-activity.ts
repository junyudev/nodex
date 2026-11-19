import { defineMessages, getIntl, type MessageDescriptor } from "@/lib/i18n";
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

type CountedNodexSubject =
  | "edit"
  | "block change"
  | "page"
  | "result"
  | "row"
  | "chat"
  | "Inbox message"
  | "automation";

const countMessages = defineMessages<Record<CountedNodexSubject, { count: number }>>({
  edit: {
    id: "conversation.nodexToolActivity.editCount",
    defaultMessage: "{count, plural, one {# edit} other {# edits}}",
  },
  "block change": {
    id: "conversation.nodexToolActivity.blockChangeCount",
    defaultMessage: "{count, plural, one {# block change} other {# block changes}}",
  },
  page: {
    id: "conversation.nodexToolActivity.pageCount",
    defaultMessage: "{count, plural, one {# page} other {# pages}}",
  },
  result: {
    id: "conversation.nodexToolActivity.resultCount",
    defaultMessage: "{count, plural, one {# result} other {# results}}",
  },
  row: {
    id: "conversation.nodexToolActivity.rowCount",
    defaultMessage: "{count, plural, one {# row} other {# rows}}",
  },
  chat: {
    id: "conversation.nodexToolActivity.chatCount",
    defaultMessage: "{count, plural, one {# chat} other {# chats}}",
  },
  "Inbox message": {
    id: "conversation.nodexToolActivity.inboxMessageCount",
    defaultMessage: "{count, plural, one {# Inbox message} other {# Inbox messages}}",
  },
  automation: {
    id: "conversation.nodexToolActivity.automationCount",
    defaultMessage: "{count, plural, one {# automation} other {# automations}}",
  },
});

const plural = (count: number, noun: keyof typeof countMessages): string =>
  getIntl().formatMessage(countMessages[noun], { count });

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

function activityPhase(call: CodexDynamicToolCallView): "failed" | "completed" | "active" {
  if (isFailed(call)) return "failed";
  return call.completed ? "completed" : "active";
}

const text = (value: string): NodexToolActivityPart => ({ kind: "text", text: value });

const pagePart = (pageId: string, title: string | null = null): NodexToolActivityPart => ({
  kind: "page",
  pageId,
  title,
});

const CHINESE_TEXT = /[\u2e80-\u9fff\u3000-\u303f\uff00-\uffef“”‘’]/u;

/**
 * The gap between two words of an assembled sentence. English always keeps a space; Chinese
 * drops it where both sides are Chinese text or full-width punctuation, as in “已更新属性：“页面””.
 */
function wordGap(before: string | null | undefined, after: string | null | undefined): string {
  if (!getIntl().locale.startsWith("zh")) return " ";
  const last = before?.at(-1);
  const first = after?.at(0);
  return last && first && CHINESE_TEXT.test(last) && CHINESE_TEXT.test(first) ? "" : " ";
}

/** The sentence without live names: a known title in quotes, an unknown Page by its kind. */
function formatActivityLabel(parts: readonly NodexToolActivityPart[]): string {
  return parts
    .flatMap((part) => {
      if (part.kind === "text") return [part.text];
      if (part.title) return [quoted(part.title)];
      return part.kind === "page"
        ? [
            getIntl().formatMessage({
              id: "conversation.nodexToolActivity.page",
              defaultMessage: "page",
            }),
          ]
        : [];
    })
    .reduce(
      (sentence, word) => (sentence ? `${sentence}${wordGap(sentence, word)}${word}` : word),
      "",
    );
}

function activity(
  call: CodexDynamicToolCallView,
  icon: NodexToolActivityIcon,
  message: MessageDescriptor,
  parts: readonly NodexToolActivityPart[] = [],
  details: Partial<Pick<NodexToolActivity, "change" | "expandable" | "repeat">> = {},
  values?: Record<string, string>,
): NodexToolActivity {
  const sentence = [
    text(getIntl().formatMessage(message, { ...values, phase: activityPhase(call) })),
    ...parts,
  ];
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

const resultCountParts = (
  count: number | null,
  noun: keyof typeof countMessages,
): readonly NodexToolActivityPart[] => (count === null ? [] : [text(`· ${plural(count, noun)}`)]);

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
      label:
        kind === "insert"
          ? getIntl().formatMessage({
              id: "conversation.nodexToolActivity.addedContent",
              defaultMessage: "Added content",
            })
          : getIntl().formatMessage({
              id: "conversation.nodexToolActivity.replacedContent",
              defaultMessage: "Replaced content",
            }),
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
      lines.push({
        kind: "separator",
        text: getIntl().formatMessage(
          { id: "conversation.nodexToolActivity.editOrdinal", defaultMessage: "Edit {ordinal}" },
          { ordinal: patchIndex + 1 },
        ),
      });
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
      return preposition === "to"
        ? [
            text(
              getIntl().formatMessage({
                id: "conversation.nodexToolActivity.toLibrary",
                defaultMessage: "to Library",
              }),
            ),
          ]
        : [];
    case "page": {
      const pageId = stringValue(destination, "pageId");
      return pageId
        ? [
            text(
              getIntl().formatMessage(
                {
                  id: "conversation.nodexToolActivity.pageDestination",
                  defaultMessage: "{direction, select, in {in} other {to}}",
                },
                { direction: preposition },
              ),
            ),
            pagePart(pageId),
          ]
        : [];
    }
    case "data_source":
      return [
        text(
          getIntl().formatMessage(
            {
              id: "conversation.nodexToolActivity.databaseDestination",
              defaultMessage: "{direction, select, in {in a database} other {to a database}}",
            },
            { direction: preposition },
          ),
        ),
      ];
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

const REPEAT_READ_PAGES = repeatAs("read-pages", (count) =>
  getIntl().formatMessage(
    { id: "conversation.nodexToolActivity.readPages", defaultMessage: "Read {count} pages" },
    { count },
  ),
);
const REPEAT_UPDATE_PAGES = repeatAs("update-pages", (count) =>
  getIntl().formatMessage(
    { id: "conversation.nodexToolActivity.updatedPages", defaultMessage: "Updated {count} pages" },
    { count },
  ),
);
const REPEAT_SEARCHES = repeatAs("searches", (count) =>
  getIntl().formatMessage(
    { id: "conversation.nodexToolActivity.ranSearches", defaultMessage: "Ran {count} searches" },
    { count },
  ),
);
const REPEAT_QUERIES = repeatAs("queries", (count) =>
  getIntl().formatMessage(
    { id: "conversation.nodexToolActivity.ranQueries", defaultMessage: "Ran {count} queries" },
    { count },
  ),
);
const REPEAT_READ_CHATS = repeatAs("read-chats", (count) =>
  getIntl().formatMessage(
    { id: "conversation.nodexToolActivity.readChats", defaultMessage: "Read {count} chats" },
    { count },
  ),
);

const READ = {
  id: "conversation.nodexToolActivity.read",
  defaultMessage: "{phase, select, active {Reading} failed {Couldn't read} other {Read}}",
};

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
      [
        text(
          title
            ? quoted(title)
            : isDatabase
              ? getIntl().formatMessage({
                  id: "conversation.nodexToolActivity.database",
                  defaultMessage: "database",
                })
              : getIntl().formatMessage({
                  id: "conversation.nodexToolActivity.block",
                  defaultMessage: "block",
                }),
        ),
      ],
      details,
    );
  }
  return activity(
    call,
    "page",
    READ,
    id
      ? [pagePart(id, title)]
      : [
          text(
            getIntl().formatMessage({
              id: "conversation.nodexToolActivity.page",
              defaultMessage: "page",
            }),
          ),
        ],
    details,
  );
}

function resolveSearch(call: CodexDynamicToolCallView): NodexToolActivity {
  const args = asRecord(call.arguments);
  const query = stringValue(args, "query");
  const kinds = Array.isArray(args?.kinds)
    ? args.kinds
    : args?.target === "pages"
      ? ["page"]
      : args?.target === "blocks"
        ? ["block"]
        : [];
  const subject =
    kinds.length === 1 && kinds[0] === "block"
      ? getIntl().formatMessage({
          id: "conversation.nodexToolActivity.blocks",
          defaultMessage: "blocks",
        })
      : kinds.length === 1 && kinds[0] === "page"
        ? getIntl().formatMessage({
            id: "conversation.nodexToolActivity.pages",
            defaultMessage: "pages",
          })
        : kinds.length === 1 && kinds[0] === "chat"
          ? getIntl().formatMessage({
              id: "conversation.nodexToolActivity.chats",
              defaultMessage: "chats",
            })
          : getIntl().formatMessage({
              id: "conversation.nodexToolActivity.searchSpace",
              defaultMessage: "Space",
            });
  const count = resultCount(call, outputData(call), "results");
  return activity(
    call,
    "search",
    {
      id: "conversation.nodexToolActivity.search",
      defaultMessage:
        "{phase, select, active {Searching} failed {Couldn't search} other {Searched}}",
    },
    [
      text(
        query
          ? getIntl().formatMessage(
              {
                id: "conversation.nodexToolActivity.searchWithin",
                defaultMessage: "{subject} for {query}",
              },
              { subject, query: quoted(query) },
            )
          : subject,
      ),
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
  const source =
    noun === "view"
      ? getIntl().formatMessage({
          id: "conversation.nodexToolActivity.view",
          defaultMessage: "view",
        })
      : getIntl().formatMessage({
          id: "conversation.nodexToolActivity.dataSource",
          defaultMessage: "data source",
        });
  return activity(
    call,
    "database",
    {
      id: "conversation.nodexToolActivity.query",
      defaultMessage: "{phase, select, active {Querying} failed {Couldn't query} other {Queried}}",
    },
    [
      text(
        name
          ? getIntl().formatMessage(
              {
                id: "conversation.nodexToolActivity.namedQuerySource",
                defaultMessage: "{source} {name}",
              },
              { source, name: quoted(name) },
            )
          : source,
      ),
      ...resultCountParts(count, "row"),
    ],
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
    : text(
        onlyTitle
          ? quoted(onlyTitle)
          : count > 1
            ? plural(count, "page")
            : getIntl().formatMessage({
                id: "conversation.nodexToolActivity.page",
                defaultMessage: "page",
              }),
      );
  return activity(
    call,
    "page",
    {
      id: "conversation.nodexToolActivity.create",
      defaultMessage: "{phase, select, active {Creating} failed {Couldn't create} other {Created}}",
    },
    [subject, ...destinationParts(args?.destination, "in")],
    { expandable: call.completed && count > 1 && results.length > 0 },
  );
}

function resolveUpdatePage(call: CodexDynamicToolCallView): NodexToolActivity {
  const args = asRecord(call.arguments);
  const pageId = stringValue(args, "pageId") ?? stringValue(outputData(call), "pageId");
  const newTitle = inlineMarkdownText(stringValue(asRecord(args?.title), "markdown"));
  const change = buildMarkdownChangePreview(asRecord(args?.body));
  const page = pageId
    ? pagePart(pageId)
    : text(
        getIntl().formatMessage({
          id: "conversation.nodexToolActivity.page",
          defaultMessage: "page",
        }),
      );
  if (newTitle && !args?.body)
    return activity(
      call,
      "page",
      {
        id: "conversation.nodexToolActivity.rename",
        defaultMessage:
          "{phase, select, active {Renaming} failed {Couldn't rename} other {Renamed}}",
      },
      [
        page,
        text(
          getIntl().formatMessage(
            { id: "conversation.nodexToolActivity.renamedTo", defaultMessage: "to {name}" },
            { name: quoted(newTitle) },
          ),
        ),
      ],
    );
  return activity(
    call,
    "page",
    {
      id: "conversation.nodexToolActivity.update",
      defaultMessage: "{phase, select, active {Updating} failed {Couldn't update} other {Updated}}",
    },
    [page],
    {
      change,
      repeat: REPEAT_UPDATE_PAGES,
    },
  );
}

function resolveAdvancedUpdatePage(call: CodexDynamicToolCallView): NodexToolActivity {
  const args = asRecord(call.arguments);
  const pageId = stringValue(args, "pageId") ?? stringValue(outputData(call), "pageId");
  const edits = asArray(args?.edits);
  return activity(
    call,
    "page",
    {
      id: "conversation.nodexToolActivity.update",
      defaultMessage: "{phase, select, active {Updating} failed {Couldn't update} other {Updated}}",
    },
    [
      pageId
        ? pagePart(pageId)
        : text(
            getIntl().formatMessage({
              id: "conversation.nodexToolActivity.page",
              defaultMessage: "page",
            }),
          ),
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
  return activity(
    call,
    "page",
    {
      id: "conversation.nodexToolActivity.update",
      defaultMessage: "{phase, select, active {Updating} failed {Couldn't update} other {Updated}}",
    },
    [
      text(
        getIntl().formatMessage({
          id: "conversation.nodexToolActivity.propertiesOn",
          defaultMessage: "properties on",
        }),
      ),
      pageId
        ? pagePart(pageId)
        : text(
            pageIds.size > 1
              ? plural(pageIds.size, "page")
              : getIntl().formatMessage({
                  id: "conversation.nodexToolActivity.pages",
                  defaultMessage: "pages",
                }),
          ),
    ],
  );
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
    {
      id: "conversation.nodexToolActivity.move",
      defaultMessage: "{phase, select, active {Moving} failed {Couldn't move} other {Moved}}",
    },
    [
      only
        ? pagePart(only)
        : text(
            pageIds.length > 1
              ? plural(pageIds.length, "page")
              : getIntl().formatMessage({
                  id: "conversation.nodexToolActivity.pages",
                  defaultMessage: "pages",
                }),
          ),
      ...destinationParts(args?.destination, "to"),
    ],
    { expandable: pageIds.length > 1 },
  );
}

function resolveDuplicatePage(call: CodexDynamicToolCallView): NodexToolActivity {
  const args = asRecord(call.arguments);
  const pageId = stringValue(outputData(call), "pageId") ?? stringValue(args, "pageId");
  return activity(
    call,
    "page",
    {
      id: "conversation.nodexToolActivity.duplicate",
      defaultMessage:
        "{phase, select, active {Duplicating} failed {Couldn't duplicate} other {Duplicated}}",
    },
    [
      pageId
        ? pagePart(pageId)
        : text(
            getIntl().formatMessage({
              id: "conversation.nodexToolActivity.page",
              defaultMessage: "page",
            }),
          ),
      ...destinationParts(args?.destination, "to"),
    ],
  );
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
      return activity(call, "chat", {
        id: "conversation.nodexToolActivity.editQueuedMessage",
        defaultMessage:
          "{phase, select, active {Editing queued message} failed {Couldn't edit queued message} other {Edited queued message}}",
      });
    case "remove":
      return activity(call, "chat", {
        id: "conversation.nodexToolActivity.removeQueuedMessage",
        defaultMessage:
          "{phase, select, active {Removing queued message} failed {Couldn't remove queued message} other {Removed queued message}}",
      });
    case "reorder":
      return activity(call, "chat", {
        id: "conversation.nodexToolActivity.reorderQueuedMessages",
        defaultMessage:
          "{phase, select, active {Reordering queued messages} failed {Couldn't reorder queued messages} other {Reordered queued messages}}",
      });
    case "steer":
      return activity(call, "chat", {
        id: "conversation.nodexToolActivity.sendQueuedMessage",
        defaultMessage:
          "{phase, select, active {Sending queued message} failed {Couldn't send queued message} other {Sent queued message}}",
      });
    default:
      return activity(call, "chat", {
        id: "conversation.nodexToolActivity.readMessageQueue",
        defaultMessage:
          "{phase, select, active {Reading message queue} failed {Couldn't read message queue} other {Read message queue}}",
      });
  }
}

function resolveAutomation(call: CodexDynamicToolCallView): NodexToolActivity {
  const args = asRecord(call.arguments);
  const name = stringValue(args, "name");
  const named = name ? [text(quoted(name))] : [];
  switch (stringValue(args, "operation")) {
    case "list":
      return activity(call, "schedule", {
        id: "conversation.nodexToolActivity.listAutomations",
        defaultMessage:
          "{phase, select, active {Listing automations} failed {Couldn't list automations} other {Listed automations}}",
      });
    case "view":
      return activity(
        call,
        "schedule",
        {
          id: "conversation.nodexToolActivity.readAutomation",
          defaultMessage:
            "{phase, select, active {Reading automation} failed {Couldn't read automation} other {Read automation}}",
        },
        named,
      );
    case "create":
      return activity(
        call,
        "schedule",
        {
          id: "conversation.nodexToolActivity.createAutomation",
          defaultMessage:
            "{phase, select, active {Creating automation} failed {Couldn't create automation} other {Created automation}}",
        },
        named,
      );
    case "update":
      return activity(
        call,
        "schedule",
        {
          id: "conversation.nodexToolActivity.updateAutomation",
          defaultMessage:
            "{phase, select, active {Updating automation} failed {Couldn't update automation} other {Updated automation}}",
        },
        named,
      );
    case "delete":
      return activity(
        call,
        "schedule",
        {
          id: "conversation.nodexToolActivity.deleteAutomation",
          defaultMessage:
            "{phase, select, active {Deleting automation} failed {Couldn't delete automation} other {Deleted automation}}",
        },
        named,
      );
    case "suggested_update":
      return activity(
        call,
        "schedule",
        {
          id: "conversation.nodexToolActivity.proposeAutomationChange",
          defaultMessage:
            "{phase, select, active {Proposing automation change} failed {Couldn't propose automation change} other {Proposed automation change}}",
        },
        named,
      );
    default:
      return activity(
        call,
        "schedule",
        {
          id: "conversation.nodexToolActivity.proposeAutomation",
          defaultMessage:
            "{phase, select, active {Proposing automation} failed {Couldn't propose automation} other {Proposed automation}}",
        },
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
  const page = workPagePart(
    stringValue(args, "pageId"),
    getIntl().formatMessage({ id: "conversation.nodexToolActivity.work", defaultMessage: "work" }),
  );
  switch (stringValue(args, "outcome")) {
    case "ready":
      return activity(
        call,
        "task",
        {
          id: "conversation.nodexToolActivity.mark",
          defaultMessage: "{phase, select, active {Marking} failed {Couldn't mark} other {Marked}}",
        },
        [
          page,
          text(
            getIntl().formatMessage({
              id: "conversation.nodexToolActivity.readyForReview",
              defaultMessage: "ready for review",
            }),
          ),
        ],
        authored(call),
      );
    case "dropped":
      return activity(
        call,
        "task",
        {
          id: "conversation.nodexToolActivity.drop",
          defaultMessage:
            "{phase, select, active {Dropping} failed {Couldn't drop} other {Dropped}}",
        },
        [page],
        authored(call),
      );
    case "blocked":
    case "failed":
      return activity(
        call,
        "task",
        {
          id: "conversation.nodexToolActivity.report",
          defaultMessage:
            "{phase, select, active {Reporting} failed {Couldn't report} other {Reported}}",
        },
        [page, text(stringValue(args, "outcome")!)],
        authored(call),
      );
    default:
      return activity(
        call,
        "task",
        {
          id: "conversation.nodexToolActivity.reportOn",
          defaultMessage:
            "{phase, select, active {Reporting on} failed {Couldn't report on} other {Reported on}}",
        },
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
    ? getIntl().formatMessage(
        {
          id: "conversation.nodexToolActivity.githubTarget",
          defaultMessage: "{kind, select, pull {pull request} other {issue}} #{number}",
        },
        { kind: match[1], number: match[2] },
      )
    : getIntl().formatMessage({
        id: "conversation.nodexToolActivity.githubThread",
        defaultMessage: "GitHub thread",
      });
  return activity(
    call,
    "task",
    {
      id: "conversation.nodexToolActivity.follow",
      defaultMessage:
        "{phase, select, active {Following} failed {Couldn't follow} other {Followed}}",
    },
    [text(thread)],
  );
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
  const open = {
    id: "conversation.nodexToolActivity.open",
    defaultMessage: "{phase, select, active {Opening} failed {Couldn't open} other {Opened}}",
  };
  const pageId = stringValue(target, "pageId");
  switch (stringValue(target, "kind")) {
    case "page":
      return activity(call, "page", open, [
        pageId
          ? pagePart(pageId)
          : text(
              getIntl().formatMessage({
                id: "conversation.nodexToolActivity.page",
                defaultMessage: "page",
              }),
            ),
      ]);
    case "page_file":
      return activity(call, "page", open, [
        text(
          getIntl().formatMessage({
            id: "conversation.nodexToolActivity.pageFile",
            defaultMessage: "Page file",
          }),
        ),
      ]);
    case "file": {
      const path = stringValue(target, "path");
      return activity(call, "workspace", open, [
        text(
          path
            ? path.split(/[\\/]/u).at(-1)!
            : getIntl().formatMessage({
                id: "conversation.nodexToolActivity.file",
                defaultMessage: "file",
              }),
        ),
      ]);
    }
    case "view":
      return activity(call, "database", open, [
        text(
          getIntl().formatMessage({
            id: "conversation.nodexToolActivity.view",
            defaultMessage: "view",
          }),
        ),
      ]);
    case "canvas":
      return activity(call, "workspace", open, [
        text(
          getIntl().formatMessage({
            id: "conversation.nodexToolActivity.canvas",
            defaultMessage: "canvas",
          }),
        ),
      ]);
    case "browser":
      return activity(call, "workspace", open, [
        text(
          getIntl().formatMessage({
            id: "conversation.nodexToolActivity.browserTab",
            defaultMessage: "browser tab",
          }),
        ),
      ]);
    case "files":
      return activity(call, "workspace", open, [
        text(
          getIntl().formatMessage({
            id: "conversation.nodexToolActivity.files",
            defaultMessage: "files",
          }),
        ),
      ]);
    case "review":
      return activity(call, "workspace", open, [
        text(
          getIntl().formatMessage({
            id: "conversation.nodexToolActivity.review",
            defaultMessage: "review",
          }),
        ),
      ]);
    case "terminal":
      return activity(call, "terminal", open, [
        text(
          getIntl().formatMessage({
            id: "conversation.nodexToolActivity.terminal",
            defaultMessage: "terminal",
          }),
        ),
      ]);
    default:
      return activity(call, "workspace", open, [
        text(
          getIntl().formatMessage({
            id: "conversation.nodexToolActivity.tab",
            defaultMessage: "tab",
          }),
        ),
      ]);
  }
}

type Resolver = (call: CodexDynamicToolCallView) => NodexToolActivity;

/** A tool whose sentence never varies. */
const fixed =
  (icon: NodexToolActivityIcon, message: MessageDescriptor): Resolver =>
  (call) =>
    activity(call, icon, message);

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
  visual_check: fixed("page", {
    id: "conversation.nodexToolActivity.checkVisual",
    defaultMessage:
      "{phase, select, active {Checking Visual} failed {Couldn't check Visual} other {Checked Visual}}",
  }),
  visual_snapshot: fixed("page", {
    id: "conversation.nodexToolActivity.captureVisual",
    defaultMessage:
      "{phase, select, active {Capturing Visual} failed {Couldn't capture Visual} other {Captured Visual}}",
  }),
  get_context: fixed("project", {
    id: "conversation.nodexToolActivity.readProjectContext",
    defaultMessage:
      "{phase, select, active {Reading project context} failed {Couldn't read project context} other {Read project context}}",
  }),
  query_content: fixed("database", {
    id: "conversation.nodexToolActivity.queryLibraryContent",
    defaultMessage:
      "{phase, select, active {Querying Library content} failed {Couldn't query Library content} other {Queried Library content}}",
  }),
  describe_content_schema: fixed("database", {
    id: "conversation.nodexToolActivity.readLibrarySchema",
    defaultMessage:
      "{phase, select, active {Reading Library schema} failed {Couldn't read Library schema} other {Read Library schema}}",
  }),
  list_projects: fixed("project", {
    id: "conversation.nodexToolActivity.listProjects",
    defaultMessage:
      "{phase, select, active {Listing projects} failed {Couldn't list projects} other {Listed projects}}",
  }),

  // Page Discussions
  discussions_list: fixed("chat", {
    id: "conversation.nodexToolActivity.listDiscussions",
    defaultMessage:
      "{phase, select, active {Listing Discussions} failed {Couldn't list Discussions} other {Listed Discussions}}",
  }),
  discussions_show: fixed("chat", {
    id: "conversation.nodexToolActivity.readDiscussion",
    defaultMessage:
      "{phase, select, active {Reading Discussion} failed {Couldn't read Discussion} other {Read Discussion}}",
  }),
  discussions_create: fixed("chat", {
    id: "conversation.nodexToolActivity.openDiscussion",
    defaultMessage:
      "{phase, select, active {Opening Discussion} failed {Couldn't open Discussion} other {Opened Discussion}}",
  }),
  discussions_reply: fixed("chat", {
    id: "conversation.nodexToolActivity.replyToDiscussion",
    defaultMessage:
      "{phase, select, active {Replying to Discussion} failed {Couldn't reply to Discussion} other {Replied to Discussion}}",
  }),
  discussions_edit: fixed("chat", {
    id: "conversation.nodexToolActivity.editComment",
    defaultMessage:
      "{phase, select, active {Editing Comment} failed {Couldn't edit Comment} other {Edited Comment}}",
  }),
  discussions_delete: fixed("chat", {
    id: "conversation.nodexToolActivity.deleteComment",
    defaultMessage:
      "{phase, select, active {Deleting Comment} failed {Couldn't delete Comment} other {Deleted Comment}}",
  }),
  discussions_resolve: fixed("chat", {
    id: "conversation.nodexToolActivity.resolveDiscussion",
    defaultMessage:
      "{phase, select, active {Resolving Discussion} failed {Couldn't resolve Discussion} other {Resolved Discussion}}",
  }),
  discussions_reopen: fixed("chat", {
    id: "conversation.nodexToolActivity.reopenDiscussion",
    defaultMessage:
      "{phase, select, active {Reopening Discussion} failed {Couldn't reopen Discussion} other {Reopened Discussion}}",
  }),
  discussions_accept: (call) => {
    const comment = asRecord(outputData(call)?.value);
    const stale = asRecord(comment?.suggestedEdit)?.state === "stale";
    return activity(
      call,
      "page",
      stale
        ? {
            id: "conversation.nodexToolActivity.staleSuggestedEdit",
            defaultMessage: "Suggested edit became stale",
          }
        : {
            id: "conversation.nodexToolActivity.applySuggestedEdit",
            defaultMessage:
              "{phase, select, active {Applying Suggested edit} failed {Couldn't apply Suggested edit} other {Applied Suggested edit}}",
          },
    );
  },
  discussions_reject: fixed("page", {
    id: "conversation.nodexToolActivity.rejectSuggestedEdit",
    defaultMessage:
      "{phase, select, active {Rejecting Suggested edit} failed {Couldn't reject Suggested edit} other {Rejected Suggested edit}}",
  }),
  discussions_set_page_setting: fixed("page", {
    id: "conversation.nodexToolActivity.updateNodexAnswersSetting",
    defaultMessage:
      "{phase, select, active {Updating Nodex answers setting} failed {Couldn't update Nodex answers setting} other {Updated Nodex answers setting}}",
  }),
  discussions_revert_run: fixed("page", {
    id: "conversation.nodexToolActivity.revertRunPageChanges",
    defaultMessage:
      "{phase, select, active {Reverting Run changes on Page} failed {Couldn't revert Run changes on Page} other {Reverted Run changes on Page}}",
  }),

  // Chats
  create_session: (call) => {
    const title = chatTitleArgument(call);
    return activity(
      call,
      "chat",
      {
        id: "conversation.nodexToolActivity.createChat",
        defaultMessage:
          "{phase, select, active {Creating chat} failed {Couldn't create chat} other {Created chat}}",
      },
      chatPart(call, "result", title),
      authored(call),
    );
  },
  fork_session: (call) =>
    activity(
      call,
      "chat",
      {
        id: "conversation.nodexToolActivity.forkChat",
        defaultMessage:
          "{phase, select, active {Forking chat} failed {Couldn't fork chat} other {Forked chat}}",
      },
      chatPart(call, "result"),
    ),
  merge_session_back: fixed("chat", {
    id: "conversation.nodexToolActivity.mergeForkBack",
    defaultMessage:
      "{phase, select, active {Merging fork back} failed {Couldn't merge fork back} other {Merged fork back}}",
  }),
  send_message_to_session: (call) =>
    activity(
      call,
      "chat",
      {
        id: "conversation.nodexToolActivity.messageChat",
        defaultMessage:
          "{phase, select, active {Messaging chat} failed {Couldn't message chat} other {Messaged chat}}",
      },
      chatPart(call, "argument"),
      authored(call),
    ),
  read_session: (call) =>
    activity(
      call,
      "chat",
      {
        id: "conversation.nodexToolActivity.readChat",
        defaultMessage:
          "{phase, select, active {Reading chat} failed {Couldn't read chat} other {Read chat}}",
      },
      chatPart(call, "argument"),
      { repeat: REPEAT_READ_CHATS },
    ),
  list_sessions: (call) => {
    const query = stringValue(asRecord(call.arguments), "query");
    return activity(
      call,
      "chat",
      {
        id: "conversation.nodexToolActivity.listChats",
        defaultMessage:
          "{phase, select, active {Listing chats} failed {Couldn't list chats} other {Listed chats}}",
      },
      query
        ? [
            text(
              getIntl().formatMessage(
                {
                  id: "conversation.nodexToolActivity.matching",
                  defaultMessage: "matching {query}",
                },
                { query: quoted(query) },
              ),
            ),
          ]
        : [],
    );
  },
  list_archived_sessions: fixed("chat", {
    id: "conversation.nodexToolActivity.listArchivedChats",
    defaultMessage:
      "{phase, select, active {Listing archived chats} failed {Couldn't list archived chats} other {Listed archived chats}}",
  }),
  search_sessions: (call) => {
    const query = stringValue(asRecord(call.arguments), "query");
    return activity(
      call,
      "search",
      {
        id: "conversation.nodexToolActivity.searchChats",
        defaultMessage:
          "{phase, select, active {Searching chats} failed {Couldn't search chats} other {Searched chats}}",
      },
      query
        ? [
            text(
              getIntl().formatMessage(
                { id: "conversation.nodexToolActivity.searchQuery", defaultMessage: "for {query}" },
                { query: quoted(query) },
              ),
            ),
          ]
        : [],
    );
  },
  wait_sessions: (call) => {
    const targets = asArray(asRecord(call.arguments)?.targets);
    const only = targets.length === 1 ? stringValue(asRecord(targets[0]), "sessionId") : null;
    const subject = only
      ? getIntl().formatMessage({
          id: "conversation.nodexToolActivity.chat",
          defaultMessage: "chat",
        })
      : targets.length > 1
        ? plural(targets.length, "chat")
        : getIntl().formatMessage({
            id: "conversation.nodexToolActivity.chats",
            defaultMessage: "chats",
          });
    return activity(
      call,
      "chat",
      {
        id: "conversation.nodexToolActivity.waitForChats",
        defaultMessage:
          "{phase, select, active {Waiting for {subject}} failed {Couldn't wait for {subject}} other {Waited for {subject}}}",
      },
      only ? [{ kind: "chat", sessionId: only, threadId: null, title: null }] : [],
      {},
      { subject },
    );
  },
  session_question: (call) =>
    stringValue(asRecord(call.arguments), "action") === "respond"
      ? activity(call, "chat", {
          id: "conversation.nodexToolActivity.answerQuestion",
          defaultMessage:
            "{phase, select, active {Answering question} failed {Couldn't answer question} other {Answered question}}",
        })
      : activity(call, "chat", {
          id: "conversation.nodexToolActivity.readQuestions",
          defaultMessage:
            "{phase, select, active {Reading questions} failed {Couldn't read questions} other {Read questions}}",
        }),
  session_queue: resolveSessionQueue,
  handoff_session: (call) =>
    activity(
      call,
      "chat",
      {
        id: "conversation.nodexToolActivity.handOffChat",
        defaultMessage:
          "{phase, select, active {Handing off chat} failed {Couldn't hand off chat} other {Handed off chat}}",
      },
      chatPart(call, "argument"),
    ),
  get_handoff_status: fixed("chat", {
    id: "conversation.nodexToolActivity.checkHandoffStatus",
    defaultMessage:
      "{phase, select, active {Checking handoff status} failed {Couldn't check handoff status} other {Checked handoff status}}",
  }),
  set_session_title: (call) => {
    const title = chatTitleArgument(call);
    return activity(
      call,
      "chat",
      {
        id: "conversation.nodexToolActivity.renameChat",
        defaultMessage:
          "{phase, select, active {Renaming chat} failed {Couldn't rename chat} other {Renamed chat}}",
      },
      title
        ? [
            text(
              getIntl().formatMessage(
                { id: "conversation.nodexToolActivity.renamedTo", defaultMessage: "to {name}" },
                { name: quoted(title) },
              ),
            ),
          ]
        : [],
    );
  },
  set_session_archived: (call) =>
    asRecord(call.arguments)?.archived === false
      ? activity(
          call,
          "chat",
          {
            id: "conversation.nodexToolActivity.restoreChat",
            defaultMessage:
              "{phase, select, active {Restoring chat} failed {Couldn't restore chat} other {Restored chat}}",
          },
          chatPart(call, "argument"),
        )
      : activity(
          call,
          "chat",
          {
            id: "conversation.nodexToolActivity.archiveChat",
            defaultMessage:
              "{phase, select, active {Archiving chat} failed {Couldn't archive chat} other {Archived chat}}",
          },
          chatPart(call, "argument"),
        ),
  set_session_pinned: (call) =>
    asRecord(call.arguments)?.pinned === false
      ? activity(
          call,
          "chat",
          {
            id: "conversation.nodexToolActivity.unpinChat",
            defaultMessage:
              "{phase, select, active {Unpinning chat} failed {Couldn't unpin chat} other {Unpinned chat}}",
          },
          chatPart(call, "argument"),
        )
      : activity(
          call,
          "chat",
          {
            id: "conversation.nodexToolActivity.pinChat",
            defaultMessage:
              "{phase, select, active {Pinning chat} failed {Couldn't pin chat} other {Pinned chat}}",
          },
          chatPart(call, "argument"),
        ),
  set_session_reminder: (call) =>
    asRecord(call.arguments)?.remindAt === null
      ? activity(call, "chat", {
          id: "conversation.nodexToolActivity.clearChatReminder",
          defaultMessage:
            "{phase, select, active {Clearing chat reminder} failed {Couldn't clear chat reminder} other {Cleared chat reminder}}",
        })
      : activity(call, "chat", {
          id: "conversation.nodexToolActivity.setChatReminder",
          defaultMessage:
            "{phase, select, active {Setting chat reminder} failed {Couldn't set chat reminder} other {Set chat reminder}}",
        }),
  set_session_unread: (call) =>
    asRecord(call.arguments)?.unread === false
      ? activity(call, "chat", {
          id: "conversation.nodexToolActivity.markChatRead",
          defaultMessage:
            "{phase, select, active {Marking chat read} failed {Couldn't mark chat read} other {Marked chat read}}",
        })
      : activity(call, "chat", {
          id: "conversation.nodexToolActivity.markChatUnread",
          defaultMessage:
            "{phase, select, active {Marking chat unread} failed {Couldn't mark chat unread} other {Marked chat unread}}",
        }),
  stop_session: (call) =>
    activity(
      call,
      "chat",
      {
        id: "conversation.nodexToolActivity.stopChat",
        defaultMessage:
          "{phase, select, active {Stopping chat} failed {Couldn't stop chat} other {Stopped chat}}",
      },
      chatPart(call, "argument"),
    ),
  navigate_to_session: (call) =>
    activity(
      call,
      "chat",
      {
        id: "conversation.nodexToolActivity.openChat",
        defaultMessage:
          "{phase, select, active {Opening chat} failed {Couldn't open chat} other {Opened chat}}",
      },
      chatPart(call, "argument"),
    ),
  read_session_terminal: fixed("terminal", {
    id: "conversation.nodexToolActivity.readTerminal",
    defaultMessage:
      "{phase, select, active {Reading terminal} failed {Couldn't read terminal} other {Read terminal}}",
  }),

  // Workspace
  get_session_context: fixed("workspace", {
    id: "conversation.nodexToolActivity.readWorkspace",
    defaultMessage:
      "{phase, select, active {Reading workspace} failed {Couldn't read workspace} other {Read workspace}}",
  }),
  list_session_tabs: fixed("workspace", {
    id: "conversation.nodexToolActivity.listOpenTabs",
    defaultMessage:
      "{phase, select, active {Listing open tabs} failed {Couldn't list open tabs} other {Listed open tabs}}",
  }),
  list_tab_groups: fixed("workspace", {
    id: "conversation.nodexToolActivity.listTabGroups",
    defaultMessage:
      "{phase, select, active {Listing tab groups} failed {Couldn't list tab groups} other {Listed tab groups}}",
  }),
  read_tab_content: fixed("workspace", {
    id: "conversation.nodexToolActivity.readOpenTab",
    defaultMessage:
      "{phase, select, active {Reading open tab} failed {Couldn't read open tab} other {Read open tab}}",
  }),
  query_displayed_view: fixed("database", {
    id: "conversation.nodexToolActivity.readDisplayedView",
    defaultMessage:
      "{phase, select, active {Reading displayed view} failed {Couldn't read displayed view} other {Read displayed view}}",
  }),
  open_tab: resolveOpen,
  open_in_nodex: resolveOpen,
  activate_tab: fixed("workspace", {
    id: "conversation.nodexToolActivity.switchTab",
    defaultMessage:
      "{phase, select, active {Switching tab} failed {Couldn't switch tab} other {Switched tab}}",
  }),
  close_tab: fixed("workspace", {
    id: "conversation.nodexToolActivity.closeTab",
    defaultMessage:
      "{phase, select, active {Closing tab} failed {Couldn't close tab} other {Closed tab}}",
  }),
  move_tab: fixed("workspace", {
    id: "conversation.nodexToolActivity.moveTab",
    defaultMessage:
      "{phase, select, active {Moving tab} failed {Couldn't move tab} other {Moved tab}}",
  }),
  reorder_tabs: fixed("workspace", {
    id: "conversation.nodexToolActivity.reorderTabs",
    defaultMessage:
      "{phase, select, active {Reordering tabs} failed {Couldn't reorder tabs} other {Reordered tabs}}",
  }),
  split_tab_group: fixed("workspace", {
    id: "conversation.nodexToolActivity.splitTabGroup",
    defaultMessage:
      "{phase, select, active {Splitting tab group} failed {Couldn't split tab group} other {Split tab group}}",
  }),
  merge_tab_group: fixed("workspace", {
    id: "conversation.nodexToolActivity.mergeTabGroups",
    defaultMessage:
      "{phase, select, active {Merging tab groups} failed {Couldn't merge tab groups} other {Merged tab groups}}",
  }),
  set_panel_state: fixed("workspace", {
    id: "conversation.nodexToolActivity.updatePanelLayout",
    defaultMessage:
      "{phase, select, active {Updating panel layout} failed {Couldn't update panel layout} other {Updated panel layout}}",
  }),

  // Sidebar
  list_sidebar_sections: fixed("workspace", {
    id: "conversation.nodexToolActivity.listSidebarSections",
    defaultMessage:
      "{phase, select, active {Listing sidebar sections} failed {Couldn't list sidebar sections} other {Listed sidebar sections}}",
  }),
  list_sidebar_section_items: fixed("workspace", {
    id: "conversation.nodexToolActivity.listSidebarSection",
    defaultMessage:
      "{phase, select, active {Listing sidebar section} failed {Couldn't list sidebar section} other {Listed sidebar section}}",
  }),
  list_sidebar_order: fixed("workspace", {
    id: "conversation.nodexToolActivity.readSidebarOrder",
    defaultMessage:
      "{phase, select, active {Reading sidebar order} failed {Couldn't read sidebar order} other {Read sidebar order}}",
  }),
  reorder_sidebar_projects: fixed("workspace", {
    id: "conversation.nodexToolActivity.reorderSidebarProjects",
    defaultMessage:
      "{phase, select, active {Reordering sidebar projects} failed {Couldn't reorder sidebar projects} other {Reordered sidebar projects}}",
  }),
  reorder_section: fixed("workspace", {
    id: "conversation.nodexToolActivity.reorderSidebarSection",
    defaultMessage:
      "{phase, select, active {Reordering sidebar section} failed {Couldn't reorder sidebar section} other {Reordered sidebar section}}",
  }),
  reorder_sidebar_sections: fixed("workspace", {
    id: "conversation.nodexToolActivity.reorderSidebarSections",
    defaultMessage:
      "{phase, select, active {Reordering sidebar sections} failed {Couldn't reorder sidebar sections} other {Reordered sidebar sections}}",
  }),
  create_sidebar_section: (call) => {
    const name = stringValue(asRecord(call.arguments), "name");
    return activity(
      call,
      "workspace",
      {
        id: "conversation.nodexToolActivity.createSidebarSection",
        defaultMessage:
          "{phase, select, active {Creating sidebar section} failed {Couldn't create sidebar section} other {Created sidebar section}}",
      },
      name ? [text(quoted(name))] : [],
    );
  },
  rename_sidebar_section: (call) => {
    const name = stringValue(asRecord(call.arguments), "name");
    return activity(
      call,
      "workspace",
      {
        id: "conversation.nodexToolActivity.renameSidebarSection",
        defaultMessage:
          "{phase, select, active {Renaming sidebar section} failed {Couldn't rename sidebar section} other {Renamed sidebar section}}",
      },
      name
        ? [
            text(
              getIntl().formatMessage(
                { id: "conversation.nodexToolActivity.renamedTo", defaultMessage: "to {name}" },
                { name: quoted(name) },
              ),
            ),
          ]
        : [],
    );
  },
  delete_sidebar_section: fixed("workspace", {
    id: "conversation.nodexToolActivity.deleteSidebarSection",
    defaultMessage:
      "{phase, select, active {Deleting sidebar section} failed {Couldn't delete sidebar section} other {Deleted sidebar section}}",
  }),
  move_project_to_sidebar_section: fixed("workspace", {
    id: "conversation.nodexToolActivity.moveProjectInSidebar",
    defaultMessage:
      "{phase, select, active {Moving project in sidebar} failed {Couldn't move project in sidebar} other {Moved project in sidebar}}",
  }),
  move_session_to_sidebar_section: fixed("workspace", {
    id: "conversation.nodexToolActivity.moveChatInSidebar",
    defaultMessage:
      "{phase, select, active {Moving chat in sidebar} failed {Couldn't move chat in sidebar} other {Moved chat in sidebar}}",
  }),

  // Account, plugins, Inbox and automations
  get_usage_limits: fixed("account", {
    id: "conversation.nodexToolActivity.checkUsageLimits",
    defaultMessage:
      "{phase, select, active {Checking usage limits} failed {Couldn't check usage limits} other {Checked usage limits}}",
  }),
  consume_usage_reset: fixed("account", {
    id: "conversation.nodexToolActivity.useAUsageReset",
    defaultMessage:
      "{phase, select, active {Using a usage reset} failed {Couldn't use a usage reset} other {Used a usage reset}}",
  }),
  uninstall_plugin: (call) => {
    const plugin = stringValue(asRecord(call.arguments), "plugin");
    return activity(
      call,
      "plugin",
      {
        id: "conversation.nodexToolActivity.uninstallPlugin",
        defaultMessage:
          "{phase, select, active {Uninstalling plugin} failed {Couldn't uninstall plugin} other {Uninstalled plugin}}",
      },
      plugin ? [text(quoted(plugin))] : [],
    );
  },
  send_to_inbox: (call) => {
    const title = chatTitleArgument(call);
    return activity(
      call,
      "inbox",
      {
        id: "conversation.nodexToolActivity.sendToInbox",
        defaultMessage:
          "{phase, select, active {Sending to Inbox} failed {Couldn't send to Inbox} other {Sent to Inbox}}",
      },
      title ? [text(quoted(title))] : [],
      authored(call),
    );
  },
  automations_update: resolveAutomation,
  load_workspace_dependencies: fixed("account", {
    id: "conversation.nodexToolActivity.loadWorkspaceDependencies",
    defaultMessage:
      "{phase, select, active {Loading workspace dependencies} failed {Couldn't load workspace dependencies} other {Loaded workspace dependencies}}",
  }),
  get_app_capabilities: fixed("account", {
    id: "conversation.nodexToolActivity.checkAvailableTools",
    defaultMessage:
      "{phase, select, active {Checking available tools} failed {Couldn't check available tools} other {Checked available tools}}",
  }),

  // Page work and coordination
  start_work: (call) =>
    activity(
      call,
      "task",
      {
        id: "conversation.nodexToolActivity.startWorkOn",
        defaultMessage:
          "{phase, select, active {Starting work on} failed {Couldn't start work on} other {Started work on}}",
      },
      [
        workPagePart(
          stringValue(asRecord(call.arguments), "pageId"),
          getIntl().formatMessage({
            id: "conversation.nodexToolActivity.page",
            defaultMessage: "page",
          }),
        ),
      ],
    ),
  report_work: resolveReportWork,
  follow_thread: resolveFollowThread,
  hand_back_message: (call) =>
    activity(
      call,
      "inbox",
      {
        id: "conversation.nodexToolActivity.handMessageBackToInbox",
        defaultMessage:
          "{phase, select, active {Handing message back to Inbox} failed {Couldn't hand message back to Inbox} other {Handed message back to Inbox}}",
      },
      [],
      authored(call),
    ),
  reply_to_origin: (call) =>
    activity(
      call,
      "task",
      {
        id: "conversation.nodexToolActivity.replyOnGithubAbout",
        defaultMessage:
          "{phase, select, active {Replying on GitHub about} failed {Couldn't reply on GitHub about} other {Replied on GitHub about}}",
      },
      [
        workPagePart(
          stringValue(asRecord(call.arguments), "pageId"),
          getIntl().formatMessage({
            id: "conversation.nodexToolActivity.work",
            defaultMessage: "work",
          }),
        ),
      ],
      authored(call),
    ),
  inbox_suggest: (call) => {
    const count = routedMessageCount(call);
    return activity(
      call,
      "inbox",
      {
        id: "conversation.nodexToolActivity.route",
        defaultMessage: "{phase, select, active {Routing} failed {Couldn't route} other {Routed}}",
      },
      [
        text(
          count > 0
            ? plural(count, "Inbox message")
            : getIntl().formatMessage({
                id: "conversation.nodexToolActivity.inboxMessages",
                defaultMessage: "Inbox messages",
              }),
        ),
      ],
    );
  },
  write_turn_note: (call) =>
    activity(
      call,
      "task",
      {
        id: "conversation.nodexToolActivity.writeNoteOn",
        defaultMessage:
          "{phase, select, active {Writing note on} failed {Couldn't write note on} other {Wrote note on}}",
      },
      [
        workPagePart(
          stringValue(asRecord(call.arguments), "pageId"),
          getIntl().formatMessage({
            id: "conversation.nodexToolActivity.page",
            defaultMessage: "page",
          }),
        ),
      ],
      authored(call),
    ),
  answer_inbox_question: (call) =>
    activity(
      call,
      "inbox",
      {
        id: "conversation.nodexToolActivity.answerInboxQuestion",
        defaultMessage:
          "{phase, select, active {Answering Inbox question} failed {Couldn't answer Inbox question} other {Answered Inbox question}}",
      },
      [],
      authored(call),
    ),
  automation_assessment_read: fixed("schedule", {
    id: "conversation.nodexToolActivity.readAutomationEvidence",
    defaultMessage:
      "{phase, select, active {Reading automation evidence} failed {Couldn't read automation evidence} other {Read automation evidence}}",
  }),
  automation_assessment_submit: (call) => {
    const count = asArray(asRecord(call.arguments)?.automation_assessments).length;
    return activity(
      call,
      "schedule",
      {
        id: "conversation.nodexToolActivity.judge",
        defaultMessage: "{phase, select, active {Judging} failed {Couldn't judge} other {Judged}}",
      },
      [
        text(
          count > 0
            ? plural(count, "automation")
            : getIntl().formatMessage({
                id: "conversation.nodexToolActivity.automations",
                defaultMessage: "automations",
              }),
        ),
      ],
    );
  },

  // Delegated tasks
  list_agent_models: fixed("task", {
    id: "conversation.nodexToolActivity.listAgentModels",
    defaultMessage:
      "{phase, select, active {Listing Agent models} failed {Couldn't list Agent models} other {Listed Agent models}}",
  }),
  delegate_task: fixed("task", {
    id: "conversation.nodexToolActivity.delegateTask",
    defaultMessage:
      "{phase, select, active {Delegating task} failed {Couldn't delegate task} other {Delegated task}}",
  }),
  task_status: fixed("task", {
    id: "conversation.nodexToolActivity.checkDelegatedTask",
    defaultMessage:
      "{phase, select, active {Checking delegated task} failed {Couldn't check delegated task} other {Checked delegated task}}",
  }),
  task_wait: fixed("task", {
    id: "conversation.nodexToolActivity.waitForDelegatedTask",
    defaultMessage:
      "{phase, select, active {Waiting for delegated task} failed {Couldn't wait for delegated task} other {Waited for delegated task}}",
  }),
  task_send: fixed("task", {
    id: "conversation.nodexToolActivity.messageDelegatedTask",
    defaultMessage:
      "{phase, select, active {Messaging delegated task} failed {Couldn't message delegated task} other {Messaged delegated task}}",
  }),
  task_question: fixed("task", {
    id: "conversation.nodexToolActivity.answerDelegatedTask",
    defaultMessage:
      "{phase, select, active {Answering delegated task} failed {Couldn't answer delegated task} other {Answered delegated task}}",
  }),
  task_read: fixed("task", {
    id: "conversation.nodexToolActivity.readDelegatedTask",
    defaultMessage:
      "{phase, select, active {Reading delegated task} failed {Couldn't read delegated task} other {Read delegated task}}",
  }),
  task_cancel: fixed("task", {
    id: "conversation.nodexToolActivity.cancelDelegatedTask",
    defaultMessage:
      "{phase, select, active {Cancelling delegated task} failed {Couldn't cancel delegated task} other {Cancelled delegated task}}",
  }),
  stop_workflow: fixed("task", {
    id: "conversation.nodexToolActivity.stopWorkflow",
    defaultMessage:
      "{phase, select, active {Stopping workflow} failed {Couldn't stop workflow} other {Stopped workflow}}",
  }),
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
        if (!result || result.kind === "chat") return [];
        const evidence = asArray(result.evidence).map(asRecord);
        const text = (match: UnknownRecord | null | undefined) =>
          asArray(match?.parts)
            .map((part) => stringValue(asRecord(part), "text") ?? "")
            .join("") || null;
        if (result.kind === "block") {
          const block = evidence.find((match) => asRecord(match?.anchor)?.kind === "block");
          return relatedPage(
            stringValue(asRecord(block?.anchor), "pageId") ?? stringValue(result, "ownerPageId"),
            result,
            null,
            text(block) ?? stringValue(result, "excerpt"),
          );
        }
        const pageKey =
          stringValue(result, "pageKey") ??
          text(evidence.find((match) => match?.field === "page_key"));
        return relatedPage(
          stringValue(result, "identity") ?? stringValue(result, "id"),
          { ...result, pageKey },
          stringValue(result, "title"),
        );
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
    const previous = parts[index - 1];
    const spacer =
      index === 0
        ? ""
        : wordGap(
            previous?.kind === "text" ? previous.text : (previous?.title ?? null),
            part.kind === "text" ? part.text : (part.title ?? null),
          );
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
