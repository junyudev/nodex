import type { LinkActivation } from "../../shared/link-opening";

/** Capture before awaiting: React and native events must not become routing state. */
export function snapshotLinkActivation(
  event:
    | Pick<MouseEvent, "button" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">
    | Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "shiftKey" | "altKey">,
  platform = typeof navigator === "undefined" ? "" : navigator.platform,
): LinkActivation {
  return {
    button: "button" in event ? event.button : 0,
    metaKey: event.metaKey,
    ctrlKey: event.ctrlKey,
    shiftKey: event.shiftKey,
    altKey: event.altKey,
    platform: /^(mac|darwin)/iu.test(platform) ? "darwin" : platform,
  };
}

/** Split/full-width Markdown intent belongs to the main content, outside panel controllers. */
export function isEligibleMarkdownLinkContext(
  element: Element,
  activation: LinkActivation,
): boolean {
  if (element.closest("[data-app-shell-tab-panel-controller]")) return false;
  const main = element.closest('[data-app-shell-focus-area="main"]');
  if (!main || main.getAttribute("role") === "tabpanel") return true;
  const primary = activation.platform === "darwin" ? activation.metaKey : activation.ctrlKey;
  return activation.altKey === true && primary === true;
}
