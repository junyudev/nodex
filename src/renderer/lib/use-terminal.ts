import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { ClipboardAddon } from "@xterm/addon-clipboard";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal, type IDisposable, type ITheme } from "@xterm/xterm";
import {
  isTerminalRuntimeAvailable,
  terminalSessionStore,
  type TerminalStoreEvent,
} from "./terminal-session-store";
import {
  ensureTerminalTypographyLoaded,
  resolveTerminalTypography,
  sameTerminalTypography,
  type TerminalTypography,
} from "./terminal-typography";
import type { TerminalSize } from "../../shared/types";

type XtermWithPrivateCore = Terminal & {
  _core?: {
    _mouseService?: {
      getCoords?: (...args: unknown[]) => unknown;
      getMouseReportCoords?: (...args: unknown[]) => unknown;
    };
    _selectionService?: {
      _getMouseEventScrollAmount?: (...args: unknown[]) => unknown;
      _screenElement?: HTMLElement;
    };
  };
};

interface TerminalCssVars {
  background: string;
  foreground: string;
}

function readCssVar(styles: CSSStyleDeclaration, name: string, fallback: string): string {
  const value = styles.getPropertyValue(name).trim();
  return value.length > 0 ? value : fallback;
}

/** Resolves the active semantic palette for xterm's canvas renderer. */
export function readTerminalTheme(element: HTMLElement): ITheme & TerminalCssVars {
  const styles = getComputedStyle(element);
  const background = readCssVar(styles, "--color-codex-terminal-background", "transparent");
  const foreground = readCssVar(styles, "--color-codex-terminal-foreground", "#f0efed");

  return {
    background,
    foreground,
    cursor: foreground,
    selectionBackground: readCssVar(
      styles,
      "--color-codex-terminal-selection",
      "rgba(94, 159, 232, 0.35)",
    ),
    selectionInactiveBackground: readCssVar(
      styles,
      "--color-codex-terminal-selection-inactive",
      "rgba(94, 159, 232, 0.2)",
    ),
    black: readCssVar(styles, "--color-codex-terminal-ansi-black", "#181818"),
    red: readCssVar(styles, "--color-codex-terminal-ansi-red", "#ff6b6b"),
    green: readCssVar(styles, "--color-codex-terminal-ansi-green", "#46a171"),
    yellow: readCssVar(styles, "--color-codex-terminal-ansi-yellow", "#e5a942"),
    blue: readCssVar(styles, "--color-codex-terminal-ansi-blue", "#5e9fe8"),
    magenta: readCssVar(styles, "--color-codex-terminal-ansi-magenta", "#b577d6"),
    cyan: readCssVar(styles, "--color-codex-terminal-ansi-cyan", "#56b6c2"),
    white: readCssVar(styles, "--color-codex-terminal-ansi-white", "#f0efed"),
    brightBlack: readCssVar(styles, "--color-codex-terminal-ansi-bright-black", "#555555"),
    brightRed: readCssVar(styles, "--color-codex-terminal-ansi-bright-red", "#ff8787"),
    brightGreen: readCssVar(styles, "--color-codex-terminal-ansi-bright-green", "#5fd7a3"),
    brightYellow: readCssVar(styles, "--color-codex-terminal-ansi-bright-yellow", "#ffd75f"),
    brightBlue: readCssVar(styles, "--color-codex-terminal-ansi-bright-blue", "#87afff"),
    brightMagenta: readCssVar(styles, "--color-codex-terminal-ansi-bright-magenta", "#d7afff"),
    brightCyan: readCssVar(styles, "--color-codex-terminal-ansi-bright-cyan", "#87d7ff"),
    brightWhite: readCssVar(styles, "--color-codex-terminal-ansi-bright-white", "#ffffff"),
  };
}

function normalizeLineEndingsForXterm(input: string): string {
  return input.replace(/\r?\n/gu, "\r\n");
}

function getWindowZoom(): number {
  if (typeof window === "undefined") return 1;

  const value = getComputedStyle(document.documentElement)
    .getPropertyValue("--codex-window-zoom")
    .trim();
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function scaleMouseEventCoordinates(event: unknown, rect: DOMRect, zoom: number): unknown {
  if (zoom === 1 || !(event instanceof MouseEvent)) return event;
  const clientX = rect.left + (event.clientX - rect.left) / zoom;
  const clientY = rect.top + (event.clientY - rect.top) / zoom;

  return new Proxy(event, {
    get(target, property) {
      if (property === "clientX") return clientX;
      if (property === "clientY") return clientY;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function patchXtermWindowZoomMouseCoordinates(term: Terminal): () => void {
  const core = (term as XtermWithPrivateCore)._core;
  const mouseService = core?._mouseService;
  if (!mouseService?.getCoords || !mouseService.getMouseReportCoords) return () => {};

  const originalGetCoords = mouseService.getCoords;
  const originalGetMouseReportCoords = mouseService.getMouseReportCoords;
  const selectionService = core?._selectionService;
  const originalGetMouseEventScrollAmount = selectionService?._getMouseEventScrollAmount;
  const screenElement = selectionService?._screenElement;

  const scaledEvent = (event: unknown, element: unknown): unknown => {
    if (!(element instanceof HTMLElement)) return event;
    return scaleMouseEventCoordinates(event, element.getBoundingClientRect(), getWindowZoom());
  };

  mouseService.getCoords = function patchedGetCoords(
    this: unknown,
    event: unknown,
    element: unknown,
    ...args: unknown[]
  ) {
    return originalGetCoords.call(this, scaledEvent(event, element), element, ...args);
  };
  mouseService.getMouseReportCoords = function patchedGetMouseReportCoords(
    this: unknown,
    event: unknown,
    element: unknown,
  ) {
    return originalGetMouseReportCoords.call(this, scaledEvent(event, element), element);
  };

  if (selectionService && originalGetMouseEventScrollAmount && screenElement) {
    selectionService._getMouseEventScrollAmount = function patchedGetMouseEventScrollAmount(
      this: unknown,
      event: unknown,
    ) {
      return originalGetMouseEventScrollAmount.call(this, scaledEvent(event, screenElement));
    };
  }

  return () => {
    mouseService.getCoords = originalGetCoords;
    mouseService.getMouseReportCoords = originalGetMouseReportCoords;
    if (selectionService && originalGetMouseEventScrollAmount) {
      selectionService._getMouseEventScrollAmount = originalGetMouseEventScrollAmount;
    }
  };
}

async function writeClipboardText(text: string): Promise<void> {
  if (!navigator.clipboard?.writeText) return;
  await navigator.clipboard.writeText(text);
}

async function readClipboardText(): Promise<string | null> {
  if (!navigator.clipboard?.readText) return null;
  try {
    return await navigator.clipboard.readText();
  } catch {
    return null;
  }
}

function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  return /mac/i.test(navigator.platform);
}

function installCodexKeyHandler(
  term: Terminal,
  terminalId: string,
  onNewTerminalTab: (() => void) | undefined,
): void {
  term.attachCustomKeyEventHandler((event) => {
    if (event.type !== "keydown") return true;

    const isMac = isMacPlatform();
    const key = event.key.toLowerCase();
    const primaryModifier = isMac ? event.metaKey : event.ctrlKey;

    if (primaryModifier && key === "t" && !event.shiftKey && !event.altKey) {
      onNewTerminalTab?.();
      event.preventDefault();
      return false;
    }

    const selectedText = term.getSelection();
    if (selectedText && primaryModifier && key === "c" && !event.altKey) {
      void writeClipboardText(selectedText);
      event.preventDefault();
      return false;
    }

    const shouldPaste =
      (primaryModifier && key === "v" && (!isMac || event.shiftKey)) ||
      (event.shiftKey && event.key === "Insert");
    if (shouldPaste) {
      void readClipboardText().then((text) => {
        if (text) terminalSessionStore.write(terminalId, text);
      });
      event.preventDefault();
      return false;
    }

    if (isMac && event.metaKey && !event.ctrlKey && !event.altKey) {
      if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
        terminalSessionStore.write(terminalId, "\x01");
        event.preventDefault();
        return false;
      }
      if (event.key === "ArrowRight" || event.key === "ArrowDown") {
        terminalSessionStore.write(terminalId, "\x05");
        event.preventDefault();
        return false;
      }
      if (event.key === "Backspace") {
        terminalSessionStore.write(terminalId, "\x15");
        event.preventDefault();
        return false;
      }
      if (event.key === "Delete") {
        terminalSessionStore.write(terminalId, "\x0b");
        event.preventDefault();
        return false;
      }
    }

    if (event.key === "Enter") {
      window.dispatchEvent(
        new CustomEvent("nodex:terminal-enter", {
          detail: { terminalId },
        }),
      );
    }

    return true;
  });
}

function fitAndResize(terminalId: string, term: Terminal, fit: FitAddon): TerminalSize | null {
  try {
    fit.fit();
    const size = { cols: term.cols, rows: term.rows };
    terminalSessionStore.resize(terminalId, size);
    return size;
  } catch {
    return null;
  }
}

export interface UseTerminalOptions {
  terminalId: string;
  visible: boolean;
  cwd: string;
  conversationId?: string | null;
  projectSessionId?: string | null;
  onNewTerminalTab?: () => void;
}

export interface UseTerminalReturn {
  containerRef: RefObject<HTMLDivElement | null>;
  isConnected: boolean;
  isExited: boolean;
  exitCode: number | null;
  isUnavailable: boolean;
  error: string | null;
  leaseConflict: {
    generation: number;
    ownerWindowSessionId: string;
  } | null;
  reconnect: () => void;
  takeOver: () => void;
  kill: () => void;
}

export function useTerminal({
  terminalId,
  visible,
  cwd,
  conversationId,
  projectSessionId,
  onNewTerminalTab,
}: UseTerminalOptions): UseTerminalReturn {
  const normalizedCwd = cwd.trim();
  const hasValidCwd = normalizedCwd.length > 0;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  // Keep xterm mounted across WorkbenchShell rerenders; tab callbacks often change identity.
  const onNewTerminalTabRef = useRef(onNewTerminalTab);
  const [isConnected, setIsConnected] = useState(false);
  const [isExited, setIsExited] = useState(false);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [leaseConflict, setLeaseConflict] = useState<{
    generation: number;
    ownerWindowSessionId: string;
  } | null>(null);
  onNewTerminalTabRef.current = onNewTerminalTab;

  const latestOptionsRef = useRef({
    terminalId,
    cwd: normalizedCwd,
    conversationId,
    projectSessionId,
  });
  latestOptionsRef.current = {
    terminalId,
    cwd: normalizedCwd,
    conversationId,
    projectSessionId,
  };

  const reconnect = useCallback(() => {
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit || !hasValidCwd || !isTerminalRuntimeAvailable()) return;

    term.clear();
    setError(null);
    setIsExited(false);
    setExitCode(null);
    const size = fitAndResize(terminalId, term, fit) ?? {
      cols: term.cols,
      rows: term.rows,
    };
    void terminalSessionStore.createOrAttach({
      sessionId: terminalId,
      conversationId: latestOptionsRef.current.conversationId,
      projectSessionId: latestOptionsRef.current.projectSessionId,
      cwd: latestOptionsRef.current.cwd,
      size,
    });
  }, [hasValidCwd, terminalId]);

  const takeOver = useCallback(() => {
    const conflict = terminalSessionStore.getLeaseConflict(terminalId);
    const term = termRef.current;
    const fit = fitRef.current;
    if (!conflict || !term || !fit || !isTerminalRuntimeAvailable()) return;

    const size = fitAndResize(terminalId, term, fit) ?? {
      cols: term.cols,
      rows: term.rows,
    };
    void terminalSessionStore.takeOver({
      sessionId: terminalId,
      expectedGeneration: conflict.generation,
      size,
    });
  }, [terminalId]);

  const kill = useCallback(() => {
    terminalSessionStore.kill(terminalId);
  }, [terminalId]);

  useEffect(() => {
    if (!visible || !hasValidCwd || !containerRef.current || !isTerminalRuntimeAvailable()) return;

    const container = containerRef.current;
    const theme = readTerminalTheme(container);
    const initialTypography = resolveTerminalTypography(container);
    const term = new Terminal({
      allowTransparency: true,
      allowProposedApi: true,
      cursorBlink: true,
      cursorStyle: "bar",
      fontFamily: initialTypography.fontFamily,
      fontSize: initialTypography.fontSize,
      letterSpacing: 0,
      lineHeight: 1.2,
      scrollback: 2_000,
      theme,
    });
    const fit = new FitAddon();
    const disposables: IDisposable[] = [];
    let disposed = false;
    let resizeRaf = 0;
    let initRaf = 0;
    let typographyGeneration = 0;

    termRef.current = term;
    fitRef.current = fit;

    term.loadAddon(new ClipboardAddon());
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(container);
    installCodexKeyHandler(term, terminalId, () => {
      onNewTerminalTabRef.current?.();
    });
    const restoreMouseCoordinates = patchXtermWindowZoomMouseCoordinates(term);
    const writeDisplayData = (data: string) => {
      const displayData = normalizeLineEndingsForXterm(data);
      if (!displayData) return;

      term.write(displayData);
    };
    const replayDisplayLog = (data: string) => {
      term.reset();
      writeDisplayData(data);
    };

    const handleStoreEvent = (event: TerminalStoreEvent) => {
      if (disposed || event.sessionId !== terminalId) return;

      if (event.type === "data") {
        writeDisplayData(event.data);
        return;
      }

      if (event.type === "init-log") {
        replayDisplayLog(event.data);
        setIsExited(event.snapshot.exited);
        setExitCode(event.snapshot.exitCode);
        return;
      }

      if (event.type === "attached") {
        setIsConnected(true);
        setIsExited(event.snapshot.exited);
        setExitCode(event.snapshot.exitCode);
        setError(null);
        setLeaseConflict(null);
        return;
      }

      if (event.type === "error") {
        setError(event.message);
        term.write(`\r\n\x1b[31mError: ${event.message}\x1b[0m\r\n`);
        return;
      }

      if (event.type === "lease-conflict") {
        const snapshot = terminalSessionStore.getSnapshot(terminalId);
        replayDisplayLog(snapshot.buffer);
        setIsConnected(false);
        setIsExited(snapshot.exited);
        setExitCode(snapshot.exitCode);
        setError(null);
        setLeaseConflict({
          generation: event.generation,
          ownerWindowSessionId: event.ownerWindowSessionId,
        });
        return;
      }

      if (event.type === "lease-acquired") {
        setIsConnected(true);
        setError(null);
        setLeaseConflict(null);
        return;
      }

      setIsConnected(false);
      setIsExited(true);
      setExitCode(event.exitCode);
      setLeaseConflict(null);
    };

    const unsubscribe = terminalSessionStore.subscribe(terminalId, handleStoreEvent);
    disposables.push(
      term.onData((data) => {
        terminalSessionStore.write(terminalId, data);
      }),
    );

    const observer = new ResizeObserver(() => {
      window.cancelAnimationFrame(resizeRaf);
      resizeRaf = window.requestAnimationFrame(() => {
        if (disposed) return;
        fitAndResize(terminalId, term, fit);
      });
    });
    observer.observe(container);

    const applyTypography = (nextTypography: TerminalTypography) => {
      const generation = ++typographyGeneration;
      void ensureTerminalTypographyLoaded(nextTypography).then(() => {
        if (disposed || generation !== typographyGeneration) return;

        term.options.fontFamily = nextTypography.fontFamily;
        term.options.fontSize = nextTypography.fontSize;
        window.cancelAnimationFrame(resizeRaf);
        resizeRaf = window.requestAnimationFrame(() => {
          if (disposed) return;
          fitAndResize(terminalId, term, fit);
        });
      });
    };
    applyTypography(initialTypography);

    initRaf = window.requestAnimationFrame(() => {
      if (disposed) return;

      const size = fitAndResize(terminalId, term, fit) ?? {
        cols: term.cols,
        rows: term.rows,
      };
      void terminalSessionStore
        .createOrAttach({
          sessionId: terminalId,
          conversationId,
          projectSessionId,
          cwd: normalizedCwd,
          size,
        })
        .catch((reason: unknown) => {
          if (disposed) return;
          const message = reason instanceof Error ? reason.message : "Failed to attach terminal.";
          setError(message);
        });
    });

    const themeObserver = new MutationObserver(() => {
      if (disposed) return;
      term.options.theme = readTerminalTheme(container);
      const nextTypography = resolveTerminalTypography(container);
      const currentTypography = {
        fontFamily: term.options.fontFamily ?? "",
        fontSize: term.options.fontSize ?? 0,
      };
      if (!sameTerminalTypography(currentTypography, nextTypography)) {
        applyTypography(nextTypography);
      }
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style", "data-codex-window-type"],
    });
    themeObserver.observe(document.body, {
      attributes: true,
      attributeFilter: ["class", "style"],
    });

    return () => {
      disposed = true;
      window.cancelAnimationFrame(resizeRaf);
      window.cancelAnimationFrame(initRaf);
      observer.disconnect();
      themeObserver.disconnect();
      unsubscribe();
      restoreMouseCoordinates();
      for (const disposable of disposables) {
        disposable.dispose();
      }
      terminalSessionStore.release(terminalId);
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      setIsConnected(false);
    };
  }, [conversationId, hasValidCwd, normalizedCwd, projectSessionId, terminalId, visible]);

  useEffect(() => {
    const snapshot = terminalSessionStore.getSnapshot(terminalId);
    setIsExited(snapshot.exited);
    setExitCode(snapshot.exitCode);
    setError(terminalSessionStore.getError(terminalId));
    setLeaseConflict(terminalSessionStore.getLeaseConflict(terminalId));
  }, [terminalId]);

  return {
    containerRef,
    isConnected,
    isExited,
    exitCode,
    isUnavailable: !isTerminalRuntimeAvailable(),
    error,
    leaseConflict,
    reconnect,
    takeOver,
    kill,
  };
}
