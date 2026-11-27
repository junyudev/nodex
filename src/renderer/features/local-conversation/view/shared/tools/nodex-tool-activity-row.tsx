import { presentSessionTitle } from "@/lib/session-title-presentation";
import { defineMessage, getIntl, useIntl, type MessageDescriptor } from "@/lib/i18n";
import { useQuery } from "@tanstack/react-query";
import { Fragment } from "react";
import { MessageDocument, MessageText } from "@/components/message/message-document";
import { ChatIcon, PageIcon } from "@/components/shared/icons";
import { usePageTargetReadModel } from "@/lib/block-reference-queries";
import { usePresentedPageTitle } from "@/lib/page-title-projection-context";
import { projectSessionDetailQueryOptions } from "@/lib/query-options";
import { useLibraryFileReadAuthority } from "@/lib/use-library-navigation";
import { libraryContentRoute } from "../../../../../../shared/content-routing-context";
import { buildPageDeepLink, buildSessionDeepLink } from "../../../../../../shared/nodex-deeplink";
import type { NodexDestination } from "../../../../../../shared/nodex-reference";
import { useNodexReferenceInteraction } from "@/components/nodex-reference/nodex-reference";
import { readMarkdown } from "../../../../../../shared/nodex-markdown";
import type { PageTargetReadModel } from "../../../../../../shared/page-targets";
import {
  boundNodexToolResults,
  joinNodexActivityParts,
  readNodexToolDetail,
  resolveNodexToolActivity,
  splitNodexDocumentBlocks,
  type NodexToolActivity,
  type NodexToolActivityPart,
  type NodexToolResult,
} from "../../../projection/tool-metadata/nodex-tool-activity";
import { CodexShimmerText } from "../codex-shimmer-text";
import { DiffStats } from "./diff-file-shared";
import type { ToolComponentProps } from "./get-tool-component";
import { NodexDynamicToolChangePreview } from "./nodex-dynamic-tool-change-preview";
import { resolveNodexToolActivityIcon, ToolActivityIcon } from "./tool-call-icons";
import { inspectDynamicToolCall, ToolCallInspector } from "./tool-call-inspector";
import { useToolCallOutputDetail } from "./use-tool-call-output-detail";
import {
  ACTIVITY_INLINE_LINK_CLASS_NAME,
  ThreadActivityDisclosure,
  ToolErrorDetail,
} from "./tool-primitives";

export interface NodexPageNamePresentation {
  readonly text: string;
  /** Whether `text` is the Page's own title rather than a description of what it is. */
  readonly named: boolean;
  readonly openable: boolean;
}

const GENERIC_BLOCK = defineMessage({
  id: "conversation.nodexToolActivityRow.block",
  defaultMessage: "block",
});
const BLOCK_NOUNS: Readonly<Record<string, MessageDescriptor>> = {
  canvas: defineMessage({
    id: "conversation.nodexToolActivityRow.canvas",
    defaultMessage: "canvas",
  }),
  database: defineMessage({
    id: "conversation.nodexToolActivityRow.database",
    defaultMessage: "database",
  }),
};

/** What the reader sees for a Page reference; an identity never stands in for a name. */
export function presentNodexPageName(
  input: {
    readonly title: string | null;
    readonly target: PageTargetReadModel | null;
  },
  intl = getIntl(),
): NodexPageNamePresentation {
  const snapshot = (fallback: string): NodexPageNamePresentation =>
    input.title
      ? { text: input.title, named: true, openable: false }
      : { text: fallback, named: false, openable: false };
  switch (input.target?.status) {
    case "available":
      return {
        text:
          input.target.page.title.trim() ||
          intl.formatMessage({
            id: "conversation.nodexToolActivityRow.untitled",
            defaultMessage: "Untitled",
          }),
        named: true,
        openable: true,
      };
    case "deleted":
      return snapshot(
        intl.formatMessage({
          id: "conversation.nodexToolActivityRow.deletedPage",
          defaultMessage: "deleted page",
        }),
      );
    case "invalid_target":
      return snapshot(
        intl.formatMessage(BLOCK_NOUNS[input.target.actualBlockType] ?? GENERIC_BLOCK),
      );
    default:
      return snapshot(
        intl.formatMessage({
          id: "conversation.nodexToolActivityRow.page",
          defaultMessage: "page",
        }),
      );
  }
}

/** A Page or chat named in an activity, opened like any Nodex reference. */
function ActivityReference({
  destination,
  href,
  label,
}: {
  readonly destination: NodexDestination;
  readonly href: string;
  readonly label: string;
}) {
  const { interactive, handlers } = useNodexReferenceInteraction({
    destination,
    openable: true,
    title: label,
  });
  if (!interactive) return label;
  return (
    <a
      href={href}
      data-agent-activity-file-link
      data-nodex-reference={destination.kind}
      className={ACTIVITY_INLINE_LINK_CLASS_NAME}
      {...handlers}
    >
      {label}
    </a>
  );
}

function PageLink({ pageId, label }: { readonly pageId: string; readonly label: string }) {
  return (
    <ActivityReference
      destination={{ kind: "page", pageId }}
      href={buildPageDeepLink({ pageId })}
      label={label}
    />
  );
}

/** A Page's current name; a header (`linked` false) names it in quotes because it cannot nest a link. */
function PageName({
  pageId,
  title,
  linked,
}: {
  readonly pageId: string;
  readonly title: string | null;
  readonly linked: boolean;
}) {
  const target = usePageTargetReadModel(libraryContentRoute, pageId).data;
  const intl = useIntl();
  const presentation = presentNodexPageName({ title, target }, intl);
  const presentedTitle = usePresentedPageTitle(
    target?.status === "available" ? pageId : null,
    presentation.text,
    target?.libraryId,
  );
  const label = presentation.named ? presentedTitle : presentation.text;
  if (linked && presentation.openable) return <PageLink pageId={pageId} label={label} />;
  return !linked && presentation.named ? `“${label}”` : label;
}

function ChatLink({ sessionId, label }: { readonly sessionId: string; readonly label: string }) {
  return (
    <ActivityReference
      destination={{ kind: "session", sessionId }}
      href={buildSessionDeepLink({ sessionId })}
      label={label}
    />
  );
}

function ChatName({
  part,
  linked,
}: {
  readonly part: Extract<NodexToolActivityPart, { kind: "chat" }>;
  readonly linked: boolean;
}) {
  const intl = useIntl();
  const session = useQuery(projectSessionDetailQueryOptions(part.sessionId)).data;
  const label = session || part.title ? presentSessionTitle(session ?? part.title, intl) : null;
  if (!label) return null;
  if (!linked) return `“${label}”`;
  return <ChatLink sessionId={part.sessionId} label={label} />;
}

/** One activity as a sentence, with Pages and chats under their current names. */
export function NodexToolActivitySentence({
  activity,
  following = false,
  linked = false,
}: {
  readonly activity: Pick<NodexToolActivity, "parts">;
  /** The clause continues an earlier one in a group summary. */
  readonly following?: boolean;
  readonly linked?: boolean;
}) {
  return joinNodexActivityParts(activity.parts, following).map((segment, index) => (
    <Fragment key={index}>
      {typeof segment === "string" ? (
        segment
      ) : segment.kind === "page" ? (
        <PageName pageId={segment.pageId} title={segment.title} linked={linked} />
      ) : (
        <ChatName part={segment} linked={linked} />
      )}
    </Fragment>
  ));
}

const RESULT_ICON_CLASS_NAME = "size-3.5 shrink-0 self-center text-token-description-foreground";

function ResultName({ result }: { readonly result: NodexToolResult }) {
  const intl = useIntl();
  if (result.kind === "chat")
    return (
      <ChatLink sessionId={result.sessionId} label={presentSessionTitle(result.title, intl)} />
    );
  return result.title ? (
    <PageLink pageId={result.pageId} label={result.title} />
  ) : (
    <PageName pageId={result.pageId} title={null} linked />
  );
}

/** A Page or chat on one line: its name, then what identifies it or why it matched. */
function ResultRow({ result }: { readonly result: NodexToolResult }) {
  return (
    <li className="flex min-w-0 items-baseline gap-1.5">
      {result.kind === "chat" ? (
        <ChatIcon className={RESULT_ICON_CLASS_NAME} />
      ) : (
        <PageIcon className={RESULT_ICON_CLASS_NAME} />
      )}
      <span className="max-w-[60%] shrink-0 truncate text-token-foreground">
        <ResultName result={result} />
      </span>
      {result.kind === "page" && result.pageKey ? (
        <span className="shrink-0 text-token-description-foreground">{result.pageKey}</span>
      ) : null}
      {result.excerpt ? (
        <span className="min-w-0 truncate text-token-description-foreground">{result.excerpt}</span>
      ) : null}
    </li>
  );
}

function ResultList({ results }: { readonly results: readonly NodexToolResult[] }) {
  const intl = useIntl();
  const { shown, hiddenCount } = boundNodexToolResults(results);
  return (
    <ul className="flex min-w-0 flex-col gap-1 text-size-chat-sm" data-nodex-tool-results="">
      {shown.map((result, index) => (
        <ResultRow
          key={`${result.kind === "chat" ? result.sessionId : result.pageId}:${index}`}
          result={result}
        />
      ))}
      {hiddenCount > 0 ? (
        <li className="text-token-description-foreground">
          {intl.formatMessage(
            {
              id: "conversation.nodexToolActivityRow.moreResults",
              defaultMessage: "{count, number} more",
            },
            { count: hiddenCount },
          )}
        </li>
      ) : null}
    </ul>
  );
}

const MAX_DOCUMENT_CHARS = 64_000;

/** A Page as the Agent read it, for reading: formatted, its child Pages under their own names. */
function NodexReadDocument({ markdown }: { readonly markdown: string }) {
  const intl = useIntl();
  const fileAuthority = useLibraryFileReadAuthority();
  const truncated = markdown.length > MAX_DOCUMENT_CHARS;
  const lastBreak = truncated ? markdown.lastIndexOf("\n\n", MAX_DOCUMENT_CHARS) : -1;
  const bounded = truncated
    ? markdown.slice(0, lastBreak > 0 ? lastBreak : MAX_DOCUMENT_CHARS)
    : markdown;
  const { blocks, childPageIds } = splitNodexDocumentBlocks(readMarkdown(bounded));
  const pages = childPageIds.map((pageId): NodexToolResult => ({
    kind: "page",
    pageId,
    title: null,
    pageKey: null,
    excerpt: null,
  }));
  if (blocks.length === 0 && pages.length === 0)
    return (
      <p className="text-token-description-foreground">
        {intl.formatMessage({
          id: "conversation.nodexToolActivityRow.emptyPage",
          defaultMessage: "This Page is empty.",
        })}
      </p>
    );
  return (
    <div className="flex min-w-0 flex-col gap-2 border-s border-token-border ps-3 text-token-foreground">
      {blocks.length > 0 ? (
        <MessageDocument blocks={blocks} contentKey={markdown} fileAuthority={fileAuthority} />
      ) : null}
      {pages.length > 0 ? <ResultList results={pages} /> : null}
      {truncated ? (
        <p className="text-size-chat-sm text-token-description-foreground">
          {intl.formatMessage({
            id: "conversation.nodexToolActivityRow.openPage",
            defaultMessage: "Open the Page to read the rest.",
          })}
        </p>
      ) : null}
    </div>
  );
}

/** An opened row: what the call changed or found, for a person. The exact call is one click away. */
function NodexToolActivityDetails({
  item,
  activity,
}: {
  readonly item: ToolComponentProps["item"];
  readonly activity: NodexToolActivity;
}) {
  const intl = useIntl();
  const call = item.dynamicToolCall!;
  const { error, available } = useToolCallOutputDetail(item, true, call.outputOmitted);
  const { document, message, results, failure } = readNodexToolDetail(call);
  const hasResult =
    activity.change !== null ||
    document !== null ||
    message !== null ||
    results.length > 0 ||
    failure !== null;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {activity.change ? <NodexDynamicToolChangePreview change={activity.change} /> : null}
      {message ? (
        <div className="border-s border-token-border ps-3 text-token-foreground">
          <MessageText text={message} />
        </div>
      ) : null}
      {document !== null ? <NodexReadDocument markdown={document} /> : null}
      {results.length > 0 ? <ResultList results={results} /> : null}
      {failure ? <ToolErrorDetail error={failure} showLabel={false} /> : null}
      {hasResult && !call.outputOmitted ? null : error ? (
        <p role="alert">{error}</p>
      ) : call.outputOmitted && !activity.change && !message ? (
        <p className="text-token-description-foreground" role="status">
          {available
            ? intl.formatMessage({
                id: "conversation.nodexToolActivityRow.loading",
                defaultMessage: "Loading…",
              })
            : intl.formatMessage({
                id: "conversation.nodexToolActivityRow.unavailable",
                defaultMessage: "Unavailable",
              })}
        </p>
      ) : !hasResult ? (
        <p className="text-token-description-foreground">
          {intl.formatMessage({
            id: "conversation.nodexToolActivityRow.noDetails",
            defaultMessage: "No details to show.",
          })}
        </p>
      ) : null}
    </div>
  );
}

/** A Nodex tool call: what it did to what. Its result and exact call each take one more step. */
export function NodexToolActivityRow({ item }: ToolComponentProps) {
  const call = item.dynamicToolCall!;
  const activity = resolveNodexToolActivity(call)!;
  const { change } = activity;
  return (
    <ThreadActivityDisclosure
      accessory={
        change && (change.additions > 0 || change.deletions > 0) ? (
          <DiffStats
            additions={change.additions}
            deletions={change.deletions}
            className="text-size-chat-sm leading-none"
          />
        ) : null
      }
      canExpand={activity.expandable}
      icon={
        <ToolActivityIcon
          descriptor={resolveNodexToolActivityIcon(activity.icon)}
          className="icon-xs shrink-0 text-token-conversation-body"
        />
      }
      inspector={
        <ToolCallInspector
          item={item}
          outputOmitted={call.outputOmitted}
          title={<NodexToolActivitySentence activity={activity} />}
          inspect={() => inspectDynamicToolCall(call, item.rawItem)}
        />
      }
      status={!call.completed ? "running" : call.success === false ? "failed" : "completed"}
      summary={
        <CodexShimmerText active={!call.completed} className="min-w-0 truncate">
          <NodexToolActivitySentence activity={activity} linked />
        </CodexShimmerText>
      }
    >
      {(expanded) =>
        expanded ? <NodexToolActivityDetails item={item} activity={activity} /> : null
      }
    </ThreadActivityDisclosure>
  );
}
