import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { createReactInlineContentSpec } from "@blocknote/react";
import { AlertCircle } from "@/components/shared/icons/generic-icons";

import { NodexTooltip } from "@/components/ui/tooltip";
import {
  NodexPopover,
  NodexPopoverAnchor,
  NodexPopoverContent,
  NodexPopoverTitle,
} from "@/components/ui/popover";
import type { CodexThreadSummary } from "@/lib/types";
import {
  formatThreadMentionShortUuid,
  resolveThreadMentionDisplay,
  type ThreadMentionDisplay,
  type ThreadMentionDisplayInput,
} from "@/lib/nfm/thread-mention-display";
import { cn } from "@/lib/utils";
import { threadMentionInlineContentConfig } from "../../../../shared/block-documents/blocknote-schema-config";
import {
  ActivitySpinnerIcon,
  ArchiveIcon,
  CopyIcon,
  PlayIcon,
  SuccessCircleIcon,
  ThreadIcon,
} from "@/components/shared/icons";
import { MentionInlineFocusAffordance } from "../mention-inline-focus-affordance";
import { ThreadMentionInlineVisual } from "../thread-mention-inline-visual";

export interface ThreadMentionProps {
  uuid: string;
}

export interface ThreadMentionRuntimeValue {
  threads: Record<string, CodexThreadSummary>;
  resolvingIds: Set<string>;
  resolveThread?: (threadId: string) => Promise<CodexThreadSummary | null>;
  openThread?: (threadId: string) => void;
}

export interface ThreadMentionInlineContentUpdate {
  type: "threadMention";
  props: ThreadMentionProps;
}

const EMPTY_THREADS: Record<string, CodexThreadSummary> = {};
const EMPTY_RESOLVING_IDS = new Set<string>();

const ThreadMentionRuntimeContext = createContext<ThreadMentionRuntimeValue>({
  threads: EMPTY_THREADS,
  resolvingIds: EMPTY_RESOLVING_IDS,
});

export function ThreadMentionRuntimeProvider({
  value,
  children,
}: {
  value: ThreadMentionRuntimeValue;
  children: ReactNode;
}) {
  return (
    <ThreadMentionRuntimeContext.Provider value={value}>
      {children}
    </ThreadMentionRuntimeContext.Provider>
  );
}

export function useThreadMentionRuntime(): ThreadMentionRuntimeValue {
  return useContext(ThreadMentionRuntimeContext);
}

export function normalizeThreadMentionProps(
  input: Partial<ThreadMentionProps> | undefined,
): ThreadMentionProps {
  return {
    uuid: typeof input?.uuid === "string" ? input.uuid.trim() : "",
  };
}

function ThreadMentionStateIcon({
  thread,
  resolving,
  missing,
}: {
  thread: CodexThreadSummary | null;
  resolving: boolean;
  missing: boolean;
}) {
  if (resolving) return <ActivitySpinnerIcon className="size-3.5 shrink-0" />;
  if (missing || thread?.statusType === "systemError") {
    return <AlertCircle className="inline-block size-3.5 shrink-0" />;
  }
  if (thread?.archived) return <ArchiveIcon className="inline-block size-3.5 shrink-0" />;
  if (thread?.statusType === "active")
    return <PlayIcon className="inline-block size-3.5 shrink-0" />;
  if (thread?.statusType === "idle")
    return <SuccessCircleIcon className="inline-block size-3.5 shrink-0" />;
  return <ThreadIcon className="inline-block size-3.5 shrink-0" />;
}

export { formatThreadMentionShortUuid };

export function resolveThreadMentionChip(input: ThreadMentionDisplayInput): ThreadMentionDisplay {
  return resolveThreadMentionDisplay(input);
}

function ThreadMentionPopoverBody({
  uuid,
  thread,
  chip,
  resolving,
  missing,
}: {
  uuid: string;
  thread: CodexThreadSummary | null;
  chip: ThreadMentionDisplay;
  resolving: boolean;
  missing: boolean;
}) {
  const handleCopyUuid = async () => {
    await navigator.clipboard.writeText(uuid);
  };

  return (
    <div className="w-[min(22rem,calc(100vw-2rem))] p-1 text-sm">
      <div className="flex items-start gap-2 px-2 py-1.5">
        <div
          className={cn(
            "mt-0.5 rounded-lg p-1.5",
            chip.tone === "error"
              ? "bg-token-foreground/8 text-token-description-foreground"
              : chip.tone === "muted"
                ? "bg-token-foreground/5 text-token-description-foreground"
                : "bg-token-charts-blue/10 text-token-charts-blue",
          )}
        >
          <ThreadMentionStateIcon thread={thread} resolving={resolving} missing={missing} />
        </div>
        <div className="min-w-0 flex-1">
          <NodexPopoverTitle className="truncate text-sm font-medium text-token-foreground">
            {chip.label}
          </NodexPopoverTitle>
          <div className="mt-0.5 truncate text-xs text-token-description-foreground">
            {missing ? "This thread could not be found." : chip.detail}
          </div>
        </div>
      </div>

      <div className="mt-2 space-y-1 px-2 text-xs text-token-description-foreground">
        <div className="truncate">UUID: {uuid}</div>
        {thread?.cwd ? <div className="truncate">Workspace: {thread.cwd}</div> : null}
      </div>

      <div className="mt-3 flex flex-wrap gap-1.5 px-2 pb-1">
        <button
          type="button"
          aria-label="Copy thread UUID"
          className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-xs text-token-description-foreground hover:bg-token-foreground/5 hover:text-token-foreground"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            void handleCopyUuid();
          }}
        >
          <CopyIcon className="size-3" />
          <span>Copy UUID</span>
        </button>
      </div>
    </div>
  );
}

function ThreadMentionTooltipBody({
  uuid,
  thread,
  chip,
  missing,
}: {
  uuid: string;
  thread: CodexThreadSummary | null;
  chip: ThreadMentionDisplay;
  missing: boolean;
}) {
  return (
    <div className="max-w-[18rem] space-y-0.5 text-left">
      <div className="truncate text-sm font-medium text-token-foreground">{chip.label}</div>
      <div className="truncate text-xs text-token-description-foreground">
        {missing ? "This thread could not be found." : chip.detail}
      </div>
      <div className="truncate text-xs text-token-description-foreground">
        {thread?.cwd || uuid}
      </div>
    </div>
  );
}

export function ThreadMentionInlineContentView({
  inlineContent,
}: {
  inlineContent: { props: Partial<ThreadMentionProps> };
}) {
  const runtime = useThreadMentionRuntime();
  const [open, setOpen] = useState(false);
  const [missing, setMissing] = useState(false);
  const props = normalizeThreadMentionProps(inlineContent.props);
  const thread = props.uuid ? (runtime.threads[props.uuid] ?? null) : null;
  const resolving = props.uuid ? runtime.resolvingIds.has(props.uuid) : false;
  const chip = useMemo(
    () => resolveThreadMentionChip({ uuid: props.uuid, thread, resolving, missing }),
    [missing, props.uuid, resolving, thread],
  );
  const canOpen = Boolean(props.uuid && runtime.openThread && !missing);

  useEffect(() => {
    if (thread) {
      setMissing(false);
      return;
    }
    if (!props.uuid || thread || !runtime.resolveThread) return;

    let cancelled = false;
    setMissing(false);
    void runtime
      .resolveThread(props.uuid)
      .then((resolvedThread) => {
        if (!cancelled) setMissing(resolvedThread === null);
      })
      .catch(() => {
        if (!cancelled) setMissing(true);
      });

    return () => {
      cancelled = true;
    };
  }, [props.uuid, runtime, thread]);

  if (!props.uuid) {
    return null;
  }

  const trigger = (
    <ThreadMentionInlineVisual
      as="button"
      type="button"
      contentEditable={false}
      className={cn("cursor-interaction", missing && "text-token-description-foreground")}
      label={chip.label}
      withGuards
      onMouseDown={(event) => {
        event.preventDefault();
      }}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (canOpen) {
          runtime.openThread?.(props.uuid);
          return;
        }
        setOpen((current) => !current);
      }}
    />
  );
  const tooltipContent = (
    <ThreadMentionTooltipBody uuid={props.uuid} thread={thread} chip={chip} missing={missing} />
  );
  const renderTooltip = (children: ReactNode) => (
    <NodexTooltip
      tooltipContent={tooltipContent}
      side="top"
      align="start"
      sideOffset={4}
      delay={0}
      disabled={open}
      tooltipClassName="px-2 py-1.5"
    >
      {children}
    </NodexTooltip>
  );

  if (canOpen) {
    return (
      <MentionInlineFocusAffordance label="Open chat">
        <span className="inline align-baseline">{renderTooltip(trigger)}</span>
      </MentionInlineFocusAffordance>
    );
  }

  return (
    <NodexPopover open={open} onOpenChange={setOpen}>
      <NodexPopoverAnchor>
        <span className="inline align-baseline">{renderTooltip(trigger)}</span>
      </NodexPopoverAnchor>

      <NodexPopoverContent side="top" align="start" className="w-full" initialFocus={false}>
        <ThreadMentionPopoverBody
          uuid={props.uuid}
          thread={thread}
          chip={chip}
          resolving={resolving}
          missing={missing}
        />
      </NodexPopoverContent>
    </NodexPopover>
  );
}

export function createThreadMentionInlineContentSpec() {
  return createReactInlineContentSpec(threadMentionInlineContentConfig, {
    render: ({ inlineContent }) => (
      <ThreadMentionInlineContentView
        inlineContent={inlineContent as { props: Partial<ThreadMentionProps> }}
      />
    ),
    toExternalHTML: ({ inlineContent }) => {
      const props = normalizeThreadMentionProps(
        (inlineContent as { props: Partial<ThreadMentionProps> }).props,
      );
      const chip = resolveThreadMentionChip({ uuid: props.uuid });
      return (
        <ThreadMentionInlineVisual label={chip.label} iconClassName="text-inherit opacity-65" />
      );
    },
  });
}
