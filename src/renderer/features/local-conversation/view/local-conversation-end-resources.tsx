import { useState, type ReactNode } from "react";
import {
  ChevronDownIcon,
  CopyIcon,
  DownloadIcon,
  NodexLogoMarkIcon,
} from "@/components/shared/icons";
import { NodexButton } from "@/components/ui/button";
import {
  NodexDropdownItem,
  NodexDropdownMenu,
  NodexDropdownMessage,
  NodexDropdownSeparator,
} from "@/components/ui/dropdown";
import { toast } from "@/components/ui/toast";
import { FILE_LINK_OPENER_ICON_URLS } from "@/lib/file-link-opener-icons";
import {
  describeThreadOutput,
  type ThreadOutputPresentation,
} from "../projection/thread-output-presentation";
import type { ThreadSummaryPanelOutputRow } from "../projection/thread-summary-panel-output-model";
import {
  ThreadResourceCard,
  ThreadResourceCardGrid,
  ThreadResourceCardMore,
} from "./shared/thread-resource-card";
import {
  isContextMenuKey,
  ThreadOutputIcon,
  useThreadOutputOpener,
  useThreadOutputOpenInMenu,
  type ThreadOutputOpenInItem,
  type ThreadOutputScope,
} from "./use-thread-output-opener";
import {
  threadOutputHoverDetail,
  useThreadOutputDestination,
} from "./use-thread-output-destination";

/** Kind first, then the folder; the innermost folder survives truncation. */
function ThreadOutputDetail({ presentation }: { readonly presentation: ThreadOutputPresentation }) {
  const { kind, location } = presentation;
  return (
    <span className="flex min-w-0 text-sm text-token-description-foreground">
      <span className="shrink-0">{kind}</span>
      {location ? (
        <>
          <span className="shrink-0 px-1" aria-hidden>
            ·
          </span>
          <span className="truncate">{location.head}</span>
          <span className="max-w-full shrink-0 truncate">{location.tail}</span>
        </>
      ) : null}
    </span>
  );
}

function OpenInItemIcon({ item }: { readonly item: ThreadOutputOpenInItem }): ReactNode {
  if (item.kind === "preview") return <NodexLogoMarkIcon className="icon-sm" />;
  if (item.kind === "download") return <DownloadIcon className="icon-sm" />;
  if (item.kind === "copy") return <CopyIcon className="icon-sm" />;
  const src = item.kind === "reveal" ? FILE_LINK_OPENER_ICON_URLS.fileManager : item.iconUrl;
  return src ? <img src={src} alt="" className="icon-sm object-contain" aria-hidden /> : null;
}

/** Every place this output can open, listed when the menu opens; choosing one saves nothing. */
function ThreadOutputOpenInMenu({
  row,
  title,
  scope,
}: {
  readonly row: ThreadSummaryPanelOutputRow;
  readonly title: string;
  readonly scope: ThreadOutputScope;
}) {
  const menu = useThreadOutputOpenInMenu(row, scope);
  const [open, setOpen] = useState(false);
  const destinations = menu.items.filter(
    (item) => item.kind === "preview" || item.kind === "native",
  );
  const actions = menu.items.filter(
    (item) => item.kind === "reveal" || item.kind === "download" || item.kind === "copy",
  );
  const select = (item: ThreadOutputOpenInItem) => {
    void item
      .open()
      .catch(() => false)
      .then((opened) => {
        if (!opened && item.kind !== "copy") toast.danger(`Couldn’t open ${title}`);
      });
  };
  const renderItem = (item: ThreadOutputOpenInItem) => (
    <NodexDropdownItem
      key={item.id}
      leftSlot={<OpenInItemIcon item={item} />}
      onSelect={() => select(item)}
    >
      {item.isSystemDefault && item.kind === "native" ? `${item.label} (Default)` : item.label}
    </NodexDropdownItem>
  );
  return (
    <NodexDropdownMenu
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) void menu.load();
      }}
      align="end"
      contentWidth="sm"
      triggerButton={
        <NodexButton
          variant="outline"
          size="xs"
          aria-label={`Open ${title} in`}
          className="gap-1 bg-transparent"
        >
          Open in
          <ChevronDownIcon className="icon-2xs opacity-50" />
        </NodexButton>
      }
    >
      {destinations.map(renderItem)}
      {menu.isLoading ? (
        <NodexDropdownMessage compact>Loading available apps…</NodexDropdownMessage>
      ) : null}
      {menu.error ? (
        <NodexDropdownMessage compact tone="error">
          Couldn’t list apps
        </NodexDropdownMessage>
      ) : null}
      {destinations.length > 0 && actions.length > 0 ? <NodexDropdownSeparator /> : null}
      {actions.map(renderItem)}
    </NodexDropdownMenu>
  );
}

function ThreadOutputCard({
  row,
  scope,
  outputs,
}: {
  readonly row: ThreadSummaryPanelOutputRow;
  readonly scope: ThreadOutputScope;
  readonly outputs: ReturnType<typeof useThreadOutputOpener>;
}) {
  const presentation = describeThreadOutput(row, scope.cwd);
  const destination = useThreadOutputDestination(row, scope.hostId);
  return (
    <ThreadResourceCard
      aria-label={`Open ${presentation.title}`}
      icon={<ThreadOutputIcon row={row} className="size-5" />}
      title={presentation.title}
      detail={<ThreadOutputDetail presentation={presentation} />}
      hoverDetail={threadOutputHoverDetail(destination)}
      trailing={<ThreadOutputOpenInMenu row={row} title={presentation.title} scope={scope} />}
      onClick={(event) => {
        const origin = event.currentTarget;
        void outputs.openFromEvent(row, event).then((opened) => {
          if (!opened && origin.isConnected) toast.danger(`Couldn’t open ${presentation.title}`);
        });
      }}
      onAuxClick={(event) => {
        if (event.button === 1) void outputs.openFromEvent(row, event);
      }}
      onContextMenu={(event) => outputs.openContextMenu(row, event)}
      onKeyDown={(event) => {
        if (isContextMenuKey(event)) outputs.openContextMenu(row, event);
      }}
    />
  );
}

/** The deliverables a completed turn produced, as cards that belong to its reply. */
export function LocalConversationEndResources({
  resources,
  ...scope
}: {
  readonly resources: readonly ThreadSummaryPanelOutputRow[];
} & ThreadOutputScope) {
  const [expanded, setExpanded] = useState(false);
  const outputs = useThreadOutputOpener(scope);
  if (resources.length === 0) return null;
  const visible = expanded || resources.length <= 4 ? resources : resources.slice(0, 3);
  const hiddenCount = resources.length - visible.length;
  return (
    <div data-content-search-skip="true" className="flex flex-col gap-2">
      <ThreadResourceCardGrid>
        {visible.map((resource) => (
          <ThreadOutputCard key={resource.id} row={resource} scope={scope} outputs={outputs} />
        ))}
      </ThreadResourceCardGrid>
      {hiddenCount > 0 ? (
        <ThreadResourceCardMore
          label={`Show ${hiddenCount} more`}
          onClick={() => setExpanded(true)}
        />
      ) : null}
    </div>
  );
}
