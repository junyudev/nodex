import { inboxScopeKey, type InboxScope } from "../../shared/inbox";
import type { PanelId } from "../../shared/types";
import { sameWorkbenchLocation, type WorkbenchLocation } from "../../shared/workbench-layout";
import { makeWorkbenchSceneKey, type WorkbenchSceneOwner } from "../../shared/workbench-scene";
import { composerDraftIntents, type ComposerChatKey } from "./composer-draft-intents";

export type WorkbenchFocusPolicy = "composer" | "restore" | "none";
export type WorkbenchFocusTarget =
  | { readonly kind: "session"; readonly sessionId: string }
  | { readonly kind: "inbox"; readonly scopeKey: string }
  | { readonly kind: "inbox-entry"; readonly scopeKey: string; readonly pageId: string }
  | {
      readonly kind: "panel";
      readonly ownerKey: string;
      readonly row: string;
      readonly tabId: string;
    }
  | {
      readonly kind: "side-chat";
      readonly sessionId: string;
      readonly tabId: string;
      readonly chat: ComposerChatKey;
    }
  | { readonly kind: "dock"; readonly projectId: string; readonly chat: ComposerChatKey };

const COMPOSER = "[data-codex-composer='true']";
const INBOX = "[data-workbench-inbox-focus]";
const SCENE = "[data-workbench-scene-owner]";
const OVERLAY =
  "[role='dialog'], [role='alertdialog'], [role='menu'], [data-workbench-focus-overlay]";
const PRIMARY = "[data-workbench-primary-hidden]";
const DOCKED_COMPOSER = "[data-thread-find-composer]";
const panelTabSelector = "[data-panel-tab-id][data-panel-tab-owner]";
const tabPanelSelector = "[role='tabpanel'][data-panel-tab-owner]";

export const inboxFocusTarget = (scope: InboxScope): WorkbenchFocusTarget => ({
  kind: "inbox",
  scopeKey: inboxScopeKey(scope),
});

export const inboxEntryFocusTarget = (scope: InboxScope, pageId: string): WorkbenchFocusTarget => ({
  kind: "inbox-entry",
  scopeKey: inboxScopeKey(scope),
  pageId,
});

export function resolveWorkbenchLanding(
  policy: WorkbenchFocusPolicy,
  location: WorkbenchLocation,
  inboxHomeActive: boolean,
  restored: WorkbenchFocusTarget | null = null,
): WorkbenchFocusTarget | null {
  if (policy === "restore") {
    if (
      restored?.kind === "session" &&
      (location.kind !== "session" || location.sessionId !== restored.sessionId)
    )
      return null;
    if (restored?.kind === "inbox") {
      const scope =
        location.kind === "project"
          ? inboxScopeKey(location)
          : location.kind === "inbox"
            ? "all"
            : null;
      if (scope !== restored.scopeKey) return null;
    }
    return restored;
  }
  if (policy === "none") return null;
  if (location.kind === "session") return { kind: "session", sessionId: location.sessionId };
  if (!inboxHomeActive) return null;
  if (location.kind === "inbox") return inboxFocusTarget({ kind: "all" });
  if (location.kind === "project")
    return inboxFocusTarget({ kind: "project", projectId: location.projectId });
  return null;
}

export function decideWorkbenchFocus(input: {
  readonly moved: boolean;
  readonly insideDestination: boolean;
  readonly overlayOpen: boolean;
  readonly ready: boolean;
}): "cancel" | "wait" | "land" {
  if (input.moved || input.insideDestination) return "cancel";
  if (input.overlayOpen || !input.ready) return "wait";
  return "land";
}

export function workbenchFocusMoved(input: {
  readonly focusChanges: number;
  readonly interacted: boolean;
  readonly returnedFromOverlay: boolean;
}): boolean {
  if (input.interacted) return true;
  if (input.focusChanges === 0) return false;
  return input.focusChanges !== 1 || !input.returnedFromOverlay;
}

export function canReceiveWorkbenchFocus(element: HTMLElement | null): element is HTMLElement {
  return Boolean(
    element?.isConnected &&
    element.getClientRects().length > 0 &&
    getComputedStyle(element).visibility === "visible" &&
    !element.closest(
      '[inert], [hidden], [aria-hidden="true"], [data-floating-composer-minimized="true"]',
    ),
  );
}

export function readWorkbenchFocusedElement(doc: Document = document): HTMLElement | null {
  const active = doc.activeElement;
  return active instanceof HTMLElement && active !== doc.body && active !== doc.documentElement
    ? active
    : null;
}

interface FocusObservation {
  revision: number;
  pointerOrigin: HTMLElement | null;
  pointerTarget: EventTarget | null;
  interaction: number;
  overlayOrigins: WeakMap<Element, HTMLElement>;
}
const focusObservations = new WeakMap<Document, FocusObservation>();
function observeFocus(doc: Document) {
  const observed = focusObservations.get(doc);
  if (observed) return observed;
  const state: FocusObservation = {
    revision: 0,
    pointerOrigin: null,
    pointerTarget: null,
    interaction: 0,
    overlayOrigins: new WeakMap(),
  };
  doc.addEventListener(
    "pointerdown",
    (event) => {
      state.interaction += 1;
      state.pointerOrigin = readWorkbenchFocusedElement(doc);
      state.pointerTarget = event.target;
    },
    true,
  );
  doc.addEventListener(
    "keydown",
    () => {
      state.interaction += 1;
      state.pointerOrigin = null;
      state.pointerTarget = null;
    },
    true,
  );
  doc.addEventListener(
    "focusin",
    (event) => {
      const target = event.target;
      if (
        !(target instanceof HTMLElement) ||
        target === doc.body ||
        target.matches("[data-floating-ui-focus-guard], [data-base-ui-focus-guard]")
      )
        return;
      state.revision += 1;
      const overlay = target.closest(OVERLAY);
      const previous = event.relatedTarget;
      if (
        overlay &&
        previous instanceof HTMLElement &&
        previous !== doc.body &&
        !overlay.contains(previous)
      )
        state.overlayOrigins.set(overlay, previous);
    },
    true,
  );
  focusObservations.set(doc, state);
  return state;
}

/** Mouse activation can focus the navigation button before its handler records history. */
export function readWorkbenchHistoryFocus(
  location: WorkbenchLocation,
): WorkbenchFocusTarget | null {
  const active = readWorkbenchFocusedElement();
  const direct = describeWorkbenchFocus(active, location);
  if (direct) return direct;
  const { pointerOrigin, pointerTarget } = observeFocus(document);
  if (!(pointerTarget instanceof Node) || !active?.contains(pointerTarget)) return null;
  return describeWorkbenchFocus(pointerOrigin, location);
}

export function returnWorkbenchFocus(
  target: HTMLElement | null,
  attempt = beginWorkbenchFocus(),
  fallback?: () => void,
) {
  requestAnimationFrame(() => {
    if (attempt.moved()) return;
    if (canReceiveWorkbenchFocus(target)) target.focus({ preventScroll: true });
    if (!target || target.ownerDocument.activeElement !== target) fallback?.();
  });
}

export const panelTabFocusTarget = (
  ownerKey: string,
  panelId: PanelId,
  leafId: string,
  tabId: string,
): WorkbenchFocusTarget => ({ kind: "panel", ownerKey, row: `${panelId}:${leafId}`, tabId });

export interface WorkbenchFocusAttempt {
  readonly origin: HTMLElement | null;
  readonly moved: () => boolean;
}

/** Capture before asynchronous navigation, while its initiating control still owns focus. */
export function beginWorkbenchFocus(doc: Document = document): WorkbenchFocusAttempt {
  const state = observeFocus(doc);
  const revision = state.revision;
  const origin = readWorkbenchFocusedElement(doc);
  const overlay = origin?.closest(OVERLAY);
  const returnTarget = overlay && state.overlayOrigins.get(overlay);
  const interaction = state.interaction;
  return {
    origin,
    // An overlay releasing its own trigger is part of the initiating action.
    moved: () =>
      workbenchFocusMoved({
        focusChanges: state.revision - revision,
        interacted: state.interaction !== interaction,
        returnedFromOverlay: Boolean(
          returnTarget && readWorkbenchFocusedElement(doc) === returnTarget,
        ),
      }),
  };
}

const attr = (name: string, value: string) => `[${name}="${CSS.escape(value)}"]`;
const sceneSelector = (owner: WorkbenchSceneOwner) =>
  attr("data-workbench-scene-owner", makeWorkbenchSceneKey(owner));
const findVisible = (root: ParentNode, selector: string) =>
  Array.from(root.querySelectorAll<HTMLElement>(selector)).find(canReceiveWorkbenchFocus) ?? null;

function findWorkbenchFocusAnchor(active: HTMLElement): HTMLElement {
  if (!active.matches("webview[data-browser-sidebar-webview-host-root]")) return active;
  const context = ["data-browser-sidebar-conversation-id", "data-browser-sidebar-browser-tab-id"]
    .map((name) => attr(name, active.getAttribute(name) ?? ""))
    .join("");
  return (
    findVisible(
      active.ownerDocument,
      `[data-app-shell-focus-area] [data-browser-sidebar-webview-host-root]${context}`,
    ) ?? active
  );
}

export function workbenchPanelContainsFocus(panelId: PanelId, active: HTMLElement | null): boolean {
  return Boolean(
    active &&
    findWorkbenchFocusAnchor(active).closest(
      `[data-app-shell-focus-area="${panelId}-panel"], [data-panel-tab-row^="${panelId}:"]`,
    ),
  );
}

function describeWorkbenchFocus(
  active: HTMLElement | null,
  location: WorkbenchLocation,
): WorkbenchFocusTarget | null {
  if (!active) return null;
  const focusAnchor = findWorkbenchFocusAnchor(active);
  const inbox = focusAnchor.closest<HTMLElement>(INBOX);
  const scopeKey = inbox?.getAttribute("data-workbench-inbox-focus");
  if (scopeKey && active.closest("[data-inbox-composer]")) return { kind: "inbox", scopeKey };

  const tabPanel = focusAnchor.closest(tabPanelSelector);
  const leaf = focusAnchor.closest("[data-panel-group-leaf-id]");
  const currentTab =
    focusAnchor.closest(panelTabSelector) ??
    (tabPanel?.id
      ? active.ownerDocument
          .querySelector(`[role='tab']${attr("aria-controls", tabPanel.id)}`)
          ?.closest(panelTabSelector)
      : null) ??
    leaf?.querySelector("[role='tab'][aria-selected='true']")?.closest(panelTabSelector);
  const row = currentTab?.closest("[data-panel-tab-row]")?.getAttribute("data-panel-tab-row");
  const tabId = currentTab?.getAttribute("data-panel-tab-id");
  const tabOwner = currentTab?.getAttribute("data-panel-tab-owner");
  if (row && tabId && tabOwner) return { kind: "panel", ownerKey: tabOwner, row, tabId };

  const scene = focusAnchor.closest(`${SCENE}, [data-workbench-focus-scene]`);
  const ownerKey =
    scene?.getAttribute("data-workbench-scene-owner") ??
    scene?.getAttribute("data-workbench-focus-scene");
  if (
    location.kind === "session" &&
    active.closest(`${COMPOSER}, [data-workbench-pending-request]`) &&
    ownerKey === makeWorkbenchSceneKey({ kind: "session", sessionId: location.sessionId })
  )
    return { kind: "session", sessionId: location.sessionId };
  return null;
}

function readFocusDestination(doc: Document, target: WorkbenchFocusTarget) {
  if (target.kind === "panel") {
    if (!doc.querySelector(attr("data-workbench-scene-owner", target.ownerKey)))
      return { surface: null, focus: null };
    const row = attr("data-panel-tab-row", target.row);
    const owner = attr("data-panel-tab-owner", target.ownerKey);
    const tabId = attr("data-panel-tab-id", target.tabId);
    const tab = findVisible(doc, `${row} ${owner}${tabId} [role='tab']`);
    return { surface: tab, focus: tab };
  }
  if (target.kind === "inbox" || target.kind === "inbox-entry") {
    const surface = findVisible(
      doc,
      `${INBOX}${attr("data-workbench-inbox-focus", target.scopeKey)}`,
    );
    if (target.kind === "inbox-entry") {
      const entry = surface && findVisible(surface, attr("data-inbox-page-id", target.pageId));
      return { surface: entry, focus: entry };
    }
    return {
      surface: surface?.querySelector("[data-inbox-composer]") ?? null,
      focus: surface && findVisible(surface, "[data-inbox-composer] textarea"),
    };
  }
  const owner: WorkbenchSceneOwner =
    target.kind === "dock"
      ? { kind: "project", projectId: target.projectId }
      : { kind: "session", sessionId: target.sessionId };
  const root = doc.querySelector(sceneSelector(owner));
  if (!root) return { surface: null, focus: null };
  const floating = doc.querySelector(
    attr("data-workbench-focus-scene", makeWorkbenchSceneKey(owner)),
  );
  const surface =
    target.kind === "side-chat"
      ? findVisible(root, `${tabPanelSelector}${attr("data-tab-id", target.tabId)}`)
      : (floating ?? (target.kind === "session" ? root.querySelector(PRIMARY) : null));
  if (!surface) return { surface: null, focus: null };
  const primaryComposer = (selector: string) => findVisible(surface, selector);
  const focus = primaryComposer(COMPOSER);
  if (focus)
    return {
      surface,
      focus,
      chat:
        target.kind === "session"
          ? { kind: "session" as const, sessionId: target.sessionId }
          : target.chat,
    };
  const requestCard = primaryComposer("[data-workbench-pending-request]");
  const pending =
    requestCard &&
    (findVisible(
      requestCard,
      '[role="radio"][tabindex="0"], [data-request-option-label]:not([disabled]), input:not([disabled]), textarea:not([disabled])',
    ) ??
      findVisible(requestCard, 'button[type="submit"]:not([disabled])') ??
      Array.from(requestCard.querySelectorAll<HTMLElement>("button:not([disabled])")).findLast(
        canReceiveWorkbenchFocus,
      ) ??
      null);
  return { surface: requestCard?.closest(DOCKED_COMPOSER) ?? surface, focus: pending };
}

let lastFocusNonce = 0;
function requestChatFocus(chat: ComposerChatKey): number | null {
  // A concurrent draft handoff already has an addressed focus request. Keep its payload intact.
  if (composerDraftIntents.read(chat)) return null;
  const focusNonce = Math.max(Date.now(), lastFocusNonce + 1);
  lastFocusNonce = focusNonce;
  composerDraftIntents.set(chat, { prompt: "", attachmentMode: "append", focusNonce });
  return focusNonce;
}

/** One outstanding landing per window. Scene changes and intervening focus invalidate it. */
export function createWorkbenchFocusLanding(readLocation: () => WorkbenchLocation) {
  let cancelPending: (() => void) | undefined;
  const request = (
    target: WorkbenchFocusTarget | null,
    attempt?: WorkbenchFocusAttempt,
    options: { readonly waitForWindow?: boolean } = {},
  ) => {
    cancelPending?.();
    if (!target || typeof document === "undefined") return;
    const doc = document;
    const ticket = attempt ?? beginWorkbenchFocus(doc);
    const location = readLocation();
    let frame: number | undefined;
    let sent: { readonly chat: ComposerChatKey; readonly nonce: number } | undefined;
    const schedule = () => {
      frame ??= requestAnimationFrame(tryFocus);
    };
    const observer = new MutationObserver(schedule);
    const cancel = () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      observer.disconnect();
      doc.removeEventListener("focusin", schedule, true);
      window.removeEventListener("focus", schedule);
      if (sent) composerDraftIntents.consume(sent.chat, sent.nonce);
      if (cancelPending === cancel) cancelPending = undefined;
    };
    const tryFocus = () => {
      frame = undefined;
      // A re-render can rebuild the same location; only a different place ends the landing.
      if (!sameWorkbenchLocation(readLocation(), location)) {
        cancel();
        return;
      }
      const active = readWorkbenchFocusedElement(doc);
      const { surface, focus, chat } = readFocusDestination(doc, target);
      const decision = decideWorkbenchFocus({
        moved: ticket.moved(),
        // Rendering can reuse the focused element for the destination. Focus the person has not
        // moved since navigating is still the origin, not a choice made inside the destination.
        insideDestination: Boolean(active && active !== ticket.origin && surface?.contains(active)),
        overlayOpen: Boolean(active?.closest(OVERLAY)),
        ready: focus !== null && (!options.waitForWindow || doc.hasFocus()),
      });
      if (decision === "cancel") {
        cancel();
        return;
      }
      if (decision !== "land" || !focus) return;
      if (chat && !sent) {
        const nonce = requestChatFocus(chat);
        if (nonce !== null) sent = { chat, nonce };
      }
      if (!chat) {
        if (target.kind === "inbox-entry") focus.tabIndex = -1;
        focus.focus({ preventScroll: true });
      }
      if (doc.activeElement === focus) cancel();
    };
    cancelPending = cancel;
    observer.observe(doc.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: [
        "aria-hidden",
        "class",
        "data-codex-composer",
        "data-state",
        "data-workbench-focus-scene",
        "data-workbench-inbox-focus",
        "hidden",
        "inert",
        "style",
      ],
    });
    doc.addEventListener("focusin", schedule, true);
    window.addEventListener("focus", schedule);
    schedule();
  };
  return { request, cancel: () => cancelPending?.() };
}
