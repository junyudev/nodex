import { useEffect, useEffectEvent, useRef, useSyncExternalStore, type RefObject } from "react";
import { ClipboardAddon } from "@xterm/addon-clipboard";
import { FitAddon } from "@xterm/addon-fit";
import { observeCodexDocumentAppearance } from "./codex-theme-variant";
import { resolveCodexRendererOs } from "./codex-window-runtime";
import { useFileReferenceRouter } from "./file-reference-router";
import { openLink } from "./link-opening";
import { applyTerminalTheme, readTerminalTheme } from "./terminal-appearance";
import { bindTerminalInput, handleKey } from "./terminal-keyboard";
import { installTerminalLinkOpening } from "./terminal-link-opening";
import { TerminalRenderer } from "./terminal-renderer";
import { isTerminalRuntimeAvailable, terminalSessionStore } from "./terminal-session-store";
import {
  ensureTerminalTypographyLoaded,
  resolveTerminalTypography,
  sameTerminalTypography,
  type TerminalTypography,
} from "./terminal-typography";
import { patchXtermWindowZoomMouseCoordinates } from "./terminal-window-zoom";
import { useLinkOpening } from "./web-link-navigation";

export interface UseTerminalOptions {
  terminalId: string;
  hostId?: string;
  cwd: string;
  conversationId?: string | null;
  projectSessionId?: string | null;
  onNewTerminalTab?: () => void;
}

export interface UseTerminalReturn {
  containerRef: RefObject<HTMLDivElement | null>;
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

function subscribeTerminalStatus(listener: () => void): () => void {
  return terminalSessionStore.subscribeAll(listener);
}

export function useTerminal({
  terminalId,
  hostId,
  cwd,
  conversationId,
  projectSessionId,
  onNewTerminalTab,
}: UseTerminalOptions): UseTerminalReturn {
  const links = useLinkOpening();
  const files = useFileReferenceRouter();
  const readLinkOwner = useEffectEvent(() => ({
    openLink: links?.openLink ?? openLink,
    hostId: hostId ?? files.hostId,
  }));
  const readNewTerminalAction = useEffectEvent(() => onNewTerminalTab);
  const normalizedCwd = cwd.trim();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const view = useRef<{ reconnect: () => void; takeOver: () => void } | null>(null);
  const error = useSyncExternalStore(
    subscribeTerminalStatus,
    () => terminalSessionStore.getError(terminalId),
    () => null,
  );
  const leaseConflict = useSyncExternalStore(
    subscribeTerminalStatus,
    () => terminalSessionStore.getLeaseConflict(terminalId),
    () => null,
  );

  useEffect(() => {
    const host = containerRef.current;
    if (!normalizedCwd || !host || !isTerminalRuntimeAvailable()) return;
    const platform = resolveCodexRendererOs();
    const initialTypography = resolveTerminalTypography(host);
    const renderer = terminalSessionStore.getOrCreateRenderer(
      terminalId,
      () =>
        new TerminalRenderer(
          { ...initialTypography, theme: readTerminalTheme(host) },
          terminalSessionStore.getPreservedAlternateScreenMode(terminalId) ?? undefined,
        ),
    );
    const term = renderer.terminal;
    let disposed = false;
    let attached = false;
    let scrollFrame: number | null = null;
    let typographyGeneration = 0;

    const scheduleBottom = () => {
      if (disposed || scrollFrame !== null) return;
      scrollFrame = requestAnimationFrame(() => {
        scrollFrame = null;
        term.scrollToBottom();
      });
    };
    const fit = new FitAddon();
    term.loadAddon(new ClipboardAddon());
    term.loadAddon(fit);
    installTerminalLinkOpening(term, () => readLinkOwner());
    let markUser = () => false;
    term.attachCustomKeyEventHandler((event) =>
      handleKey({
        event,
        term,
        platform,
        clipboard: platform === "darwin" ? undefined : navigator.clipboard,
        onNewTerminalTab: readNewTerminalAction(),
        onPaste: () => markUser(),
        clearSession: () => terminalSessionStore.clearSession(terminalId),
        sendText: (data) => terminalSessionStore.write(terminalId, data, "user"),
      }),
    );
    term.open(host);
    const undoZoom = patchXtermWindowZoomMouseCoordinates(term);

    const size = () => ({ cols: term.cols, rows: term.rows });
    const scheduleFit = (repaint = false) => {
      if (disposed || !host.isConnected) return;
      requestAnimationFrame(() => {
        if (disposed || !host.isConnected) return;
        fit.fit();
        if (attached) terminalSessionStore.resize(terminalId, size(), repaint);
      });
    };
    scheduleFit();
    const isAlternate = () =>
      renderer.isRestoringAlternateScreen || term.buffer.active.type === "alternate";
    renderer.onOutput = () => {
      const buffer = term.buffer.active;
      if (buffer.viewportY >= buffer.baseY) scheduleBottom();
    };
    // Reopening replays the local tail and then the PTY's, so this outlives any single replay.
    renderer.onReplay = scheduleBottom;

    const unregister = terminalSessionStore.register(terminalId, {
      onAttach: () => {
        if (disposed) return;
        attached = true;
        // A full-screen program missed output while detached and must redraw to be trustworthy.
        scheduleFit(
          isAlternate() ||
            terminalSessionStore.getPreservedAlternateScreenMode(terminalId) !== null,
        );
      },
      onDetach: () => {
        attached = false;
      },
    });
    const terminalInput = bindTerminalInput(
      term,
      host,
      () => renderer.isReplayingInitLog,
      (data, source) => terminalSessionStore.write(terminalId, data, source),
      () => terminalSessionStore.recordUserInteraction(terminalId),
    );
    markUser = terminalInput.markUser;

    const createOrAttach = () => {
      void terminalSessionStore.createOrAttach({
        sessionId: terminalId,
        conversationId,
        projectSessionId,
        cwd: normalizedCwd,
        size: size(),
      });
    };
    const attachFrame = requestAnimationFrame(() => {
      if (!disposed && host.isConnected) createOrAttach();
    });
    const observer = new ResizeObserver(() => scheduleFit());
    observer.observe(host);

    view.current = {
      reconnect: () => {
        terminalSessionStore.clearSession(terminalId);
        fit.fit();
        createOrAttach();
      },
      takeOver: () => {
        const conflict = terminalSessionStore.getLeaseConflict(terminalId);
        if (!conflict) return;
        fit.fit();
        void terminalSessionStore.takeOver({
          sessionId: terminalId,
          expectedGeneration: conflict.generation,
          size: size(),
        });
      },
    };

    let currentTypography = initialTypography;
    const applyTypography = (next: TerminalTypography) => {
      currentTypography = next;
      typographyGeneration += 1;
      const generation = typographyGeneration;
      void ensureTerminalTypographyLoaded(next).then(() => {
        if (disposed || generation !== typographyGeneration) return;
        term.options.fontFamily = next.fontFamily;
        term.options.fontSize = next.fontSize;
        scheduleFit();
      });
    };
    applyTypography(initialTypography);
    const stopAppearanceObserver = observeCodexDocumentAppearance(
      host.ownerDocument,
      () => {
        if (disposed) return;
        applyTerminalTheme(term, host);
        const next = resolveTerminalTypography(host);
        if (!sameTerminalTypography(currentTypography, next)) applyTypography(next);
      },
      { observeBody: true },
    );

    return () => {
      disposed = true;
      if (scrollFrame !== null) cancelAnimationFrame(scrollFrame);
      cancelAnimationFrame(attachFrame);
      observer.disconnect();
      stopAppearanceObserver();
      terminalInput.dispose();
      terminalSessionStore.preserveAlternateScreen(terminalId, isAlternate());
      unregister();
      undoZoom();
      renderer.onOutput = null;
      renderer.onReplay = null;
      terminalSessionStore.releaseRenderer(terminalId, renderer);
      terminalSessionStore.release(terminalId);
      view.current = null;
    };
  }, [conversationId, normalizedCwd, projectSessionId, terminalId]);

  return {
    containerRef,
    isUnavailable: !isTerminalRuntimeAvailable(),
    error,
    leaseConflict,
    reconnect: () => view.current?.reconnect(),
    takeOver: () => view.current?.takeOver(),
    kill: () => terminalSessionStore.kill(terminalId),
  };
}
