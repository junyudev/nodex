import { classifyKeyboardActionPath } from "./keyboard-action-runtime";
import type { PanelId } from "./types";

const TERMINAL_SURFACE_SELECTOR = "[data-codex-terminal]";
const COMPOSER_INPUT_SELECTOR = "[data-codex-composer='true']";
/**
 * How long a request waits for its Terminal to mount: a window's first Terminal takes about 400ms
 * and later ones under 100ms. Past this the user has moved on, and the cursor must not jump.
 */
const TERMINAL_FOCUS_REQUEST_MS = 1_000;

interface TerminalSurfaceLike {
  readonly kind: string;
  readonly config: object;
}

const mountedTerminals = new Map<string, () => void>();
let pendingRequest: { readonly terminalId: string; readonly end: () => void } | null = null;
let focusBeforeTerminal: HTMLElement | null = null;

function readTerminalId(surface: TerminalSurfaceLike | null | undefined): string | null {
  if (surface?.kind !== "terminal" || !("terminalSessionId" in surface.config)) return null;
  const { terminalSessionId } = surface.config;
  return typeof terminalSessionId === "string" ? terminalSessionId : null;
}

function focusTerminal(focus: () => void, ownerDocument: Document): void {
  if (ownerDocument.activeElement?.closest("[role='dialog']")) return;
  focus();
}

/**
 * Moves the cursor into a Session tab's or Scene surface's Terminal, now if it is mounted and
 * otherwise when it mounts; any other surface is ignored. Call this only once a user's request to
 * use that Terminal has been carried out: restoring a layout, switching Scenes or an Agent
 * revealing a Terminal leaves the cursor where it is.
 */
export function requestTerminalFocus(
  surface: TerminalSurfaceLike | null | undefined,
  ownerDocument: Document = document,
): void {
  const terminalId = readTerminalId(surface);
  if (!terminalId) return;
  pendingRequest?.end();
  const focus = mountedTerminals.get(terminalId);
  if (focus) {
    focusTerminal(focus, ownerDocument);
    return;
  }
  const end = () => {
    pendingRequest = null;
    clearTimeout(expiry);
    ownerDocument.removeEventListener("pointerdown", end, true);
  };
  const expiry = setTimeout(end, TERMINAL_FOCUS_REQUEST_MS);
  ownerDocument.addEventListener("pointerdown", end, true);
  pendingRequest = { terminalId, end };
}

/** Called by a Terminal's view once its input exists; answers a request waiting for it. */
export function registerTerminalFocusTarget(
  terminalId: string,
  focus: () => void,
  ownerDocument: Document = document,
): () => void {
  mountedTerminals.set(terminalId, focus);
  if (pendingRequest?.terminalId === terminalId) {
    pendingRequest.end();
    focusTerminal(focus, ownerDocument);
  }
  return () => {
    if (mountedTerminals.get(terminalId) === focus) mountedTerminals.delete(terminalId);
  };
}

export function terminalHoldsFocus(
  terminalSessionId: string,
  ownerDocument: Document = document,
): boolean {
  const surface = ownerDocument.getElementById(`terminal-panel-${terminalSessionId}`);
  return surface?.contains(ownerDocument.activeElement) === true;
}

/** Records what the cursor left to enter a Terminal, so hiding the Terminal can return to it. */
export function rememberFocusBeforeTerminal(previous: EventTarget | null): void {
  if (!(previous instanceof HTMLElement) || previous.closest(TERMINAL_SURFACE_SELECTOR)) return;
  if (classifyKeyboardActionPath([previous]) === "editable") focusBeforeTerminal = previous;
}

/**
 * Returns the cursor to where the user was working when a panel hides, falling back to the Scene's
 * composer. A cursor already outside the panel stays put, as there is nothing to hand back.
 */
export function returnFocusFromPanel(panelId: PanelId, ownerDocument: Document = document): void {
  pendingRequest?.end();
  const panelSelector = `[data-app-shell-focus-area="${panelId}-panel"]`;
  const active = ownerDocument.activeElement;
  if (active && active !== ownerDocument.body && !active.closest(panelSelector)) return;

  const canTakeFocus = (element: HTMLElement) =>
    element.isConnected &&
    element.getClientRects().length > 0 &&
    !element.closest(`${panelSelector}, [inert], [aria-hidden="true"]`);
  const previous = focusBeforeTerminal;
  focusBeforeTerminal = null;
  requestAnimationFrame(() => {
    const target =
      previous && canTakeFocus(previous)
        ? previous
        : Array.from(ownerDocument.querySelectorAll<HTMLElement>(COMPOSER_INPUT_SELECTOR)).find(
            canTakeFocus,
          );
    target?.focus({ preventScroll: true });
  });
}
