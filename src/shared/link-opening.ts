import {
  isExternallyOpenableUrl,
  isHttpUrl,
  isLocalUrl,
  resolveLinkOpenTarget,
  type LinkOpenTarget,
} from "./browser-url-policy";
import {
  DEFAULT_LINK_OPENING_SETTINGS,
  type ExternalBrowserLinkShortcut,
  type LinkOpeningSettings,
} from "./link-opening-settings";

export type LinkDisposition = "default" | "new-tab" | "new-background-tab";
export type LinkPresentationIntent = "split" | "full-width" | "new-window";
export interface LinkActivation {
  readonly button?: number;
  readonly metaKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly shiftKey?: boolean;
  readonly altKey?: boolean;
  readonly platform: string;
}
export interface LinkOpenRequest {
  readonly url: string;
  readonly hostId?: string;
  readonly initiator: string;
  readonly source?: string;
  readonly openTarget?: LinkOpenTarget;
  readonly useExternalBrowser?: boolean;
  readonly disposition?: LinkDisposition;
  readonly presentationIntent?: LinkPresentationIntent;
  readonly activation?: LinkActivation;
  /** Caller has checked markdown focus, panel ownership and Browser capability. */
  readonly markdownContext?: boolean;
}
export interface LinkOpenIntent {
  readonly disposition: LinkDisposition;
  readonly externalShortcutMatched: boolean;
  readonly download: boolean;
  readonly presentationIntent?: "split" | "full-width";
  readonly openTarget?: LinkOpenTarget;
}

function externalShortcutModifier(
  activation: LinkActivation | undefined,
  primary: boolean,
): Exclude<ExternalBrowserLinkShortcut, "unassigned"> | undefined {
  if (!activation || (activation.button != null && activation.button !== 0)) return undefined;
  const otherPrimaryKey =
    activation.platform === "darwin" ? activation.ctrlKey : activation.metaKey;
  if (otherPrimaryKey || (activation.ctrlKey && activation.metaKey)) return undefined;
  if (primary) {
    if (activation.altKey) return undefined;
    return activation.shiftKey ? "primary-shift" : "primary";
  }
  return activation.altKey && !activation.shiftKey ? "alt" : undefined;
}

/** Converts pointer or keyboard activation to destination-independent link intent. */
export function deriveLinkOpenIntent(input: {
  readonly url: string;
  readonly activation?: LinkActivation;
  readonly externalBrowserLinkShortcut?: ExternalBrowserLinkShortcut;
  readonly openTarget?: LinkOpenTarget;
  readonly useExternalBrowser?: boolean;
  readonly markdownContext?: boolean;
}): LinkOpenIntent {
  const a = input.activation;
  const primaryButton = a?.button == null || a.button === 0;
  const primary = a?.platform === "darwin" ? a.metaKey === true : a?.ctrlKey === true;
  const bothPrimaryKeys = a?.ctrlKey === true && a.metaKey === true;
  const http = isHttpUrl(input.url);
  const markdown =
    input.markdownContext === true &&
    primaryButton &&
    !a?.shiftKey &&
    input.openTarget !== "external-browser" &&
    input.useExternalBrowser !== true &&
    (http || isLocalUrl(input.url));
  const fullWidth = markdown && primary && a?.altKey === true && !bothPrimaryKeys;
  const modifier = externalShortcutModifier(a, primary);
  const externalShortcutMatched =
    !fullWidth &&
    input.openTarget == null &&
    input.useExternalBrowser !== true &&
    http &&
    modifier !== undefined &&
    modifier === (input.externalBrowserLinkShortcut ?? "primary");
  const disposition =
    !fullWidth && (primary || a?.button === 1)
      ? a?.shiftKey
        ? "new-tab"
        : "new-background-tab"
      : "default";
  return {
    disposition,
    externalShortcutMatched,
    download:
      http &&
      primaryButton &&
      a?.altKey === true &&
      !a.ctrlKey &&
      !a.metaKey &&
      !a.shiftKey &&
      !externalShortcutMatched &&
      input.openTarget == null &&
      input.useExternalBrowser !== true,
    ...(fullWidth
      ? { openTarget: "in-app-browser", presentationIntent: "full-width" }
      : markdown && !a?.ctrlKey && !a?.metaKey
        ? { presentationIntent: "split" }
        : {}),
  };
}

export interface ResolvedLinkOpenRequest extends LinkOpenRequest {
  readonly target: LinkOpenTarget;
  readonly disposition: LinkDisposition;
  readonly download: boolean;
}

/** Shared routing precedence for renderer activations and trusted Desktop window fallback. */
export function resolveLinkOpenRequest(input: {
  readonly request: LinkOpenRequest;
  readonly browserAvailable: boolean;
  readonly preferences?: LinkOpeningSettings;
}): ResolvedLinkOpenRequest | null {
  const { request, browserAvailable } = input;
  const preferences = input.preferences ?? DEFAULT_LINK_OPENING_SETTINGS;
  const intent = deriveLinkOpenIntent({
    ...request,
    markdownContext: browserAvailable && request.markdownContext,
    externalBrowserLinkShortcut: preferences.externalBrowserLinkShortcut,
  });
  const disposition = request.disposition ?? intent.disposition;
  const openTarget =
    request.openTarget ??
    intent.openTarget ??
    (intent.externalShortcutMatched ? "external-browser" : undefined) ??
    (disposition === "new-tab" || disposition === "new-background-tab"
      ? "in-app-browser"
      : undefined);
  const target = resolveLinkOpenTarget({
    ...preferences,
    ...request,
    browserAvailable,
    openTarget,
  });
  if (target === "external-browser" && !isExternallyOpenableUrl(request.url)) return null;
  return {
    ...request,
    target,
    disposition,
    presentationIntent: request.presentationIntent ?? intent.presentationIntent,
    download: intent.download,
  };
}
