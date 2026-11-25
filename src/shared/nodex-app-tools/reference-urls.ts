import { buildPageDeepLink, buildSessionDeepLink, buildViewDeepLink } from "../nodex-deeplink";

export const withPageUrl = <T extends { readonly pageId: string }>(value: T) => ({
  ...value,
  url: buildPageDeepLink({ pageId: value.pageId }),
});

export const withSessionUrl = <T extends { readonly sessionId: string }>(value: T) => ({
  ...value,
  url: buildSessionDeepLink({ sessionId: value.sessionId }),
});

export const withViewUrl = <T extends { readonly viewId: string }>(value: T) => ({
  ...value,
  url: buildViewDeepLink({ viewId: value.viewId }),
});

export const pageBlockUrl = (pageId: string, blockId: string): string =>
  buildPageDeepLink({ pageId, blockId });
