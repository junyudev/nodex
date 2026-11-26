import type { PanelId } from "@/lib/types";

const PANEL_FOCUS_AREA_SELECTOR =
  '[data-app-shell-focus-area="right-panel"], [data-app-shell-focus-area="bottom-panel"]';
const PANEL_GROUP_LEAF_SELECTOR = "[data-panel-group-leaf-id]";

interface ShortcutTargetLike {
  tagName?: string;
  isContentEditable?: boolean;
  closest?: (selector: string) => Element | null;
}

export interface PanelTabCycleScope {
  panelId: PanelId;
  leafId: string;
}

export function isCodexTerminalShortcutTarget(target: EventTarget | null): boolean {
  const element = target as ShortcutTargetLike | null;
  if (!element?.closest) return false;
  return Boolean(element.closest("[data-codex-terminal]"));
}

/** Marks a field, such as a Browser address bar, where tab shortcuts still close and switch tabs. */
const PANEL_TAB_SHORTCUTS_PASS_THROUGH_SELECTOR = "[data-panel-tab-shortcuts-pass-through]";

export function isFocusedPanelTabShortcutTargetBlocked(target: EventTarget | null): boolean {
  const element = target as ShortcutTargetLike | null;
  if (!element) return false;
  if (element.closest?.(PANEL_TAB_SHORTCUTS_PASS_THROUGH_SELECTOR)) return false;
  if (element.tagName === "INPUT" || element.tagName === "TEXTAREA") {
    return true;
  }
  if (!element.closest) return Boolean(element.isContentEditable);
  if (element.closest("[role='dialog']")) return true;
  if (element.closest(".nfm-editor")) return false;
  return Boolean(element.isContentEditable || element.closest(".bn-editor, .bn-container"));
}

export function isWorkbenchPanelTabShortcutTargetBlocked(target: EventTarget | null): boolean {
  return isCodexTerminalShortcutTarget(target) || isFocusedPanelTabShortcutTargetBlocked(target);
}

export function resolveFocusedPanelTabCycleScope(
  target: EventTarget | null,
): PanelTabCycleScope | null {
  const element = target as ShortcutTargetLike | null;
  if (!element?.closest) return null;

  const focusArea = element.closest(PANEL_FOCUS_AREA_SELECTOR);
  const focusAreaId = focusArea?.getAttribute("data-app-shell-focus-area");
  const panelId =
    focusAreaId === "right-panel" ? "right" : focusAreaId === "bottom-panel" ? "bottom" : null;
  if (!panelId) return null;

  const leafId =
    element.closest(PANEL_GROUP_LEAF_SELECTOR)?.getAttribute("data-panel-group-leaf-id") ?? null;
  if (!leafId) return null;
  return { panelId, leafId };
}

export function isDocumentLevelShortcutTarget(target: EventTarget | null): boolean {
  if (typeof document === "undefined") return false;
  return target === document || target === document.body || target === document.documentElement;
}

const BROWSER_ADDRESS_SELECTOR = "[data-browser-sidebar-address-input='true']";

/** The focused guest lives outside the panel tree. Its in-panel host carries the same identity. */
function resolveFocusedBrowserLeaf(document: Document, target: Element | null): Element | null {
  const leaf = target?.closest(PANEL_GROUP_LEAF_SELECTOR);
  if (leaf) return leaf;
  const guest = target?.closest(
    '[data-browser-sidebar-webview-manager-root][data-browser-sidebar-webview-host-kind="panel"]',
  );
  const tabId = guest?.getAttribute("data-browser-sidebar-browser-tab-id");
  const conversationId = guest?.getAttribute("data-browser-sidebar-conversation-id");
  if (!tabId || !conversationId) return null;
  return (
    findBrowserTabHost(document, {
      browserTabId: tabId,
      browserConversationId: conversationId,
    })?.closest(PANEL_GROUP_LEAF_SELECTOR) ?? null
  );
}

interface BrowserTabHostIdentity {
  readonly browserConversationId: string;
  readonly browserTabId: string;
}

function findBrowserTabHost(document: Document, identity: BrowserTabHostIdentity): Element | null {
  for (const host of document.querySelectorAll("div[data-browser-sidebar-webview-host-root]")) {
    if (host.getAttribute("data-browser-sidebar-browser-tab-id") !== identity.browserTabId)
      continue;
    if (
      host.getAttribute("data-browser-sidebar-conversation-id") !== identity.browserConversationId
    )
      continue;
    if (host.closest(PANEL_GROUP_LEAF_SELECTOR)) return host;
  }
  return null;
}

/** The panel group showing a Browser page, found through that page's in-panel host. */
export function resolveBrowserTabPanelScope(
  document: Document,
  identity: BrowserTabHostIdentity,
): PanelTabCycleScope | null {
  return resolveFocusedPanelTabCycleScope(findBrowserTabHost(document, identity));
}

/** Prefer the focused Browser group, then the remembered group, then active groups. */
export function focusBrowserAddressBar(
  document: Document,
  rememberedScope: PanelTabCycleScope | null,
): boolean {
  const target = document.activeElement;
  const focusedLeaf = resolveFocusedBrowserLeaf(document, target);
  const addresses = Array.from(
    document.querySelectorAll<HTMLInputElement>(BROWSER_ADDRESS_SELECTOR),
  ).filter(
    (input) =>
      !input.disabled &&
      !input.closest("[hidden], [inert]") &&
      (input.checkVisibility?.({ visibilityProperty: true }) ?? true),
  );
  const address =
    addresses.find((input) => input === target || focusedLeaf?.contains(input)) ??
    addresses.find((input) => {
      const scope = resolveFocusedPanelTabCycleScope(input);
      return (
        scope !== null &&
        scope.panelId === rememberedScope?.panelId &&
        scope.leafId === rememberedScope.leafId
      );
    }) ??
    addresses.find((input) => input.closest('[data-panel-group-leaf-active="true"]')) ??
    (addresses.length === 1 ? addresses[0] : undefined);
  if (!address) return false;
  address.focus();
  address.select();
  return true;
}
