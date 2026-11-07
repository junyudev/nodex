import { useQuery } from "@tanstack/react-query";
import { Fragment } from "react";
import { MessageDocument, MessageText } from "@/components/message/message-document";
import { PageIcon } from "@/components/shared/icons";
import { usePageTargetReadModel } from "@/lib/block-reference-queries";
import { usePresentedPageTitle } from "@/lib/page-title-projection-context";
import { projectSessionDetailQueryOptions } from "@/lib/query-options";
import { useLibraryFileReadAuthority } from "@/lib/use-library-navigation";
import { libraryContentRoute } from "../../../../../../shared/content-routing-context";
import { buildPageDeepLink, buildSessionDeepLink } from "../../../../../../shared/nodex-deeplink";
import { readMarkdown } from "../../../../../../shared/nodex-markdown";
import type { PageTargetReadModel } from "../../../../../../shared/page-targets";
import { useConversationPageNavigation } from "../../../conversation-page-navigation";
import {
  boundNodexRelatedPages,
  joinNodexActivityParts,
  readNodexToolDetail,
  resolveNodexToolActivity,
  splitNodexDocumentBlocks,
  type NodexToolActivity,
  type NodexToolActivityPart,
  type NodexToolRelatedPage,
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

type OpenThread = ToolComponentProps["onOpenThread"];

export interface NodexPageNamePresentation {
  readonly text: string;
  /** Whether `text` is the Page's own title rather than a description of what it is. */
  readonly named: boolean;
  readonly openable: boolean;
}

const BLOCK_NOUNS: Readonly<Record<string, string>> = {
  canvas: "canvas",
  database: "database",
};

/** What the reader sees for a Page reference; an identity never stands in for a name. */
export function presentNodexPageName(input: {
  readonly title: string | null;
  readonly target: PageTargetReadModel | null;
}): NodexPageNamePresentation {
  const snapshot = (fallback: string): NodexPageNamePresentation =>
    input.title
      ? { text: input.title, named: true, openable: false }
      : { text: fallback, named: false, openable: false };
  switch (input.target?.status) {
    case "available":
      return { text: input.target.page.title.trim() || "Untitled", named: true, openable: true };
    case "deleted":
      return snapshot("deleted page");
    case "invalid_target":
      return snapshot(BLOCK_NOUNS[input.target.actualBlockType] ?? "block");
    default:
      return snapshot("page");
  }
}

function InlineActivityLink({
  href,
  label,
  onOpen,
}: {
  readonly href: string;
  readonly label: string;
  readonly onOpen: () => void;
}) {
  return (
    <a
      href={href}
      data-agent-activity-file-link
      className={ACTIVITY_INLINE_LINK_CLASS_NAME}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onOpen();
      }}
    >
      {label}
    </a>
  );
}

function PageLink({ pageId, label }: { readonly pageId: string; readonly label: string }) {
  const openPage = useConversationPageNavigation();
  if (!openPage) return label;
  return (
    <InlineActivityLink
      href={buildPageDeepLink({ pageId })}
      label={label}
      onOpen={() => openPage(pageId, label)}
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
  const presentation = presentNodexPageName({ title, target });
  const presentedTitle = usePresentedPageTitle(
    target?.status === "available" ? pageId : null,
    presentation.text,
    target?.libraryId,
  );
  const label = presentation.named ? presentedTitle : presentation.text;
  if (linked && presentation.openable) return <PageLink pageId={pageId} label={label} />;
  return !linked && presentation.named ? `“${label}”` : label;
}

function ChatName({
  part,
  linked,
  onOpenThread,
}: {
  readonly part: Extract<NodexToolActivityPart, { kind: "chat" }>;
  readonly linked: boolean;
  readonly onOpenThread?: OpenThread;
}) {
  const session = useQuery(projectSessionDetailQueryOptions(part.sessionId)).data;
  const label = session?.displayTitle.trim() || part.title;
  const threadId = part.threadId ?? session?.thread?.threadId ?? null;
  if (!label) return null;
  if (!linked) return `“${label}”`;
  if (!threadId || !onOpenThread) return label;
  return (
    <InlineActivityLink
      href={buildSessionDeepLink({ sessionId: part.sessionId })}
      label={label}
      onOpen={() => void onOpenThread(threadId, { runtimeSessionId: part.sessionId })}
    />
  );
}

/** One activity as a sentence, with Pages and chats under their current names. */
export function NodexToolActivitySentence({
  activity,
  following = false,
  linked = false,
  onOpenThread,
}: {
  readonly activity: Pick<NodexToolActivity, "parts">;
  /** The clause continues an earlier one in a group summary. */
  readonly following?: boolean;
  readonly linked?: boolean;
  readonly onOpenThread?: OpenThread;
}) {
  return joinNodexActivityParts(activity.parts, following).map((segment, index) => (
    <Fragment key={index}>
      {typeof segment === "string" ? (
        segment
      ) : segment.kind === "page" ? (
        <PageName pageId={segment.pageId} title={segment.title} linked={linked} />
      ) : (
        <ChatName part={segment} linked={linked} onOpenThread={onOpenThread} />
      )}
    </Fragment>
  ));
}

function RelatedPageRow({ page }: { readonly page: NodexToolRelatedPage }) {
  return (
    <li className="flex min-w-0 items-baseline gap-1.5">
      <PageIcon className="size-3.5 shrink-0 self-center text-token-description-foreground" />
      <span className="max-w-[60%] shrink-0 truncate text-token-foreground">
        {page.title ? (
          <PageLink pageId={page.pageId} label={page.title} />
        ) : (
          <PageName pageId={page.pageId} title={null} linked />
        )}
      </span>
      {page.pageKey ? (
        <span className="shrink-0 text-token-description-foreground">{page.pageKey}</span>
      ) : null}
      {page.excerpt ? (
        <span className="min-w-0 truncate text-token-description-foreground">{page.excerpt}</span>
      ) : null}
    </li>
  );
}

function RelatedPages({ pages }: { readonly pages: readonly NodexToolRelatedPage[] }) {
  const { shown, hiddenCount } = boundNodexRelatedPages(pages);
  return (
    <ul className="flex min-w-0 flex-col gap-1 text-size-chat-sm" data-nodex-tool-related-pages="">
      {shown.map((page, index) => (
        <RelatedPageRow key={`${page.pageId}:${index}`} page={page} />
      ))}
      {hiddenCount > 0 ? (
        <li className="text-token-description-foreground">{hiddenCount} more</li>
      ) : null}
    </ul>
  );
}

const MAX_DOCUMENT_CHARS = 64_000;

/** A Page as the Agent read it, for reading: formatted, its child Pages under their own names. */
function NodexReadDocument({ markdown }: { readonly markdown: string }) {
  const fileAuthority = useLibraryFileReadAuthority();
  const truncated = markdown.length > MAX_DOCUMENT_CHARS;
  const lastBreak = truncated ? markdown.lastIndexOf("\n\n", MAX_DOCUMENT_CHARS) : -1;
  const bounded = truncated
    ? markdown.slice(0, lastBreak > 0 ? lastBreak : MAX_DOCUMENT_CHARS)
    : markdown;
  const { blocks, childPageIds } = splitNodexDocumentBlocks(readMarkdown(bounded));
  const pages = childPageIds.map((pageId) => ({
    pageId,
    title: null,
    pageKey: null,
    excerpt: null,
  }));
  if (blocks.length === 0 && pages.length === 0)
    return <p className="text-token-description-foreground">This Page is empty.</p>;
  return (
    <div className="flex min-w-0 flex-col gap-2 border-s border-token-border ps-3 text-token-foreground">
      {blocks.length > 0 ? (
        <MessageDocument blocks={blocks} contentKey={markdown} fileAuthority={fileAuthority} />
      ) : null}
      {pages.length > 0 ? <RelatedPages pages={pages} /> : null}
      {truncated ? (
        <p className="text-size-chat-sm text-token-description-foreground">
          Open the Page to read the rest.
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
  const call = item.dynamicToolCall!;
  const { error, available } = useToolCallOutputDetail(item, true, call.outputOmitted);
  const { document, message, pages, failure } = readNodexToolDetail(call);
  const hasResult =
    activity.change !== null ||
    document !== null ||
    message !== null ||
    pages.length > 0 ||
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
      {pages.length > 0 ? <RelatedPages pages={pages} /> : null}
      {failure ? <ToolErrorDetail error={failure} showLabel={false} /> : null}
      {hasResult && !call.outputOmitted ? null : error ? (
        <p role="alert">{error}</p>
      ) : call.outputOmitted && !activity.change && !message ? (
        <p className="text-token-description-foreground" role="status">
          {available ? "Loading…" : "Unavailable"}
        </p>
      ) : !hasResult ? (
        <p className="text-token-description-foreground">
          Nothing to read here. Inspect the call for its exact output.
        </p>
      ) : null}
    </div>
  );
}

/** A Nodex tool call: what it did to what. Its result and exact call each take one more step. */
export function NodexToolActivityRow({ item, onOpenThread }: ToolComponentProps) {
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
            className="text-size-chat-sm"
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
          <NodexToolActivitySentence activity={activity} linked onOpenThread={onOpenThread} />
        </CodexShimmerText>
      }
    >
      {(expanded) =>
        expanded ? <NodexToolActivityDetails item={item} activity={activity} /> : null
      }
    </ThreadActivityDisclosure>
  );
}
