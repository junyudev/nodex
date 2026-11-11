import { createElement, useMemo, useState, type ReactNode } from "react";

import { ThreadsIcon } from "@/components/workbench/threads-icon";
import { NodexDropdown } from "@/components/ui/dropdown";
import { toast } from "@/components/ui/toast";
import { SchedulePopover } from "@/components/board/schedule-popover";
import { dataSourcePropertyIcon } from "@/components/database/data-source-property-presentation";
import {
  DATABASE_PAGE_PROPERTY_EMPTY_TRIGGER_CLASS_NAME,
  PropertyEmptyValue,
} from "@/components/database/property-empty-value";
import { DATABASE_PAGE_PROPERTY_OUTLINED_TOKEN_CLASS_NAME } from "@/components/database/property-value-chip";
import {
  ActivitySpinnerIcon,
  AssigneeIcon,
  ChevronDownIcon,
  ClockIcon,
  CloseIcon,
  FileIcon,
  PageMenuOpenNewChatIcon,
  PlusIcon,
  StatusIcon,
  ChatIcon,
} from "@/components/shared/icons";
import { PageChatActivityGlyph } from "@/components/shared/page-chat-activity-glyph";
import { usePageChatItemActivity } from "@/lib/use-page-chat-activity";
import {
  advancePageStageQuietPropertiesState,
  createPageStageQuietPropertiesState,
  formatPageStageQuietPropertyCountLabel,
  resolveLinkedChatsPropertySignal,
  resolvePageFilesPropertySignal,
  type PageStageQuietPropertiesInput,
} from "@/lib/page-stage-quiet-properties";
import {
  advancePageStagePropertyDisclosure,
  revealPageStageProperty,
  type PageStagePropertyDisclosureEntry,
  type PageStagePropertyDisclosureState,
  type PageStagePropertyRow as PageStagePropertyRowModel,
} from "@/lib/page-stage-property-layout";
import { CURRENT_CHAT_LABEL } from "@/lib/page-chat-actions";
import { selectLinkableChatCandidates } from "@/lib/page-stage-related-chat-candidates";
import { usePageFiles } from "@/lib/use-page-files";
import { usePageTurn } from "@/lib/page-turn-runtime";
import { useMountAction } from "@/lib/use-mount-action";
import { resolveDataSourcePropertyPresentationRole } from "@/lib/data-source-property-presentation-role";
import { cn } from "@/lib/utils";
import { PageStageDataSourcePropertyControl } from "./data-source-property-control";
import type { PageStageController } from "./use-page-stage-controller";
import type { PageStageRelatedChat } from "./types";
import { PageFilesRow, usePageFilesDialog } from "./page-files-row";
import { PageAutomationsRow } from "./automations-row";
import { PageStatusTurn } from "./status-turn";
import { PageWorkspaceRow } from "./page-workspace-row";
import { PageAssigneeRow, PageOwnerRow } from "./assignee-row";
import { PageStagePropertyRow } from "./property-row";
import { pageStagePropertyAddControl } from "./property-value-styles";

interface PageStagePropertiesSectionProps {
  readonly controller: PageStageController;
}

interface RelatedChatPropertyChipProps {
  readonly chat: PageStageRelatedChat;
  readonly current: boolean;
  readonly saving: boolean;
  readonly onOpen?: () => Promise<void>;
  readonly onRemove?: () => Promise<void>;
}

/** Content-sized chips overlay hidden actions so resting geometry follows visible content only. */
export function RelatedChatPropertyChip({
  chat,
  current,
  saving,
  onOpen,
  onRemove,
}: RelatedChatPropertyChipProps) {
  const activity = usePageChatItemActivity(chat);

  return (
    <span
      data-page-stage-related-chat-session-id={chat.sessionId}
      data-page-stage-related-chat-chip="true"
      className={cn(
        DATABASE_PAGE_PROPERTY_OUTLINED_TOKEN_CLASS_NAME,
        "group/related-chat relative max-w-64 gap-0 p-0 hover:bg-token-foreground/5 group-focus-within/related-chat:bg-token-foreground/5",
        current
          ? "text-token-text-primary ring-token-border-heavy"
          : "text-token-text-secondary hover:text-token-text-primary",
      )}
    >
      <button
        type="button"
        aria-current={current ? "true" : undefined}
        disabled={!onOpen}
        onClick={() => void onOpen?.()}
        className="flex h-full min-w-0 flex-1 items-center gap-1 px-1.5 text-left outline-none focus-visible:rounded-md focus-visible:ring-2 focus-visible:ring-token-focus-border disabled:opacity-60"
      >
        <PageChatActivityGlyph
          activity={activity}
          className={cn("size-4", activity.execution === "idle" && "text-inherit")}
          unreadRingClassName="ring-token-main-surface-primary"
        />
        <span className="min-w-0 flex-1 truncate">{chat.displayTitle}</span>
      </button>
      {onRemove ? (
        <button
          type="button"
          aria-label={`Remove relation to ${chat.displayTitle}`}
          disabled={saving}
          className="pointer-events-none absolute right-0.5 top-1/2 z-10 flex size-5 -translate-y-1/2 shrink-0 items-center justify-center rounded-sm bg-[color-mix(in_srgb,var(--color-token-foreground)_5%,var(--color-token-main-surface-primary))] text-token-description-foreground opacity-0 hover:bg-[color-mix(in_srgb,var(--color-token-foreground)_10%,var(--color-token-main-surface-primary))] hover:text-token-text-primary focus-visible:ring-2 focus-visible:ring-token-focus-border focus-visible:text-token-text-primary group-hover/related-chat:pointer-events-auto group-hover/related-chat:opacity-100 group-focus-within/related-chat:pointer-events-auto group-focus-within/related-chat:opacity-100 disabled:pointer-events-none disabled:opacity-40"
          onClick={() => void onRemove()}
        >
          <CloseIcon className="size-3" />
        </button>
      ) : null}
    </span>
  );
}

function RelatedChatAddControl({
  controller,
  empty,
  openOnMount = false,
}: PageStagePropertiesSectionProps & {
  readonly empty: boolean;
  readonly openOnMount?: boolean;
}) {
  const {
    relatedChats,
    relatedChatCandidates,
    currentSessionId,
    onCreateRelatedChat,
    onLinkRelatedChat,
    saving,
  } = controller;
  const [open, setOpen] = useState(false);
  useMountAction(openOnMount, () => setOpen(true));
  const [query, setQuery] = useState("");
  const [linkingSessionId, setLinkingSessionId] = useState<string | null>(null);
  const linkedSessionIds = useMemo(
    () => new Set(relatedChats.map((chat) => chat.sessionId)),
    [relatedChats],
  );
  const hasLinkableChats = relatedChatCandidates.some(
    (chat) => !linkedSessionIds.has(chat.sessionId),
  );
  const filteredCandidates = selectLinkableChatCandidates(relatedChatCandidates, {
    linkedSessionIds,
    currentSessionId,
    query,
  });
  const normalizedQuery = query.trim();
  if (!onCreateRelatedChat && !onLinkRelatedChat) return null;

  const triggerButton = empty ? (
    <button
      type="button"
      aria-label="Add chat"
      disabled={saving}
      className={cn(
        "flex min-h-6 min-w-0 items-center text-left text-sm focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-token-focus-border disabled:opacity-40",
        DATABASE_PAGE_PROPERTY_EMPTY_TRIGGER_CLASS_NAME,
      )}
    >
      <PropertyEmptyValue className="truncate" />
    </button>
  ) : (
    <button
      type="button"
      aria-label="Add chat"
      disabled={saving}
      className={cn(pageStagePropertyAddControl, "disabled:opacity-40")}
    >
      <PlusIcon className="icon-2xs shrink-0" />
    </button>
  );

  return (
    <NodexDropdown.Menu
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) setQuery("");
      }}
      triggerButton={triggerButton}
      triggerTooltipContent={empty ? undefined : "Add chat"}
      contentWidth="menuFixed"
      align="start"
    >
      {onCreateRelatedChat ? (
        <NodexDropdown.Item
          leftSlot={<PageMenuOpenNewChatIcon />}
          onSelect={() => {
            void Promise.resolve(onCreateRelatedChat()).catch(() => {
              toast.danger("Couldn’t create chat");
            });
          }}
        >
          New chat
        </NodexDropdown.Item>
      ) : null}
      {onCreateRelatedChat && onLinkRelatedChat ? <NodexDropdown.Separator /> : null}
      {onLinkRelatedChat ? (
        <NodexDropdown.FlyoutSubmenuItem
          label="Link to chat…"
          leftSlot={<ChatIcon className="icon-xs shrink-0" />}
          disabled={!hasLinkableChats}
          contentClassName="w-[280px] p-1"
        >
          <NodexDropdown.SearchInput
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Find a chat…"
            aria-label="Find a chat to link"
          />
          <NodexDropdown.ScrollList className="mt-1">
            {filteredCandidates.length === 0 ? (
              <NodexDropdown.Message compact>
                {normalizedQuery ? "No matching chats" : "No chats available"}
              </NodexDropdown.Message>
            ) : (
              filteredCandidates.map((candidate) => (
                <NodexDropdown.ActionRow
                  key={candidate.sessionId}
                  disabled={linkingSessionId !== null}
                  className="items-center gap-1.5"
                  onClick={() => {
                    setLinkingSessionId(candidate.sessionId);
                    void onLinkRelatedChat(candidate.sessionId)
                      .then(() => setOpen(false))
                      .catch(() => toast.danger("Couldn’t link chat"))
                      .finally(() => setLinkingSessionId(null));
                  }}
                >
                  <ChatIcon className="icon-xs shrink-0 text-token-text-secondary" />
                  <span className="min-w-0 flex-1 truncate text-left">
                    {candidate.displayTitle}
                  </span>
                  {/* The Scene's own Chat needs no Project to tell it apart. */}
                  {candidate.sessionId === currentSessionId || candidate.projectName ? (
                    <span className="max-w-24 shrink truncate text-xs text-token-description-foreground">
                      {candidate.sessionId === currentSessionId
                        ? CURRENT_CHAT_LABEL
                        : candidate.projectName}
                    </span>
                  ) : null}
                  {linkingSessionId === candidate.sessionId ? (
                    <ActivitySpinnerIcon className="size-3 shrink-0" />
                  ) : null}
                </NodexDropdown.ActionRow>
              ))
            )}
          </NodexDropdown.ScrollList>
        </NodexDropdown.FlyoutSubmenuItem>
      ) : null}
    </NodexDropdown.Menu>
  );
}

function RelatedChatsPropertyRow({
  controller,
  openOnMount,
}: PageStagePropertiesSectionProps & { readonly openOnMount: boolean }) {
  const {
    relatedChats,
    relatedChatsLoading,
    relatedChatsError,
    relatedChatsHasMore,
    relatedChatsLoadingMore,
    onOpenRelatedChat,
    onRemoveRelatedChat,
    onRetryRelatedChats,
    onLoadMoreRelatedChats,
    saving,
    currentSessionId,
    handleOpenRelatedChat,
    handleRemoveRelatedChat,
  } = controller;
  const empty = relatedChats.length === 0;
  const showEmptyControl = empty && !relatedChatsLoading;

  return (
    <PageStagePropertyRow icon={<ThreadsIcon />} label="Linked chats">
      <div className="min-w-0 flex-1">
        {relatedChatsError ? (
          <div className="flex min-h-7 items-center gap-2 text-xs text-(--red-text)">
            <span className="min-w-0 flex-1 truncate">{relatedChatsError}</span>
            {onRetryRelatedChats ? (
              <button
                type="button"
                className="shrink-0 text-(--foreground-secondary) hover:text-(--foreground)"
                onClick={() => void onRetryRelatedChats()}
              >
                Retry
              </button>
            ) : null}
          </div>
        ) : null}
        {relatedChatsLoading && relatedChats.length === 0 ? (
          <div
            role="status"
            aria-label="Loading linked chats"
            className="flex h-7 items-center px-1.5 text-(--foreground-tertiary)"
          >
            <ActivitySpinnerIcon className="size-3.5" />
          </div>
        ) : null}
        {relatedChats.length > 0 ? (
          <div className="flex min-h-7 flex-wrap items-center gap-1 py-0.5">
            {relatedChats.map((chat) => (
              <RelatedChatPropertyChip
                key={chat.sessionId}
                chat={chat}
                current={currentSessionId === chat.sessionId}
                saving={saving}
                onOpen={onOpenRelatedChat ? () => handleOpenRelatedChat(chat.sessionId) : undefined}
                onRemove={
                  onRemoveRelatedChat ? () => handleRemoveRelatedChat(chat.sessionId) : undefined
                }
              />
            ))}
            {relatedChatsHasMore && onLoadMoreRelatedChats ? (
              <button
                type="button"
                disabled={relatedChatsLoadingMore}
                className="flex h-5.5 items-center gap-1 rounded-md px-1.5 text-xs text-token-description-foreground hover:bg-token-foreground/5 hover:text-token-text-secondary disabled:opacity-50"
                onClick={() => void onLoadMoreRelatedChats()}
              >
                {relatedChatsLoadingMore ? <ActivitySpinnerIcon className="size-3" /> : null}
                Load more
              </button>
            ) : null}
            <RelatedChatAddControl controller={controller} empty={false} />
          </div>
        ) : null}
        {showEmptyControl ? (
          <RelatedChatAddControl controller={controller} empty={true} openOnMount={openOnMount} />
        ) : null}
      </div>
    </PageStagePropertyRow>
  );
}

function DataSourcePropertyRow({
  item,
  controls,
  trailing,
  openOnMount,
}: {
  readonly item: PageStageController["propertyControls"]["properties"][number];
  readonly controls: PageStageController["propertyControls"];
  /** Content after a content-sized value, such as the Status row's turn. */
  readonly trailing?: ReactNode;
  readonly openOnMount: boolean;
}) {
  return (
    <PageStagePropertyRow
      icon={createElement(dataSourcePropertyIcon(item.property))}
      label={item.property.name}
      data-page-stage-property-id={item.property.propertyId}
    >
      {trailing ? (
        // A narrow Page moves the trailing content to a line of its own instead of truncating it.
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 *:min-h-7.5">
          <div className="flex shrink-0 items-center">
            <PageStageDataSourcePropertyControl
              item={item}
              controls={controls}
              openOnMount={openOnMount}
            />
          </div>
          {trailing}
        </div>
      ) : (
        <PageStageDataSourcePropertyControl
          item={item}
          controls={controls}
          openOnMount={openOnMount}
          className="flex-1"
        />
      )}
    </PageStagePropertyRow>
  );
}

const isStatusRow = (row: PageStagePropertyRowModel) =>
  row.kind === "property" &&
  resolveDataSourcePropertyPresentationRole(row.item.property).kind === "status";

/** Whose move the Page waits for joins its Status, so stage and turn read as one fact. */
function PageStatusTurnSlot({ controller }: PageStagePropertiesSectionProps) {
  const { onOpenPage, contentRoutingContext } = controller;
  return (
    <PageStatusTurn
      pageId={controller.page?.id ?? ""}
      onOpenChat={controller.onOpenRelatedChat}
      onOpenPage={
        onOpenPage
          ? (pageId) => void onOpenPage({ routingContext: contentRoutingContext, pageId })
          : undefined
      }
    />
  );
}

function PropertyListRow({
  row,
  controller,
  openOnMount,
}: PageStagePropertiesSectionProps & {
  readonly row: PageStagePropertyRowModel;
  readonly openOnMount: boolean;
}) {
  if (row.kind === "property") {
    return (
      <DataSourcePropertyRow
        item={row.item}
        controls={controller.propertyControls}
        openOnMount={openOnMount}
        trailing={isStatusRow(row) ? <PageStatusTurnSlot controller={controller} /> : undefined}
      />
    );
  }
  if (!controller.schedulePage) return null;
  return (
    <PageStagePropertyRow icon={<ClockIcon />} label="Schedule">
      <SchedulePopover
        schedule={controller.schedule}
        page={controller.schedulePage}
        openOnMount={openOnMount}
      />
    </PageStagePropertyRow>
  );
}

/** Page capabilities that share the Properties disclosure with Source Properties. */
const ASSIGNEE_KEY = "page:assignee";
const LINKED_CHATS_KEY = "page:linked-chats";
const FILES_KEY = "page:files";

interface TuckedPropertyChoice {
  readonly key: string;
  readonly icon: ReactNode;
  readonly label: string;
}

/**
 * Empty properties, by name only. Choosing one adds its row to the list with its editor open,
 * so a Page never spends a line saying that something is empty.
 */
function TuckedPropertyChoices({
  choices,
  onChoose,
}: {
  readonly choices: readonly TuckedPropertyChoice[];
  readonly onChoose: (key: string) => void;
}) {
  return (
    <div role="group" aria-label="Empty properties" className="flex flex-wrap gap-x-0.5 py-0.75">
      {choices.map((choice) => (
        <button
          key={choice.key}
          type="button"
          data-page-stage-property-choice={choice.key}
          onClick={() => onChoose(choice.key)}
          className="flex h-6 max-w-56 min-w-0 cursor-interaction items-center gap-1.5 rounded-sm pr-2 pl-1 text-sm/5 text-(--foreground-tertiary) hover:bg-token-foreground/5 hover:text-(--foreground-secondary) focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-token-focus-border"
        >
          <span className="flex w-5 shrink-0 items-center justify-center [&_svg]:size-4">
            {choice.icon}
          </span>
          <span className="min-w-0 truncate">{choice.label}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * One quiet list: rows with something to say stay visible, everything else waits behind a
 * single disclosure. Opened, it shows tucked-away values as rows and empty properties as a
 * line of names to choose from. Rows never move while the Page stays mounted.
 */
export function PageStagePropertiesSection({ controller }: PageStagePropertiesSectionProps) {
  const pageId = controller.page?.id ?? "";
  const baseFiles = usePageFiles(controller.contentRoutingContext, pageId);
  const openFilesDialog = usePageFilesDialog(controller, baseFiles);
  const filesSignal = resolvePageFilesPropertySignal({
    hasManifest: baseFiles.inventory !== null,
    unplacedTotal: baseFiles.inventory?.unplaced_total ?? 0,
    hasError: baseFiles.error !== null,
  });
  const linkedChatsSignal = resolveLinkedChatsPropertySignal({
    count: controller.relatedChats.length,
    loading: controller.relatedChatsLoading,
    hasError: controller.relatedChatsError !== null,
  });
  const quietPropertiesInput: PageStageQuietPropertiesInput = {
    pageId,
    files: {
      signal: filesSignal,
      manifestRevision: baseFiles.inventory?.revision ?? null,
    },
    linkedChats: { signal: linkedChatsSignal },
  };
  const [quietPropertiesState, setQuietPropertiesState] = useState(() =>
    createPageStageQuietPropertiesState(quietPropertiesInput),
  );
  const quietProperties = advancePageStageQuietPropertiesState(
    quietPropertiesState,
    quietPropertiesInput,
  );
  if (quietProperties !== quietPropertiesState) setQuietPropertiesState(quietProperties);

  const [expandedState, setExpandedState] = useState({ pageId, expanded: false });
  const propertiesExpanded = expandedState.pageId === pageId ? expandedState.expanded : false;
  const turn = usePageTurn(pageId).data?.turn;
  const hasTurn = Boolean(turn?.reason && turn.actor.kind !== "none");
  const page = controller.page;
  // A Page with work always shows its Status row, which carries whose move it is.
  const rows = controller.propertyControls.rows
    .filter((row) =>
      row.kind === "property"
        ? !["owner", "assignee"].includes(row.item.property.propertyId)
        : controller.schedulePage !== null,
    )
    .map((row) => (hasTurn && isStatusRow(row) ? { ...row, shownByLayout: true } : row));
  const entries: readonly PageStagePropertyDisclosureEntry[] = [
    ...rows,
    ...(page?.pageWork
      ? [{ key: ASSIGNEE_KEY, shownByLayout: Boolean(page.pageWork.assignee), empty: true }]
      : []),
    ...(controller.hasRelatedChatsRow
      ? [
          {
            key: LINKED_CHATS_KEY,
            shownByLayout: quietProperties.linkedChats.visible,
            empty: true,
          },
        ]
      : []),
    {
      key: FILES_KEY,
      shownByLayout: quietProperties.files.visible,
      empty: (baseFiles.inventory?.total ?? 0) === 0,
    },
  ];
  const [disclosureState, setDisclosureState] = useState<PageStagePropertyDisclosureState | null>(
    null,
  );
  const disclosure = advancePageStagePropertyDisclosure(disclosureState, {
    pageId,
    entries,
    expanded: propertiesExpanded,
  });
  if (disclosure !== disclosureState) setDisclosureState(disclosure);
  /** The entry the person just chose, whose editor opens as its row mounts. */
  const [chosen, setChosen] = useState<{ readonly pageId: string; readonly key: string } | null>(
    null,
  );

  if (!page) return null;
  const isShown = (key: string): boolean => disclosure.shownKeys.has(key);
  const isTuckedRow = (key: string): boolean => disclosure.tuckedRowKeys.has(key);
  const isChoice = (key: string): boolean => !isShown(key) && !isTuckedRow(key);
  const opensOnMount = (key: string): boolean => chosen?.pageId === pageId && chosen.key === key;
  const tuckedCount = entries.filter((entry) => !isShown(entry.key)).length;

  const choose = (key: string): void => {
    setDisclosureState(revealPageStageProperty(disclosure, key));
    setChosen({ pageId, key });
    // Files are managed in their own dialog, which is their editor.
    if (key === FILES_KEY) openFilesDialog();
  };
  const choices: readonly TuckedPropertyChoice[] = propertiesExpanded
    ? [
        ...rows
          .filter((row) => isChoice(row.key))
          .map((row) =>
            row.kind === "property"
              ? {
                  key: row.key,
                  icon: createElement(dataSourcePropertyIcon(row.item.property)),
                  label: row.item.property.name,
                }
              : { key: row.key, icon: <ClockIcon />, label: "Schedule" },
          ),
        ...(page.pageWork && isChoice(ASSIGNEE_KEY)
          ? [{ key: ASSIGNEE_KEY, icon: <AssigneeIcon />, label: "Assignee" }]
          : []),
        ...(controller.hasRelatedChatsRow && isChoice(LINKED_CHATS_KEY)
          ? [{ key: LINKED_CHATS_KEY, icon: <ThreadsIcon />, label: "Linked chats" }]
          : []),
        ...(isChoice(FILES_KEY) ? [{ key: FILES_KEY, icon: <FileIcon />, label: "Files" }] : []),
      ]
    : [];

  const propertyRow = (row: PageStagePropertyRowModel) => (
    <PropertyListRow
      key={row.key}
      row={row}
      controller={controller}
      openOnMount={opensOnMount(row.key)}
    />
  );
  // Mounted even while tucked away, so a File arriving meanwhile is still known to be new.
  const filesRow = (
    <PageFilesRow
      baseFiles={baseFiles}
      controller={controller}
      hidden={!isShown(FILES_KEY) && !isTuckedRow(FILES_KEY)}
    />
  );

  return (
    <section
      className="mt-2.5 flex flex-col border-b-[0.5px] border-(--table-border) pb-3"
      aria-label="Properties"
    >
      {hasTurn && !rows.some(isStatusRow) ? (
        <PageStagePropertyRow icon={<StatusIcon />} label="Status">
          <PageStatusTurnSlot controller={controller} />
        </PageStagePropertyRow>
      ) : null}
      {rows.filter((row) => isShown(row.key)).map(propertyRow)}
      <PageWorkspaceRow pageId={pageId} />
      <PageAutomationsRow pageId={pageId} />

      <PageOwnerRow
        pageWork={page.pageWork}
        onChange={(pageWork) => controller.savePage({ pageWork })}
      />
      {isShown(ASSIGNEE_KEY) ? (
        <PageAssigneeRow
          pageWork={page.pageWork}
          openOnMount={opensOnMount(ASSIGNEE_KEY)}
          onChange={(pageWork) => controller.savePage({ pageWork })}
        />
      ) : null}
      {controller.hasRelatedChatsRow && isShown(LINKED_CHATS_KEY) ? (
        <RelatedChatsPropertyRow
          controller={controller}
          openOnMount={opensOnMount(LINKED_CHATS_KEY)}
        />
      ) : null}
      {isShown(FILES_KEY) ? filesRow : null}

      {rows.filter((row) => isTuckedRow(row.key)).map(propertyRow)}
      {isShown(FILES_KEY) ? null : filesRow}
      {choices.length > 0 ? <TuckedPropertyChoices choices={choices} onChoose={choose} /> : null}

      {tuckedCount > 0 ? (
        <button
          type="button"
          aria-expanded={propertiesExpanded}
          onClick={() => setExpandedState({ pageId, expanded: !propertiesExpanded })}
          className="flex h-7.5 w-fit items-center gap-1.5 rounded-sm pr-2 pl-1 text-sm/5 text-(--foreground-tertiary) hover:bg-token-foreground/5 hover:text-(--foreground-secondary)"
        >
          <span className="flex w-5 shrink-0 items-center justify-center">
            <ChevronDownIcon
              className={cn(
                "icon-2xs transition-transform duration-150",
                propertiesExpanded && "rotate-180",
              )}
            />
          </span>
          {formatPageStageQuietPropertyCountLabel(tuckedCount, propertiesExpanded)}
        </button>
      ) : null}
    </section>
  );
}
