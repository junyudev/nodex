import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState, type KeyboardEventHandler, type ReactNode } from "react";
import { CheckmarkIcon, ChevronDownIcon } from "../../../../../components/shared/icons";
import { NodexTooltip } from "../../../../../components/ui/tooltip";
import { writeTextToClipboard } from "../../../../../lib/clipboard";
import { cn } from "../../../../../lib/utils";
import { CODEX_THREAD_ACCORDION_TRANSITION } from "../thread-motion";
import { CopyMessageActionButton, CopyMessageIcon } from "../thread-message-actions";
import { TerminalAnsiText } from "./terminal-ansi-text";

export type ThreadCommandShellVariant = "embedded" | "default";

interface ThreadCommandShellBlockProps {
  variant: ThreadCommandShellVariant;
  embeddedAppearance?: "default" | "plain";
  command: string;
  output: string;
  cwd?: string;
  isInProgress?: boolean;
  autoScrollToBottom?: boolean;
  shellLabel?: string;
}

interface ThreadExecShellContainerProps {
  command: string;
  output: string;
  cwd?: string;
  isInProgress?: boolean;
  footer?: ReactNode;
  autoScrollToBottom?: boolean;
  shellLabel?: string;
  surface?: "default" | "plain";
}

interface ScrollFadeState {
  top: boolean;
  bottom: boolean;
}

const INITIAL_SCROLL_FADE_STATE: ScrollFadeState = {
  top: false,
  bottom: false,
};

const COPY_FEEDBACK_MS = 1_500;

function resolveShellOutputText(output: string, isInProgress: boolean): string {
  if (/\S/.test(output)) return output;
  if (isInProgress) return "";
  return "No output";
}

function copyShellContents(command: string, output: string): string {
  return [`$ ${command}`, output].filter(Boolean).join("\n");
}

function useScrollFadeState(
  scrollRef: React.RefObject<HTMLDivElement | null>,
  enabled: boolean,
  autoScrollToBottom: boolean,
  output: string,
): ScrollFadeState {
  const [state, setState] = useState(INITIAL_SCROLL_FADE_STATE);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element || !enabled) {
      setState(INITIAL_SCROLL_FADE_STATE);
      return;
    }

    const update = () => {
      const { scrollTop, scrollHeight, clientHeight } = element;
      const scrollable = scrollHeight - clientHeight > 1;
      const reverseScrollTop = Math.max(-scrollTop, 0);
      const maxReverseScrollTop = Math.max(scrollHeight - clientHeight, 0);
      const nextState = {
        top: scrollable && reverseScrollTop < maxReverseScrollTop - 1,
        bottom: scrollable && reverseScrollTop > 1,
      };
      setState((current) =>
        current.top === nextState.top && current.bottom === nextState.bottom ? current : nextState,
      );
    };

    const frameId = window.requestAnimationFrame(() => {
      if (autoScrollToBottom) {
        element.scrollTop = 0;
      }
      update();
    });

    element.addEventListener("scroll", update);
    return () => {
      window.cancelAnimationFrame(frameId);
      element.removeEventListener("scroll", update);
    };
  }, [autoScrollToBottom, enabled, output, scrollRef]);

  return enabled ? state : INITIAL_SCROLL_FADE_STATE;
}

function ShellHeaderActionButton({
  tooltip,
  onClick,
  children,
}: {
  tooltip: ReactNode;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <NodexTooltip tooltipContent={tooltip}>
      <button
        type="button"
        className="hover:bg-transparent hover:text-token-button-foreground inline-flex size-7 items-center justify-center text-token-description-foreground"
        onClick={onClick}
      >
        {children}
      </button>
    </NodexTooltip>
  );
}

function ShellOutputFooter({
  command,
  isInProgress,
  output,
}: {
  command: string;
  isInProgress: boolean;
  output: string;
}) {
  const [copiedShell, setCopiedShell] = useState(false);
  const resetTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (resetTimerRef.current !== null) {
        window.clearTimeout(resetTimerRef.current);
      }
    };
  }, []);

  const handleCopyShell = async () => {
    const didCopy = await writeTextToClipboard(copyShellContents(command, output));
    if (!didCopy) return;

    if (resetTimerRef.current !== null) {
      window.clearTimeout(resetTimerRef.current);
    }

    setCopiedShell(true);
    resetTimerRef.current = window.setTimeout(() => {
      setCopiedShell(false);
      resetTimerRef.current = null;
    }, COPY_FEEDBACK_MS);
  };

  if (isInProgress) {
    return <div className="text-size-chat px-2.5 pt-0.5 pb-1" />;
  }

  return (
    <div className="flex items-center justify-end gap-1 px-2 py-1">
      <ShellHeaderActionButton
        tooltip={copiedShell ? "Copied shell contents" : "Copy shell contents"}
        onClick={() => {
          void handleCopyShell();
        }}
      >
        {copiedShell ? (
          <CheckmarkIcon className="icon-xxs" />
        ) : (
          <span className="inline-flex [&>svg]:icon-xxs">
            <CopyMessageIcon />
          </span>
        )}
      </ShellHeaderActionButton>
    </div>
  );
}

export function ThreadCommandShellBlock({
  variant,
  embeddedAppearance = "default",
  command,
  output,
  cwd,
  isInProgress = false,
  autoScrollToBottom = false,
  shellLabel = "Shell",
}: ThreadCommandShellBlockProps) {
  const [copiedShellContents, setCopiedShellContents] = useState(false);
  const [shellExpanded, setShellExpanded] = useState(true);
  const [isCommandExpanded, setIsCommandExpanded] = useState(false);
  const resetTimerRef = useRef<number | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const renderedOutput = resolveShellOutputText(output, isInProgress);
  const showCommandLine = variant === "embedded" && command.trim().length > 0;
  const isPlainEmbedded = variant === "embedded" && embeddedAppearance === "plain";
  const scrollFadeState = useScrollFadeState(
    scrollRef,
    variant === "default",
    autoScrollToBottom,
    output,
  );

  useEffect(() => {
    setIsCommandExpanded(false);
  }, [command]);

  useEffect(() => {
    return () => {
      if (resetTimerRef.current !== null) {
        window.clearTimeout(resetTimerRef.current);
      }
    };
  }, []);

  const handleCommandLineExpand = () => {
    setIsCommandExpanded(true);
  };

  const handleCommandLineKeyDown: KeyboardEventHandler<HTMLDivElement> = (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    handleCommandLineExpand();
  };

  const handleCopyShellContents = async () => {
    const didCopy = await writeTextToClipboard(copyShellContents(command, output));
    if (!didCopy) return;

    if (resetTimerRef.current !== null) {
      window.clearTimeout(resetTimerRef.current);
    }

    setCopiedShellContents(true);
    resetTimerRef.current = window.setTimeout(() => {
      setCopiedShellContents(false);
      resetTimerRef.current = null;
    }, COPY_FEEDBACK_MS);
  };

  const shellBody = (
    <div className="relative">
      {showCommandLine ? (
        <div className="px-2 pt-2">
          <div className="group/command relative pr-6">
            <div
              className="cursor-interaction"
              role="button"
              tabIndex={0}
              aria-expanded={isCommandExpanded}
              data-command-shell-line-toggle
              onClick={handleCommandLineExpand}
              onKeyDown={handleCommandLineKeyDown}
            >
              <code
                className={cn(
                  "text-size-chat-sm text-token-description-foreground whitespace-pre-wrap break-words font-vscode-editor",
                  !isCommandExpanded && "line-clamp-2",
                )}
                data-command-shell-line
              >
                <span>{`$ ${command}`}</span>
              </code>
            </div>
            <CopyMessageActionButton
              text={command}
              label="Copy command"
              copiedLabel="Copied"
              tooltipLabel="Copy command"
              copiedTooltipLabel="Copied"
              className="absolute top-0 right-0 opacity-0 transition-opacity duration-basic group-hover/command:opacity-100 [&>svg]:icon-2xs"
            />
          </div>
        </div>
      ) : null}
      <div className="group/output relative min-h-[1.25rem] pe-0">
        <div
          ref={scrollRef}
          className={cn(
            "vertical-scroll-fade-mask max-h-36 [--edge-fade-distance:2rem] box-border flex flex-col-reverse overflow-x-auto overflow-y-auto whitespace-pre font-vscode-editor font-medium [animation-direction:reverse]",
            isPlainEmbedded ? "text-token-foreground" : "text-token-description-foreground",
            variant === "embedded" ? "text-size-chat-sm" : "text-size-code-sm",
          )}
        >
          <div className={cn("w-max min-w-full", isPlainEmbedded ? "p-3" : "p-2")}>
            <TerminalAnsiText
              className={cn(
                variant === "embedded"
                  ? isPlainEmbedded
                    ? "text-token-foreground"
                    : "text-token-description-foreground"
                  : "text-token-input-placeholder-foreground opacity-80",
              )}
              value={renderedOutput}
            />
          </div>
        </div>
        <CopyMessageActionButton
          text={output}
          label="Copy output"
          copiedLabel="Copied"
          tooltipLabel="Copy output"
          copiedTooltipLabel="Copied"
          className="absolute top-0 right-2.5 opacity-0 transition-opacity duration-basic group-hover/output:opacity-100 [&>svg]:icon-2xs"
        />
        {variant === "default" && scrollFadeState.top ? (
          <div
            className="pointer-events-none absolute inset-x-0 top-0 h-6"
            style={{
              backgroundImage:
                "linear-gradient(to bottom, var(--color-token-editor-background), transparent)",
            }}
          />
        ) : null}
        {variant === "default" && scrollFadeState.bottom ? (
          <div
            className="pointer-events-none absolute inset-x-0 bottom-0 h-6"
            style={{
              backgroundImage:
                "linear-gradient(to top, var(--color-token-editor-background), transparent)",
            }}
          />
        ) : null}
      </div>
    </div>
  );

  if (variant === "embedded") {
    return (
      <div className="flex flex-col overflow-clip rounded-none border-none">
        {isPlainEmbedded ? null : (
          <div className="flex items-center justify-between gap-2 px-2 py-1 font-sans text-sm text-token-description-foreground select-none">
            <span>{shellLabel}</span>
          </div>
        )}
        {shellBody}
      </div>
    );
  }

  return (
    <div className="flex flex-col overflow-clip rounded-lg border border-token-border">
      <div className="flex items-center justify-between bg-token-side-bar-background pl-2 text-sm font-medium text-ellipsis hover:bg-token-editor-background/40">
        <div className="flex min-w-0 items-center gap-2">
          <span>{shellLabel}</span>
          {cwd ? <span className="truncate text-token-description-foreground">{cwd}</span> : null}
        </div>
        <div className="flex items-center">
          <ShellHeaderActionButton
            tooltip={copiedShellContents ? "Copied shell contents" : "Copy shell contents"}
            onClick={() => {
              void handleCopyShellContents();
            }}
          >
            {copiedShellContents ? (
              <CheckmarkIcon className="icon-xxs" />
            ) : (
              <span className="inline-flex [&>svg]:icon-2xs">
                <CopyMessageIcon />
              </span>
            )}
          </ShellHeaderActionButton>
          <ShellHeaderActionButton
            tooltip={shellExpanded ? "Collapse shell" : "Expand shell"}
            onClick={() => setShellExpanded((current) => !current)}
          >
            <ChevronDownIcon
              className={cn("icon-2xs transition-transform", !shellExpanded && "-rotate-90")}
            />
          </ShellHeaderActionButton>
        </div>
      </div>
      <AnimatePresence initial={false}>
        {shellExpanded ? (
          <motion.div
            key="shell-content"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={CODEX_THREAD_ACCORDION_TRANSITION}
            className="relative overflow-hidden"
          >
            {shellBody}
            <ShellOutputFooter command={command} isInProgress={isInProgress} output={output} />
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

/** Owns the transcript-card chrome around an otherwise unframed embedded shell. */
export function ThreadExecShellContainer({
  command,
  output,
  cwd,
  isInProgress = false,
  footer,
  autoScrollToBottom = false,
  shellLabel = "Shell",
  surface = "default",
}: ThreadExecShellContainerProps) {
  return (
    <div
      className={cn(
        "group flex flex-col overflow-hidden rounded-lg border border-strong",
        surface === "plain"
          ? "bg-token-main-surface-primary"
          : "bg-token-text-code-block-background",
      )}
    >
      <ThreadCommandShellBlock
        variant="embedded"
        embeddedAppearance={surface}
        command={command}
        output={output}
        cwd={cwd}
        isInProgress={isInProgress}
        autoScrollToBottom={autoScrollToBottom}
        shellLabel={shellLabel}
      />
      {footer}
    </div>
  );
}
