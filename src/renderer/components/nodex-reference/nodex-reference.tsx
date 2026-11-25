import { useIntl } from "@/lib/i18n";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  ReactNode,
} from "react";
import { BoardIcon, ChatIcon, PageIcon } from "@/components/shared/icons";
import { InlineReferenceVisual } from "@/components/board/inline-reference-visual";
import { NodexTooltip } from "@/components/ui/tooltip";
import { usePageTargetReadModel, useDatabaseViewReadModel } from "@/lib/block-reference-queries";
import { snapshotLinkActivation } from "@/lib/link-activation";
import {
  buildNodexDestinationLink,
  isOtherSpaceDestination,
  useNodexReferenceRouter,
  useNodexReferenceSource,
  type NodexReferenceSource,
} from "@/lib/nodex-reference-router";
import { openNodexReferenceContextMenu } from "@/lib/nodex-reference-context-menu";
import { projectSessionDetailQueryOptions, projectsListQueryOptions } from "@/lib/query-options";
import { presentSessionTitle } from "@/lib/session-title-presentation";
import { useChatReplyPreview } from "@/lib/chat-reply-previews";
import { cn } from "@/lib/utils";
import { usePageStatusGlyph } from "@/components/board/use-page-status-glyph";
import { libraryContentRoute } from "../../../shared/content-routing-context";
import type { NodexDestination, NodexReferenceGesture } from "../../../shared/nodex-reference";
import {
  PageReferenceTooltipBody,
  resolvePageReferencePresentation,
} from "./page-reference-presentation";

/**
 * A mention shows its target under its current name; a link keeps the words its author chose.
 * Both open, preview and offer actions the same way.
 */
export type NodexReferenceVariant = "mention" | "link";

interface NodexReferenceProps {
  readonly destination: NodexDestination;
  readonly variant: NodexReferenceVariant;
  /** A link's own words. */
  readonly children?: ReactNode;
  /** The name a reference was written with, shown until the live name arrives. */
  readonly titleSnapshot?: string;
  readonly className?: string;
}

/** A Page, View or chat referenced from text, wherever it is read. */
export function NodexReference(props: NodexReferenceProps) {
  const { destination } = props;
  if (isOtherSpaceDestination(destination)) return <OtherSpaceReference {...props} />;
  if (destination.kind === "page") return <PageReference {...props} destination={destination} />;
  if (destination.kind === "view") return <ViewReference {...props} destination={destination} />;
  return <SessionReference {...props} destination={destination} />;
}

interface ReferenceModel {
  readonly label: string;
  readonly icon: ReactNode;
  /** Whether the target can be opened; a deleted or missing target only explains itself. */
  readonly openable: boolean;
  readonly tooltip: ReactNode;
  /** The live name, carried into the tab or window the reference opens. */
  readonly title?: string;
}

function PageReference(
  props: NodexReferenceProps & {
    readonly destination: Extract<NodexDestination, { kind: "page" }>;
  },
) {
  const intl = useIntl();
  const { pageId } = props.destination;
  const target = usePageTargetReadModel(libraryContentRoute, pageId);
  const page = target.data?.status === "available" ? target.data.page : null;
  const statusGlyph = usePageStatusGlyph(libraryContentRoute, page);
  const presentation = resolvePageReferencePresentation(
    { targetPageId: pageId, target: target.data, loading: target.loading, error: target.error },
    intl,
  );
  // A reference names its Page, or what became of it; an identity never stands in for a name.
  const label = page
    ? presentation.label
    : target.loading
      ? props.titleSnapshot ||
        intl.formatMessage({ id: "components.nodexReference.page", defaultMessage: "Page" })
      : presentation.tooltipTitle;
  return (
    <ReferenceSurface
      {...props}
      model={{
        label,
        icon: statusGlyph ?? <PageIcon className="size-full" />,
        openable: page !== null || target.loading,
        tooltip: <PageReferenceTooltipBody presentation={presentation} />,
        ...(page ? { title: presentation.label } : {}),
      }}
    />
  );
}

function ViewReference(
  props: NodexReferenceProps & {
    readonly destination: Extract<NodexDestination, { kind: "view" }>;
  },
) {
  const intl = useIntl();
  const view = useDatabaseViewReadModel(libraryContentRoute, props.destination.viewId);
  const name = view.data?.view.name.trim();
  // Only a read that finds no View proves it gone; a failed read leaves the View openable.
  const unavailable = !view.loading && !view.error && !view.data;
  const label =
    name ||
    props.titleSnapshot ||
    (unavailable
      ? intl.formatMessage({
          id: "components.nodexReference.unavailableView",
          defaultMessage: "Unavailable view",
        })
      : view.error
        ? intl.formatMessage({
            id: "components.nodexReference.databaseView",
            defaultMessage: "Database view",
          })
        : intl.formatMessage({ id: "components.nodexReference.view", defaultMessage: "View" }));
  return (
    <ReferenceSurface
      {...props}
      model={{
        label,
        icon: <BoardIcon className="size-full" />,
        openable: !unavailable,
        tooltip: (
          <ReferenceTooltip
            title={label}
            detail={
              unavailable
                ? intl.formatMessage({
                    id: "components.nodexReference.viewUnavailableHere",
                    defaultMessage: "This view is unavailable here.",
                  })
                : intl.formatMessage({
                    id: "components.nodexReference.databaseView",
                    defaultMessage: "Database view",
                  })
            }
          />
        ),
        ...(name ? { title: name } : {}),
      }}
    />
  );
}

function SessionReference(
  props: NodexReferenceProps & {
    readonly destination: Extract<NodexDestination, { kind: "session" }>;
  },
) {
  const intl = useIntl();
  const { sessionId } = props.destination;
  const source = useNodexReferenceSource();
  const query = useQuery(projectSessionDetailQueryOptions(sessionId));
  const session = query.data ?? null;
  const missing = query.status === "success" && !session;
  const failed = query.status === "error";
  const title = session ? presentSessionTitle(session, intl) : null;
  const label =
    title ??
    (missing || failed
      ? intl.formatMessage({
          id: "components.nodexReference.chatNotFound",
          defaultMessage: "Chat not found",
        })
      : props.titleSnapshot ||
        intl.formatMessage({ id: "components.nodexReference.chat", defaultMessage: "Chat" }));
  return (
    <ReferenceSurface
      {...props}
      model={{
        label,
        icon: <ChatIcon className="size-full" />,
        openable: !missing && !failed && session?.archived !== true,
        tooltip: (
          <SessionReferenceTooltip
            sessionId={sessionId}
            title={label}
            session={session}
            missing={missing || failed}
            current={source.sessionId === sessionId}
          />
        ),
        ...(title ? { title } : {}),
      }}
    />
  );
}

function OtherSpaceReference(props: NodexReferenceProps) {
  const intl = useIntl();
  const kind = props.destination.kind;
  const label =
    props.titleSnapshot ||
    (kind === "session"
      ? intl.formatMessage({ id: "components.nodexReference.chat", defaultMessage: "Chat" })
      : kind === "view"
        ? intl.formatMessage({ id: "components.nodexReference.view", defaultMessage: "View" })
        : intl.formatMessage({ id: "components.nodexReference.page", defaultMessage: "Page" }));
  return (
    <ReferenceSurface
      {...props}
      model={{
        label,
        icon:
          kind === "session" ? (
            <ChatIcon className="size-full" />
          ) : kind === "view" ? (
            <BoardIcon className="size-full" />
          ) : (
            <PageIcon className="size-full" />
          ),
        openable: true,
        tooltip: (
          <ReferenceTooltip
            title={label}
            detail={intl.formatMessage({
              id: "components.nodexReference.otherSpace",
              defaultMessage: "Opens in its own Space",
            })}
          />
        ),
      }}
    />
  );
}

function ReferenceTooltip({
  title,
  detail,
  children,
}: {
  readonly title: string;
  readonly detail?: string | null;
  readonly children?: ReactNode;
}) {
  return (
    <div className="max-w-[20rem] space-y-0.5 text-left" data-nodex-reference-tooltip="">
      <div className="truncate text-sm font-medium text-token-foreground">{title}</div>
      {detail ? (
        <div className="truncate text-xs text-token-description-foreground">{detail}</div>
      ) : null}
      {children}
    </div>
  );
}

/** Mounted only while the tooltip is open, so the reply preview loads on hover. */
function SessionReferenceTooltip({
  sessionId,
  title,
  session,
  missing,
  current,
}: {
  readonly sessionId: string;
  readonly title: string;
  readonly session: import("@/lib/types").ProjectSession | null;
  readonly missing: boolean;
  readonly current: boolean;
}) {
  const intl = useIntl();
  const projects = useInfiniteQuery({
    ...projectsListQueryOptions(),
    enabled: Boolean(session?.projectId),
  });
  const reply = useChatReplyPreview(
    session && !missing ? sessionId : null,
    session?.attentionAt ?? session?.activityAt ?? 0,
  );
  const project = session?.projectId
    ? projects.data?.pages
        .flatMap((page) => page.items)
        .find((candidate) => candidate.id === session.projectId)?.name
    : null;
  const state = missing
    ? intl.formatMessage({
        id: "components.nodexReference.chatMissing",
        defaultMessage: "This chat could not be found.",
      })
    : session?.archived
      ? intl.formatMessage({ id: "components.nodexReference.archived", defaultMessage: "Archived" })
      : current
        ? intl.formatMessage({
            id: "components.nodexReference.thisChat",
            defaultMessage: "This chat",
          })
        : session?.thread?.statusType === "active"
          ? intl.formatMessage({
              id: "components.nodexReference.working",
              defaultMessage: "Working",
            })
          : null;
  const detail = [project, state].filter(Boolean).join(" · ");
  return (
    <ReferenceTooltip title={title} detail={detail || null}>
      {reply ? (
        <div className="mt-1 line-clamp-3 text-xs/relaxed wrap-break-word text-token-description-foreground/90">
          {reply}
        </div>
      ) : null}
    </ReferenceTooltip>
  );
}

/**
 * The gestures every reference shares: activation follows the reading surface, Primary or middle
 * opens additionally, double-click keeps a preview, and the context menu names each choice.
 */
export function useNodexReferenceInteraction(input: {
  readonly destination: NodexDestination;
  readonly openable: boolean;
  readonly title?: string;
  /** A surface that is not a declared reading surface, such as an editor, names itself. */
  readonly source?: NodexReferenceSource;
  /** Editors lead their own context menu with a reference's actions. */
  readonly contextMenu?: boolean;
}) {
  const router = useNodexReferenceRouter();
  const declaredSource = useNodexReferenceSource();
  const source = input.source ?? declaredSource;
  // Without the Workbench router, a surface that navigates in place still opens its content.
  const inPlace = input.destination.kind !== "session" && !router ? source.openInPlace : undefined;
  const interactive = input.openable && (router !== null || inPlace !== undefined);
  const open = (gesture: NodexReferenceGesture, element: Element) => {
    if (!input.openable) return;
    if (inPlace && input.destination.kind !== "session") {
      void inPlace(input.destination, input.title);
      return;
    }
    if (!router) return;
    void router.open(input.destination, {
      source,
      gesture,
      ...(input.title ? { titleSnapshot: input.title } : {}),
      isCurrent: () => element.isConnected,
    });
  };
  const showMenu = (element: Element, x: number, y: number) => {
    void openNodexReferenceContextMenu({
      destination: input.destination,
      link: buildNodexDestinationLink(input.destination),
      openable: interactive,
      x,
      y,
      isCurrent: () => element.isConnected,
      open: (action) => open({ kind: "menu", action }, element),
    }).catch(() => undefined);
  };
  const stop = (event: { preventDefault: () => void; stopPropagation: () => void }) => {
    event.preventDefault();
    event.stopPropagation();
  };
  return {
    interactive,
    handlers: {
      onClick: (event: ReactMouseEvent<HTMLElement>) => {
        stop(event);
        if (event.detail > 1) return;
        open({ kind: "activate", activation: snapshotLinkActivation(event) }, event.currentTarget);
      },
      onDoubleClick: (event: ReactMouseEvent<HTMLElement>) => {
        stop(event);
        open({ kind: "keep" }, event.currentTarget);
      },
      onMouseDown: (event: ReactMouseEvent<HTMLElement>) => {
        // Middle-press would start autoscroll; the release opens the reference.
        if (event.button === 1) event.preventDefault();
      },
      onAuxClick: (event: ReactMouseEvent<HTMLElement>) => {
        if (event.button !== 1) return;
        stop(event);
        open({ kind: "activate", activation: snapshotLinkActivation(event) }, event.currentTarget);
      },
      onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => {
        if (
          input.contextMenu !== false &&
          (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey))
        ) {
          stop(event);
          const bounds = event.currentTarget.getBoundingClientRect();
          showMenu(event.currentTarget, bounds.left, bounds.bottom);
          return;
        }
        if (event.key !== "Enter") return;
        stop(event);
        open({ kind: "activate", activation: snapshotLinkActivation(event) }, event.currentTarget);
      },
      ...(input.contextMenu === false
        ? {}
        : {
            onContextMenu: (event: ReactMouseEvent<HTMLElement>) => {
              stop(event);
              showMenu(event.currentTarget, event.clientX, event.clientY);
            },
          }),
    },
  };
}

const sameName = (left: string, right: string) =>
  left.trim().toLocaleLowerCase() === right.trim().toLocaleLowerCase();

function ReferenceSurface({
  destination,
  variant,
  children,
  className,
  model,
}: NodexReferenceProps & { readonly model: ReferenceModel }) {
  const intl = useIntl();
  const { interactive, handlers } = useNodexReferenceInteraction({
    destination,
    openable: model.openable,
    ...(model.title ? { title: model.title } : {}),
  });
  const href = buildNodexDestinationLink(destination);
  const accessibleName = interactive
    ? destination.kind === "session"
      ? intl.formatMessage(
          { id: "components.nodexReference.openNamedChat", defaultMessage: "Open chat {title}" },
          { title: model.label },
        )
      : intl.formatMessage(
          { id: "components.nodexReference.openNamed", defaultMessage: "Open {title}" },
          { title: model.label },
        )
    : undefined;
  const common = {
    href,
    "aria-disabled": interactive ? undefined : true,
    "data-nodex-reference": destination.kind,
    "data-nodex-reference-openable": interactive ? "true" : "false",
    ...handlers,
  } as const;
  // A link whose words only restate its target's name shows the target, as a mention does.
  const restatesName =
    variant === "link" &&
    typeof children === "string" &&
    model.title !== undefined &&
    sameName(children, model.title);
  const trigger =
    variant === "mention" || restatesName ? (
      <InlineReferenceVisual
        as="a"
        {...common}
        aria-label={accessibleName}
        label={model.label}
        icon={model.icon}
        data-nodex-reference-variant={variant}
        className={cn(
          "max-w-[18rem] align-baseline",
          interactive ? "cursor-interaction" : "cursor-default text-token-description-foreground",
          className,
        )}
      />
    ) : (
      <a
        {...common}
        data-nodex-reference-variant="link"
        className={cn(
          "break-words whitespace-normal",
          interactive
            ? "cursor-interaction text-token-text-link-foreground hover:underline"
            : "cursor-default text-token-description-foreground line-through decoration-token-description-foreground/50",
          className,
        )}
      >
        {children ?? model.label}
      </a>
    );
  return (
    <NodexTooltip
      tooltipContent={model.tooltip}
      side="top"
      align="start"
      sideOffset={4}
      delay={300}
      tooltipClassName="px-2 py-1.5"
    >
      {trigger}
    </NodexTooltip>
  );
}
