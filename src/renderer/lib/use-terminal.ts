import { useEffect, useRef, useState, useCallback } from "react";
import { FitAddon, Terminal, init as initGhosttyWeb } from "ghostty-web";
import { addSession } from "./terminal-sessions";

const isElectron = typeof window !== "undefined" && !!window.api;
let ghosttyInitPromise: Promise<void> | null = null;

function ensureGhosttyInitialized(): Promise<void> {
  if (ghosttyInitPromise) {
    return ghosttyInitPromise;
  }

  ghosttyInitPromise = initGhosttyWeb().catch((error: unknown) => {
    ghosttyInitPromise = null;
    throw error;
  });
  return ghosttyInitPromise;
}

function getTerminalTheme() {
  const isDark = document.documentElement.classList.contains("dark");
  return isDark
    ? {
        background: "#181818",
        foreground: "#f0efed",
        cursor: "#f0efed",
        cursorAccent: "#181818",
        selectionBackground: "rgba(94, 159, 232, 0.35)",
        black: "#181818",
        red: "#ff6b6b",
        green: "#46a171",
        yellow: "#e5a942",
        blue: "#5e9fe8",
        magenta: "#b577d6",
        cyan: "#56b6c2",
        white: "#f0efed",
        brightBlack: "#555555",
        brightRed: "#ff8787",
        brightGreen: "#5fd7a3",
        brightYellow: "#ffd75f",
        brightBlue: "#87afff",
        brightMagenta: "#d7afff",
        brightCyan: "#87d7ff",
        brightWhite: "#ffffff",
      }
    : {
        background: "#ffffff",
        foreground: "#2c2c2b",
        cursor: "#2c2c2b",
        cursorAccent: "#ffffff",
        selectionBackground: "rgba(35, 131, 226, 0.2)",
        black: "#2c2c2b",
        red: "#ce1800",
        green: "#2d8e58",
        yellow: "#b38600",
        blue: "#2383e2",
        magenta: "#9333ea",
        cyan: "#0891b2",
        white: "#f0efed",
        brightBlack: "#7d7a75",
        brightRed: "#ef4444",
        brightGreen: "#46a171",
        brightYellow: "#d4a017",
        brightBlue: "#5e9fe8",
        brightMagenta: "#b577d6",
        brightCyan: "#56b6c2",
        brightWhite: "#ffffff",
      };
}

// ── Module-level terminal cache ─────────────────────────────────────
// Terminal instances survive component unmount/remount so that
// scrollback content is preserved across card switches (DOM reparenting).

interface CachedTerminal {
  term: Terminal;
  fit: FitAddon;
  cwd: string | undefined;
  exited: boolean;
  exitCode: number | null;
}

const terminalCache = new Map<string, CachedTerminal>();

function applyTerminalTheme(term: Terminal): void {
  const theme = getTerminalTheme();
  if (term.renderer) {
    term.renderer.setTheme(theme);
    return;
  }
  term.options.theme = theme;
}

export interface UseTerminalOptions {
  cardId: string;
  visible: boolean;
  cwd?: string;
}

export interface UseTerminalReturn {
  containerRef: React.RefObject<HTMLDivElement | null>;
  isConnected: boolean;
  isExited: boolean;
  exitCode: number | null;
  isUnavailable: boolean;
  error: string | null;
  reconnect: () => void;
}

export function useTerminal({
  cardId,
  visible,
  cwd,
}: UseTerminalOptions): UseTerminalReturn {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [isExited, setIsExited] = useState(false);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Track latest cardId/cwd for reconnect
  const cardIdRef = useRef(cardId);
  const cwdRef = useRef(cwd);
  cardIdRef.current = cardId;
  cwdRef.current = cwd;

  const reconnect = useCallback(() => {
    if (!isElectron || !termRef.current) return;
    setIsExited(false);
    setExitCode(null);
    setError(null);
    termRef.current.clear();
    const c = terminalCache.get(cardIdRef.current);
    if (c) { c.exited = false; c.exitCode = null; }
    window.api!
      .invoke("pty:spawn", cardIdRef.current, {
        cols: termRef.current.cols,
        rows: termRef.current.rows,
        cwd: cwdRef.current,
      })
      .then((result: unknown) => {
        const r = result as { success: boolean; error?: string };
        if (r.success) {
          setIsConnected(true);
          addSession(cardIdRef.current);
        } else {
          setError(r.error ?? "Failed to spawn terminal");
          termRef.current?.write(`\r\n\x1b[31mError: ${r.error ?? "Failed to spawn terminal"}\x1b[0m\r\n`);
        }
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : "IPC error";
        setError(msg);
        termRef.current?.write(`\r\n\x1b[31mError: ${msg}\x1b[0m\r\n`);
      });
  }, []);

  useEffect(() => {
    if (!visible || !isElectron || !containerRef.current) return;

    const container = containerRef.current;
    let disposed = false;
    let teardown: (() => void) | null = null;

    // Reset React state — will be restored from cache if needed
    setIsExited(false);
    setExitCode(null);
    setError(null);
    setIsConnected(false);

    void (async () => {
      try {
        await ensureGhosttyInitialized();
        if (disposed) return;

        // Check cache for an existing Terminal instance
        let cached = terminalCache.get(cardId);
        let isNew = false;
        let restoredExited = false;

        if (cached && cached.cwd === cwd) {
          // Reparent cached terminal into current container (preserves scrollback)
          if (cached.term.element) {
            container.appendChild(cached.term.element);
          }
          // Restore exit state from cache — skip auto-spawn below
          if (cached.exited) {
            setIsExited(true);
            setExitCode(cached.exitCode);
            restoredExited = true;
          }
        } else {
          // Evict stale cache (cwd changed or missing)
          if (cached) {
            cached.term.dispose();
            terminalCache.delete(cardId);
          }

          isNew = true;
          const term = new Terminal({
            fontFamily:
              'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Symbols Nerd Font Mono", monospace',
            fontSize: 14,
            scrollback: 2000,
            cursorBlink: true,
            cursorStyle: 'bar',
            theme: getTerminalTheme(),
          });

          const fit = new FitAddon();
          term.loadAddon(fit);
          term.open(container);

          cached = { term, fit, cwd, exited: false, exitCode: null };
          terminalCache.set(cardId, cached);
        }

        const { term, fit } = cached;
        termRef.current = term;
        fitRef.current = fit;

        // Sync theme in case it changed while detached
        applyTerminalTheme(term);

        // Wire terminal input → PTY
        const inputDisposable = term.onData((data) => {
          window.api!.invoke("pty:write", cardId, data);
        });

        // Wire PTY output → terminal
        const unsubData = window.api!.on(
          "pty:data",
          (...args: unknown[]) => {
            const payload = args[0] as { sessionId: string; data: string };
            if (payload.sessionId === cardId) {
              term.write(payload.data);
            }
          },
        );

        const unsubExit = window.api!.on(
          "pty:exit",
          (...args: unknown[]) => {
            const payload = args[0] as { sessionId: string; exitCode: number };
            if (payload.sessionId !== cardId) return;
            setIsExited(true);
            setExitCode(payload.exitCode);
            setIsConnected(false);
            // Persist in cache for cross-mount state
            const c = terminalCache.get(cardId);
            if (!c) return;
            c.exited = true;
            c.exitCode = payload.exitCode;
          },
        );

        // ResizeObserver for responsive fit
        let resizeRaf = 0;
        const observer = new ResizeObserver(() => {
          cancelAnimationFrame(resizeRaf);
          resizeRaf = requestAnimationFrame(() => {
            if (!fitRef.current || !termRef.current) return;
            fitRef.current.fit();
            window.api!.invoke(
              "pty:resize",
              cardId,
              termRef.current.cols,
              termRef.current.rows,
            );
          });
        });
        observer.observe(container);

        // Defer fit + spawn/reconnect to next frame so container has layout.
        // Skip spawn if we restored an already-exited session from cache —
        // user must explicitly click "Restart" to spawn a new PTY.
        const initRaf = requestAnimationFrame(() => {
          if (disposed) return;
          fit.fit();

          if (restoredExited) return;

          const cols = term.cols;
          const rows = term.rows;
          console.log(`[terminal] ${isNew ? "init" : "reconnect"} cardId=${cardId} cols=${cols} rows=${rows} cwd=${cwd ?? "(default)"}`);

          window.api!
            .invoke("pty:spawn", cardId, { cols, rows, cwd })
            .then((result: unknown) => {
              if (disposed) return;
              const r = result as { success: boolean; error?: string };
              if (r.success) {
                setIsConnected(true);
                addSession(cardId);
              } else {
                console.error("[terminal] spawn failed:", r.error);
                setError(r.error ?? "Failed to spawn terminal");
                term.write(`\r\n\x1b[31mError: ${r.error ?? "Failed to spawn terminal"}\x1b[0m\r\n`);
              }
            })
            .catch((err: unknown) => {
              if (disposed) return;
              const msg = err instanceof Error ? err.message : "IPC error";
              console.error("[terminal] spawn IPC error:", msg);
              setError(msg);
              term.write(`\r\n\x1b[31mError: ${msg}\x1b[0m\r\n`);
            });
        });

        teardown = () => {
          cancelAnimationFrame(initRaf);
          cancelAnimationFrame(resizeRaf);
          observer.disconnect();
          inputDisposable.dispose();
          unsubData();
          unsubExit();
          // Detach from DOM but do NOT dispose — buffer preserved for reparenting.
          // PTY stays alive in the background.
          term.element?.remove();
          termRef.current = null;
          fitRef.current = null;
          setIsConnected(false);
        };

        if (!disposed) return;
        teardown();
        teardown = null;
      } catch (err: unknown) {
        if (disposed) return;
        const msg = err instanceof Error ? err.message : "Failed to initialize terminal";
        console.error("[terminal] init error:", msg);
        setError(msg);
      }
    })();

    return () => {
      disposed = true;
      if (!teardown) return;
      teardown();
      teardown = null;
    };
  }, [cardId, visible, cwd]);

  // Sync theme when dark mode changes
  useEffect(() => {
    if (!visible) return;

    const observer = new MutationObserver(() => {
      if (termRef.current) {
        applyTerminalTheme(termRef.current);
      }
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => observer.disconnect();
  }, [visible]);

  return {
    containerRef,
    isConnected,
    isExited,
    exitCode,
    isUnavailable: !isElectron,
    error,
    reconnect,
  };
}
