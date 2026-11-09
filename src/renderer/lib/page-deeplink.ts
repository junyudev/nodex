import {
  buildPageDeepLink as buildPage,
  buildSessionDeepLink as buildSession,
  buildViewDeepLink as buildView,
  type PageDeepLinkTarget,
  type SessionDeepLinkTarget,
  type ViewDeepLinkTarget,
} from "../../shared/nodex-deeplink";
import { rendererSpaceId } from "./renderer-space";
export {
  NODEX_PAGE_DEEPLINK_KIND,
  NODEX_DEEPLINK_PROTOCOL,
  NODEX_SESSION_DEEPLINK_KIND,
  NODEX_VIEW_DEEPLINK_KIND,
  parsePageDeepLink,
  parseSessionDeepLink,
  parseViewDeepLink,
  type PageDeepLinkTarget,
  type SessionDeepLinkTarget,
  type ViewDeepLinkTarget,
} from "../../shared/nodex-deeplink";

/** Links leaving the current document retain their originating Space. */
export const buildPageDeepLink = (target: PageDeepLinkTarget): string =>
  buildPage({ ...target, spaceId: target.spaceId ?? rendererSpaceId() });
export const buildSessionDeepLink = (target: SessionDeepLinkTarget): string =>
  buildSession({ ...target, spaceId: target.spaceId ?? rendererSpaceId() });
export const buildViewDeepLink = (target: ViewDeepLinkTarget): string =>
  buildView({ ...target, spaceId: target.spaceId ?? rendererSpaceId() });
