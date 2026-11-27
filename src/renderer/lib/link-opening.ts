import {
  implicitGitHubThreadLink,
  resolveLinkOpenRequest,
  type LinkOpenRequest,
  type ResolvedWebLinkOpenRequest,
} from "../../shared/link-opening";
import {
  EffectiveLinkOpeningSettingsSchema,
  LinkOpeningSettingsSchema,
  type EffectiveLinkOpeningSettings,
  type LinkOpeningSettings,
} from "../../shared/link-opening-settings";
import { openExternalUrl } from "./file-system-operations";
import { defineRendererCommand, invokePlainCommand, invokeRendererQuery } from "./renderer-command";

export interface LinkRouter {
  readonly browserAvailable: boolean;
  readonly openLink: (request: LinkOpenRequest) => Promise<boolean>;
}
export interface LinkRouterPort {
  /** Render-time capability projection; execution captures the current owner separately. */
  readonly browserAvailable: boolean;
  readonly browser: () => {
    readonly available: boolean;
    readonly open: (request: ResolvedWebLinkOpenRequest) => Promise<boolean>;
  };
  readonly github?: () =>
    | ((thread: import("../../shared/github-thread").GitHubThreadLink) => Promise<boolean>)
    | null;
  readonly readSettings: (
    includeGitHubHosts: boolean,
  ) => Promise<LinkOpeningSettings | EffectiveLinkOpeningSettings>;
  readonly openExternal: (url: string) => Promise<boolean>;
  readonly saveLink?: (url: string) => Promise<boolean>;
}
const saveLinkCommand = defineRendererCommand({
  key: "web_link.save",
  channel: "browser-link:save",
  authority: "external",
  owner: "BrowserDownloads",
  protocol: { kind: "returned_value" },
});

/** Owns execution; callers supply intent and the Workbench supplies the Browser capability. */
export function createLinkRouter(port: LinkRouterPort): LinkRouter {
  return {
    browserAvailable: port.browserAvailable,
    async openLink(request) {
      const browser = port.browser();
      const github = port.github?.();
      const resolved = resolveLinkOpenRequest({
        request,
        browserAvailable: browser.available,
        githubAvailable: Boolean(github),
        preferences: await port.readSettings(Boolean(github && implicitGitHubThreadLink(request))),
      });
      if (!resolved) return false;
      if (resolved.target === "github-thread") return (await github?.(resolved.thread)) ?? false;
      if (resolved.download && port.saveLink) return await port.saveLink(resolved.url);
      return resolved.target === "in-app-browser"
        ? await browser.open(resolved)
        : await port.openExternal(resolved.url);
    },
  };
}
export const desktopLinkOpeningAdapter = {
  readSettings: async (includeGitHubHosts: boolean) =>
    includeGitHubHosts
      ? EffectiveLinkOpeningSettingsSchema.parse(
          await invokeRendererQuery("settings:link-opening:effective"),
        )
      : LinkOpeningSettingsSchema.parse(await invokeRendererQuery("settings:link-opening:get")),
  openExternal: openExternalUrl,
  saveLink: (url: string) => invokePlainCommand(saveLinkCommand, { url }),
};
/** A renderer with no Workbench Browser owner still obeys the system URL allowlist. */
export const openLink = createLinkRouter({
  ...desktopLinkOpeningAdapter,
  browserAvailable: false,
  browser: () => ({ available: false, open: async () => false }),
}).openLink;
