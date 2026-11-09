import { useQuery } from "@tanstack/react-query";
import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type MouseEvent,
  type RefObject,
} from "react";
import type { Readback } from "../../../shared/readback";
import {
  ActivitySpinnerIcon,
  CheckmarkIcon,
  Close16Icon,
  StopIcon,
  UpArrowIcon,
} from "@/components/shared/icons";
import { NodexFloatingSurface } from "@/components/ui/floating-surface";
import { NodexTooltip } from "@/components/ui/tooltip";
import { ToolbarButton } from "@/components/ui/toolbar-button";
import { SidebarStatusIndicator } from "@/components/workbench/sidebar-status-indicator";
import { useAgentRuntimeSessionActivity } from "@/lib/agent-runtime-session-activity";
import { APP_SHELL_READBACK_LAYER_INDEX } from "@/lib/app-shell-layers";
import { toastFailure } from "@/lib/failure-toast";
import { projectDetailQueryOptions, projectSessionDetailQueryOptions } from "@/lib/query-options";
import { useSessionRowStatus } from "@/lib/use-session-execution";
import { cn } from "@/lib/utils";
import { replyToReadback, stopReadbackRun } from "./readback-actions";
import type { ReadbackCloseReason, ReadbackStore } from "./readback-store";
import { ReadbackText } from "./readback-text";
import { readbackVisibleDuration } from "./readback-timing";
import { readbackStore, recordReadbackStopped, useReadbackEvents } from "./readback-window";
import { useWindowFocused } from "./use-window-focused";

/** Time left on the clock when attention moves away, so a card never vanishes under the eye. */
const RESUME_GRACE_MS = 2_000;
/** How long "Sent" stays before the card leaves. */
const SENT_CONFIRMATION_MS = 1_200;

/**
 * Runs `onExpire` after `durationMs` of unpaused time. Pausing keeps the remainder, and resuming
 * leaves at least a short grace so a card does not disappear the moment attention leaves it.
 */
function usePausableTimeout(durationMs: number, paused: boolean, onExpire: () => void): void {
  const remaining = useRef(durationMs);
  const expire = useEffectEvent(onExpire);
  useEffect(() => {
    if (paused) return;
    const startedAt = Date.now();
    const timer = setTimeout(expire, remaining.current);
    return () => {
      clearTimeout(timer);
      remaining.current = Math.max(RESUME_GRACE_MS, remaining.current - (Date.now() - startedAt));
    };
  }, [paused]);
}

type CardMode =
  | { readonly kind: "reading" }
  | { readonly kind: "replying"; readonly sending: boolean }
  | { readonly kind: "sent" };

function useReadbackChat(readback: Readback) {
  const session = useQuery(projectSessionDetailQueryOptions(readback.sessionId)).data ?? null;
  const projectId = session?.projectId ?? null;
  const project = useQuery({
    ...projectDetailQueryOptions(projectId ?? ""),
    enabled: projectId !== null,
  }).data;
  const status = useSessionRowStatus(session);
  const activity = useAgentRuntimeSessionActivity(readback.sessionId);
  return {
    title: session?.displayTitle || readback.title,
    projectName: project?.name ?? null,
    status,
    /** Stop reaches only the Run this Readback describes. */
    running: activity?.activeRunId === readback.runId,
  };
}

/** A click that follows a link, presses a control or ends a text selection is not "open". */
function opensChat(event: MouseEvent<HTMLElement>) {
  if (event.target instanceof Element && event.target.closest("a, button, textarea")) return false;
  return (event.currentTarget.ownerDocument.getSelection()?.toString() ?? "").length === 0;
}

function ReadbackCard({
  readback,
  held,
  onOpen,
  onClose,
}: {
  readback: Readback;
  /** The person is pointing at or working in the stack, or the window is in the background. */
  held: boolean;
  onOpen: (readback: Readback) => void;
  onClose: (readback: Readback, reason: ReadbackCloseReason) => void;
}) {
  const chat = useReadbackChat(readback);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [mode, setMode] = useState<CardMode>({ kind: "reading" });
  const [reply, setReply] = useState("");
  const [stopping, setStopping] = useState(false);
  const replyRef = useRef<HTMLTextAreaElement>(null);
  const expanded = hovered || focused || mode.kind !== "reading";

  // A reply holds the card while it is being written, holds text or is on its way.
  const replying =
    mode.kind === "sent" ||
    (mode.kind === "replying" && (mode.sending || focused || reply.trim().length > 0));
  usePausableTimeout(readbackVisibleDuration(readback.text), held || replying, () =>
    onClose(readback, "expired"),
  );
  const closeAfterSending = useEffectEvent(() => onClose(readback, "replied"));
  useEffect(() => {
    if (mode.kind !== "sent") return;
    const timer = setTimeout(closeAfterSending, SENT_CONFIRMATION_MS);
    return () => clearTimeout(timer);
  }, [mode.kind]);

  const startReply = () => {
    setMode({ kind: "replying", sending: false });
    requestAnimationFrame(() => replyRef.current?.focus());
  };

  const stop = async () => {
    setStopping(true);
    try {
      await stopReadbackRun(readback);
      recordReadbackStopped();
      startReply();
    } catch (cause) {
      toastFailure("Couldn't stop the agent", cause);
    }
    setStopping(false);
  };

  const send = async (event?: FormEvent) => {
    event?.preventDefault();
    if (mode.kind !== "replying" || mode.sending || reply.trim().length === 0) return;
    setMode({ kind: "replying", sending: true });
    try {
      await replyToReadback(readback, reply);
      setMode({ kind: "sent" });
    } catch (cause) {
      setMode({ kind: "replying", sending: false });
      toastFailure("Couldn't send your reply", cause);
    }
  };

  const open = (event: MouseEvent<HTMLElement>) => {
    if (opensChat(event)) onOpen(readback);
  };

  return (
    <NodexFloatingSurface
      role="article"
      aria-label={`${chat.title}: readback`}
      data-readback={readback.id}
      className="pointer-events-auto w-full animate-in fade-in-0 slide-in-from-right-2 duration-200 ease-out select-text motion-reduce:animate-none"
      style={{ maxWidth: "100%", zIndex: APP_SHELL_READBACK_LAYER_INDEX }}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        if (event.currentTarget.contains(event.relatedTarget)) return;
        setFocused(false);
        // Moving on from an empty reply abandons it; a drafted one keeps the card.
        if (mode.kind === "replying" && !mode.sending && reply.trim().length === 0)
          setMode({ kind: "reading" });
      }}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.stopPropagation();
        if (mode.kind === "replying" && !mode.sending) setMode({ kind: "reading" });
        else onClose(readback, "dismissed");
      }}
    >
      <div className="flex flex-col px-3 pt-2 pb-2.5">
        <div className="flex h-6 min-w-0 items-center gap-1.5">
          {chat.status ? (
            <SidebarStatusIndicator status={chat.status} />
          ) : (
            <span aria-hidden="true" className="size-5 shrink-0" />
          )}
          <button
            type="button"
            className="min-w-0 shrink cursor-interaction truncate text-left text-sm font-medium text-token-foreground hover:underline focus-visible:underline focus-visible:outline-none"
            onClick={() => onOpen(readback)}
          >
            {chat.title}
          </button>
          {chat.projectName ? (
            <span className="max-w-[40%] shrink-0 truncate text-sm text-token-description-foreground">
              {chat.projectName}
            </span>
          ) : null}
          <span className="flex-1" />
          <ToolbarButton
            size="icon"
            aria-label="Dismiss"
            className={cn(!expanded && "invisible")}
            onClick={() => onClose(readback, "dismissed")}
          >
            <Close16Icon className="icon-xs" />
          </ToolbarButton>
        </div>
        <ReadbackText
          text={readback.text}
          mode={expanded ? "expanded" : "clamped"}
          className="mt-0.5 cursor-interaction ps-[26px]"
          onClick={open}
        />
        {expanded ? (
          <ReadbackCardFooter
            mode={mode}
            running={chat.running}
            stopping={stopping}
            reply={reply}
            replyRef={replyRef}
            onReplyChange={setReply}
            onStartReply={startReply}
            onStop={() => void stop()}
            onSend={(event) => void send(event)}
          />
        ) : null}
      </div>
    </NodexFloatingSurface>
  );
}

function ReadbackCardFooter({
  mode,
  running,
  stopping,
  reply,
  replyRef,
  onReplyChange,
  onStartReply,
  onStop,
  onSend,
}: {
  mode: CardMode;
  running: boolean;
  stopping: boolean;
  reply: string;
  replyRef: RefObject<HTMLTextAreaElement | null>;
  onReplyChange: (reply: string) => void;
  onStartReply: () => void;
  onStop: () => void;
  onSend: (event?: FormEvent) => void;
}) {
  const stopButton = running ? (
    <NodexTooltip tooltipContent="Stop" side="bottom">
      <ToolbarButton size="icon" aria-label="Stop" loading={stopping} onClick={onStop}>
        <StopIcon className="icon-xs" />
      </ToolbarButton>
    </NodexTooltip>
  ) : null;

  if (mode.kind === "sent") {
    return (
      <div className="mt-2 flex h-6 items-center justify-end gap-1 ps-[26px] text-xs text-token-description-foreground">
        <CheckmarkIcon className="shrink-0" aria-hidden="true" />
        Sent
      </div>
    );
  }

  if (mode.kind === "replying") {
    const canSend = reply.trim().length > 0 && !mode.sending;
    return (
      <form className="mt-2 ms-[26px] flex items-center gap-1" onSubmit={onSend}>
        <div className="flex min-w-0 flex-1 items-end gap-1 rounded-lg bg-token-foreground/5 py-1 ps-2.5 pe-1">
          <textarea
            ref={replyRef}
            rows={1}
            value={reply}
            aria-label="Reply"
            placeholder="Tell the agent what you meant"
            className="max-h-28 min-h-5 flex-1 resize-none bg-transparent py-0.5 text-sm leading-5 text-token-foreground [field-sizing:content] outline-none placeholder:text-token-description-foreground"
            onChange={(event) => onReplyChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
              event.preventDefault();
              onSend();
            }}
          />
          <button
            type="submit"
            aria-label="Send reply"
            disabled={!canSend}
            className="flex size-6 shrink-0 cursor-interaction items-center justify-center rounded-full bg-composer-primary text-composer-primary disabled:cursor-default disabled:opacity-40"
          >
            {mode.sending ? (
              <ActivitySpinnerIcon className="icon-xs" />
            ) : (
              <UpArrowIcon className="icon-xs" />
            )}
          </button>
        </div>
        {stopButton}
      </form>
    );
  }

  return (
    <div className="mt-2 flex items-center justify-end gap-1">
      {stopButton}
      <ToolbarButton size="compact" color="secondary" onClick={onStartReply}>
        Reply
      </ToolbarButton>
    </div>
  );
}

/**
 * The window's Readbacks, newest first, under the titlebar's trailing edge. Pointing at or
 * focusing the stack holds every card, as does the window being in the background.
 */
export function ReadbackStack({
  store,
  onOpen,
}: {
  store: ReadbackStore;
  onOpen: (readback: Readback) => void;
}) {
  const readbacks = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const windowFocused = useWindowFocused();
  const [pointerInside, setPointerInside] = useState(false);
  const [focusInside, setFocusInside] = useState(false);
  const held = pointerInside || focusInside || !windowFocused;

  if (readbacks.length === 0) return null;

  return (
    <section
      aria-label="Readbacks"
      aria-live="polite"
      data-testid="readback-stack"
      className="pointer-events-none fixed top-[calc(var(--app-shell-application-menu-height,0px)+var(--height-toolbar)+var(--spacing)*2)] right-2 flex w-[min(22.5rem,calc(100vw-16px))] flex-col gap-2"
      style={{ zIndex: APP_SHELL_READBACK_LAYER_INDEX }}
      onPointerEnter={() => setPointerInside(true)}
      onPointerLeave={() => setPointerInside(false)}
      onFocus={() => setFocusInside(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocusInside(false);
      }}
    >
      {readbacks.map((readback) => (
        <ReadbackCard
          key={readback.id}
          readback={readback}
          held={held}
          onOpen={(target) => {
            store.close(target.id, "opened");
            onOpen(target);
          }}
          onClose={(target, reason) => store.close(target.id, reason)}
        />
      ))}
    </section>
  );
}

/** Shows the Readbacks Main sends this window. */
export function ReadbackHost({ onOpen }: { onOpen: (readback: Readback) => void }) {
  useReadbackEvents();
  return <ReadbackStack store={readbackStore} onOpen={onOpen} />;
}
