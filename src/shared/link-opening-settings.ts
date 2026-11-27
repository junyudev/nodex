import { z } from "zod";

export const LinkOpenTargetSchema = z.enum(["in-app-browser", "external-browser"]);
export const ExternalBrowserLinkShortcutSchema = z.enum([
  "unassigned",
  "primary",
  "alt",
  "primary-shift",
]);
export type ExternalBrowserLinkShortcut = z.infer<typeof ExternalBrowserLinkShortcutSchema>;
export const LinkOpeningSettingsSchema = z
  .object({
    openLinkInTarget: LinkOpenTargetSchema,
    openLocalUrlInTarget: LinkOpenTargetSchema,
    externalBrowserLinkShortcut: ExternalBrowserLinkShortcutSchema,
    openGitHubThreadsInNodex: z.boolean(),
  })
  .strict();
export type LinkOpeningSettings = z.infer<typeof LinkOpeningSettingsSchema>;

export const EffectiveLinkOpeningSettingsSchema = LinkOpeningSettingsSchema.extend({
  nativeGitHubHosts: z.array(z.string()),
});
export type EffectiveLinkOpeningSettings = z.infer<typeof EffectiveLinkOpeningSettingsSchema>;

/** Effective Profile defaults, including the unconfigured ordinary-web destination. */
export const DEFAULT_LINK_OPENING_SETTINGS: LinkOpeningSettings = {
  openLinkInTarget: "external-browser",
  openLocalUrlInTarget: "in-app-browser",
  externalBrowserLinkShortcut: "primary",
  openGitHubThreadsInNodex: true,
};
export const LINK_OPENING_SETTINGS_CHANGED_CHANNEL = "link-opening-settings-changed";
export function sameLinkOpeningSettings(a: LinkOpeningSettings, b: LinkOpeningSettings): boolean {
  return (
    a.openLinkInTarget === b.openLinkInTarget &&
    a.openLocalUrlInTarget === b.openLocalUrlInTarget &&
    a.externalBrowserLinkShortcut === b.externalBrowserLinkShortcut &&
    a.openGitHubThreadsInNodex === b.openGitHubThreadsInNodex
  );
}
