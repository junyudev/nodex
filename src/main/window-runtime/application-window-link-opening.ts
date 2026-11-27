import type { WebContents } from "electron";
import { isExternallyOpenableUrl, isHttpUrl } from "../../shared/browser-url-policy";
import { resolveLinkOpenRequest, type LinkOpenRequest } from "../../shared/link-opening";
import type {
  EffectiveLinkOpeningSettings,
  LinkOpeningSettings,
} from "../../shared/link-opening-settings";
import {
  getWorkbenchSceneReturnLocation,
  type WorkbenchLocation,
} from "../../shared/workbench-layout";

/** Forward the original intent so the Workbench can route it in its live Scene. */
export function resolveApplicationWindowLinkDestination(
  request: LinkOpenRequest,
  preferences: LinkOpeningSettings | EffectiveLinkOpeningSettings,
  location: WorkbenchLocation,
):
  | { readonly kind: "workbench"; readonly request: LinkOpenRequest }
  | { readonly kind: "external"; readonly url: string }
  | null {
  const { kind } = getWorkbenchSceneReturnLocation(location);
  const browserAvailable = kind === "project" || kind === "session";
  const resolved = resolveLinkOpenRequest({
    request,
    preferences,
    browserAvailable,
    githubAvailable: browserAvailable || kind === "library" || kind === "inbox",
  });
  if (!resolved) return null;
  return resolved.target === "external-browser"
    ? { kind: "external", url: resolved.url }
    : { kind: "workbench", request };
}

/** Trusted app-shell links use preferences; other permitted schemes belong to the OS. */
export function applicationWindowLinkRequest(
  url: string,
  disposition?: string,
): LinkOpenRequest | null {
  if (!isExternallyOpenableUrl(url)) return null;
  return {
    url,
    initiator: "window_open",
    ...(isHttpUrl(url)
      ? { disposition: disposition === "background-tab" ? "new-background-tab" : "default" }
      : { openTarget: "external-browser" }),
  };
}

/** Native app-shell popups are always denied; Browser tabs belong to the Workbench. */
export function installApplicationWindowLinkRouting(input: {
  readonly webContents: Pick<WebContents, "setWindowOpenHandler" | "on">;
  readonly isAppUrl: (url: string) => boolean;
  readonly openLink: (request: LinkOpenRequest) => void;
}): void {
  input.webContents.setWindowOpenHandler(({ url, disposition }) => {
    const request = applicationWindowLinkRequest(url, disposition);
    if (request) input.openLink(request);
    return { action: "deny" };
  });
  input.webContents.on("will-navigate", (event, url) => {
    if (input.isAppUrl(url)) return;
    event.preventDefault();
    const request = applicationWindowLinkRequest(url);
    if (request) input.openLink(request);
  });
}
