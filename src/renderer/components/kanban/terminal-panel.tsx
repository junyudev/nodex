import { useState, useRef, useCallback, useEffect } from "react";
import { useTerminal } from "@/lib/use-terminal";
import { getPanelHeight, setPanelHeight as storePanelHeight } from "@/lib/terminal-sessions";
import { cn } from "@/lib/utils";

const TERMINAL_MIN_HEIGHT = 120;
const TERMINAL_MAX_HEIGHT = 600;

function cwdStorageKey(projectId: string): string {
  return `terminal-cwd-${projectId}`;
}

function readStoredCwd(projectId: string): string | undefined {
  try {
    return localStorage.getItem(cwdStorageKey(projectId)) || undefined;
  } catch {
    return undefined;
  }
}

function writeStoredCwd(projectId: string, cwd: string): void {
  try {
    localStorage.setItem(cwdStorageKey(projectId), cwd);
  } catch {
    // ignore
  }
}

interface TerminalPanelProps {
  cardId: string;
  projectId: string;
  onClose: () => void;
  mode?: "card" | "project";
  sessionId?: string;
  panelHeight?: number;
  onPanelHeightChange?: (height: number) => void;
}

function clampPanelHeight(height: number): number {
  if (!Number.isFinite(height)) return TERMINAL_MIN_HEIGHT;
  return Math.min(
    TERMINAL_MAX_HEIGHT,
    Math.max(TERMINAL_MIN_HEIGHT, Math.round(height)),
  );
}

export function TerminalPanel({
  cardId,
  projectId,
  onClose,
  mode = "card",
  sessionId,
  panelHeight,
  onPanelHeightChange,
}: TerminalPanelProps) {
  const resolvedSessionId = sessionId ?? (mode === "project" ? `project:${projectId}` : cardId);
  const [uncontrolledPanelHeight, setUncontrolledPanelHeight] = useState(() =>
    getPanelHeight(resolvedSessionId),
  );
  const [cwd, setCwd] = useState(() => readStoredCwd(projectId));
  const isResizingRef = useRef(false);
  const isControlledHeight = typeof panelHeight === "number";
  const resolvedPanelHeight = clampPanelHeight(
    isControlledHeight ? panelHeight : uncontrolledPanelHeight,
  );
  const setNextPanelHeight = useCallback(
    (nextHeight: number) => {
      const normalizedHeight = clampPanelHeight(nextHeight);
      if (!isControlledHeight) {
        setUncontrolledPanelHeight(normalizedHeight);
      }
      onPanelHeightChange?.(normalizedHeight);
    },
    [isControlledHeight, onPanelHeightChange],
  );

  const { containerRef, isExited, exitCode, isUnavailable, error, reconnect } =
    useTerminal({ cardId: resolvedSessionId, visible: true, cwd });

  // ── Vertical resize handle ──────────────────────────────────────────
  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      isResizingRef.current = true;
      const startY = e.clientY;
      const startHeight = resolvedPanelHeight;

      const onMouseMove = (ev: MouseEvent) => {
        const delta = startY - ev.clientY; // dragging up = positive = taller
        setNextPanelHeight(startHeight + delta);
      };

      const onMouseUp = () => {
        isResizingRef.current = false;
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
      };

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    },
    [resolvedPanelHeight, setNextPanelHeight],
  );

  const handleResizeKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (
      event.key !== "ArrowUp" &&
      event.key !== "ArrowDown" &&
      event.key !== "Home" &&
      event.key !== "End"
    ) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    if (event.key === "Home") {
      setNextPanelHeight(TERMINAL_MIN_HEIGHT);
      return;
    }

    if (event.key === "End") {
      setNextPanelHeight(TERMINAL_MAX_HEIGHT);
      return;
    }

    const direction = event.key === "ArrowUp" ? 1 : -1;
    setNextPanelHeight(resolvedPanelHeight + direction * 24);
  }, [resolvedPanelHeight, setNextPanelHeight]);

  // Persist height per session when uncontrolled.
  useEffect(() => {
    if (isControlledHeight) return;
    storePanelHeight(resolvedSessionId, resolvedPanelHeight);
  }, [isControlledHeight, resolvedPanelHeight, resolvedSessionId]);

  // ── Cwd picker ──────────────────────────────────────────────────────
  const pickCwd = useCallback(async () => {
    if (!window.api) return;
    const result = (await window.api.invoke("pty:pick-cwd")) as string | null;
    if (result) {
      setCwd(result);
      writeStoredCwd(projectId, result);
    }
  }, [projectId]);

  // Short display name for cwd
  const cwdLabel = cwd
    ? cwd.split("/").pop() || cwd
    : undefined;

  return (
    <div
      className="flex shrink-0 flex-col"
      style={{ height: resolvedPanelHeight }}
    >
      {/* Resize handle */}
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize terminal panel height"
        aria-valuemin={TERMINAL_MIN_HEIGHT}
        aria-valuemax={TERMINAL_MAX_HEIGHT}
        aria-valuenow={resolvedPanelHeight}
        tabIndex={0}
        onMouseDown={handleResizeStart}
        onKeyDown={handleResizeKeyDown}
        className={cn(
          "h-0.75 shrink-0 cursor-row-resize outline-none",
          "transition-colors duration-150 hover:bg-(--accent-blue)",
          "active:bg-(--accent-blue)",
          "focus-visible:bg-(--accent-blue) focus-visible:ring-2 focus-visible:ring-(--ring)",
        )}
      />

      {/* Header bar */}
      <div className="flex h-8 shrink-0 items-center justify-between bg-(--background-secondary) px-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="text-xs font-medium text-(--foreground-secondary)">
            {mode === "project" ? "Project Terminal" : "Card Terminal"}
          </span>
          {cwdLabel && (
            <button
              onClick={pickCwd}
              className="max-w-40 truncate text-xs text-(--foreground-tertiary) transition-colors hover:text-(--foreground-secondary)"
              title={cwd}
            >
              {cwdLabel}
            </button>
          )}
          {!cwdLabel && (
            <button
              onClick={pickCwd}
              className={cn(
                "flex h-5 w-5 items-center justify-center rounded-sm",
                "text-(--foreground-tertiary)",
                "hover:bg-(--background-tertiary) hover:text-(--foreground-secondary)",
                "transition-colors",
              )}
              title="Set working directory"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                <path
                  d="M2 4.5A1.5 1.5 0 013.5 3h3.172a1.5 1.5 0 011.06.44l.829.828a.5.5 0 00.354.147H12.5A1.5 1.5 0 0114 5.915V11.5A1.5 1.5 0 0112.5 13h-9A1.5 1.5 0 012 11.5v-7z"
                  stroke="currentColor"
                  strokeWidth="1.3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          )}
          {isExited && (
            <span className="text-xs text-(--foreground-tertiary)">
              exited ({exitCode})
            </span>
          )}
          {error && !isExited && (
            <span className="max-w-50 truncate text-xs text-(--accent-red)" title={error}>
              {error}
            </span>
          )}
        </div>
        <div className="flex items-center gap-0.5">
          {(isExited || error) && (
            <button
              onClick={reconnect}
              className={cn(
                "flex h-6 w-6 items-center justify-center rounded-sm",
                "text-(--foreground-tertiary)",
                "hover:bg-(--background-tertiary) hover:text-(--foreground-secondary)",
                "transition-colors duration-100",
              )}
              title="Restart terminal"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                <path
                  d="M2.5 2.5v4h4M13.5 13.5v-4h-4"
                  stroke="currentColor"
                  strokeWidth="1.3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <path
                  d="M12.1 6A5 5 0 004.5 4.5L2.5 6.5M3.9 10a5 5 0 007.6 1.5l2-2"
                  stroke="currentColor"
                  strokeWidth="1.3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          )}
          <button
            onClick={onClose}
            className={cn(
              "flex h-6 w-6 items-center justify-center rounded-sm",
              "text-(--foreground-tertiary)",
              "hover:bg-(--background-tertiary) hover:text-(--foreground-secondary)",
              "transition-colors duration-100",
            )}
            title="Close terminal"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path
                d="M12 4L4 12M4 4l8 8"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>
      </div>

      {/* Terminal container */}
      {isUnavailable ? (
        <div className="flex flex-1 items-center justify-center text-sm text-(--foreground-tertiary)">
          Terminal requires the Electron desktop app
        </div>
      ) : (
        <div
          ref={containerRef}
          className="nodex-terminal min-h-0 flex-1"
        />
      )}
    </div>
  );
}
