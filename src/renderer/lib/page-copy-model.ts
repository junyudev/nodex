import { getIntl, type IntlShape } from "@/lib/i18n";
import { buildPageDeepLink } from "@/lib/page-deeplink";
import type { ContentRoutingContext } from "../../shared/content-routing-context";

export type PageCopyActionId = "copy-id" | "copy-deeplink" | "copy-title" | "copy-markdown";

/** The Page a copy action reads from, wherever the Page is presented. */
export interface PageCopyTarget {
  readonly routingContext: ContentRoutingContext;
  readonly pageId: string;
  readonly pageKey: string | null;
}

export interface PageCopyAction {
  readonly id: PageCopyActionId;
  readonly label: string;
  readonly keywords: readonly string[];
  readonly disabled: boolean;
}

export type PageCopyRequest =
  | {
      readonly kind: "value";
      readonly value: string;
      readonly successMessage: string;
      readonly failureMessage: string;
    }
  | {
      readonly kind: "materialized-markdown";
      readonly routingContext: ContentRoutingContext;
      readonly pageId: string;
      readonly successMessage: string;
      readonly failureMessage: string;
    };

/** Every Page menu offers the same copy actions, in the same order and words. */
export function listPageCopyActions(
  {
    hasPageKey,
    canCopyMarkdown,
  }: {
    readonly hasPageKey: boolean;
    readonly canCopyMarkdown: boolean;
  },
  intl: IntlShape = getIntl(),
): readonly PageCopyAction[] {
  return [
    ...(hasPageKey
      ? [
          {
            id: "copy-id" as const,
            label: intl.formatMessage({
              id: "lib.pageCopyModel.copyId",
              defaultMessage: "Copy ID",
            }),
            keywords: ["page", "key", "identifier"],
            disabled: false,
          },
        ]
      : []),
    {
      id: "copy-deeplink",
      label: intl.formatMessage({
        id: "lib.pageCopyModel.copyDeeplink",
        defaultMessage: "Copy link",
      }),
      keywords: ["link", "url", "reference"],
      disabled: false,
    },
    {
      id: "copy-title",
      label: intl.formatMessage({
        id: "lib.pageCopyModel.copyTitle",
        defaultMessage: "Copy title",
      }),
      keywords: ["name", "heading"],
      disabled: false,
    },
    {
      id: "copy-markdown",
      label: intl.formatMessage({
        id: "lib.pageCopyModel.copyMarkdown",
        defaultMessage: "Copy content as Markdown",
      }),
      keywords: ["body", "document", "markdown", "text"],
      disabled: !canCopyMarkdown,
    },
  ];
}

export function isPageCopyActionId(actionId: string): actionId is PageCopyActionId {
  return (
    actionId === "copy-id" ||
    actionId === "copy-deeplink" ||
    actionId === "copy-title" ||
    actionId === "copy-markdown"
  );
}

/** Resolves copy intent without coupling product payload rules to menu lifecycle. */
export function resolvePageCopyRequest(input: {
  readonly actionId: PageCopyActionId;
  readonly page: PageCopyTarget;
  readonly presentedTitle: string;
}): PageCopyRequest | null {
  const { actionId, page, presentedTitle } = input;
  if (actionId === "copy-id") {
    if (!page.pageKey) return null;
    return {
      kind: "value",
      value: page.pageKey,
      successMessage: getIntl().formatMessage({
        id: "lib.pageCopyModel.copiedId",
        defaultMessage: "Copied ID",
      }),
      failureMessage: getIntl().formatMessage({
        id: "lib.pageCopyModel.copyIdFailed",
        defaultMessage: "Failed to copy ID",
      }),
    };
  }
  if (actionId === "copy-deeplink") {
    return {
      kind: "value",
      value: buildPageDeepLink({ pageId: page.pageId }),
      successMessage: getIntl().formatMessage({
        id: "lib.pageCopyModel.copiedDeeplink",
        defaultMessage: "Copied link",
      }),
      failureMessage: getIntl().formatMessage({
        id: "lib.pageCopyModel.copyDeeplinkFailed",
        defaultMessage: "Failed to copy link",
      }),
    };
  }
  if (actionId === "copy-title") {
    return {
      kind: "value",
      value: presentedTitle.trim() || "Untitled Page",
      successMessage: getIntl().formatMessage({
        id: "lib.pageCopyModel.copiedTitle",
        defaultMessage: "Copied title",
      }),
      failureMessage: getIntl().formatMessage({
        id: "lib.pageCopyModel.copyTitleFailed",
        defaultMessage: "Failed to copy title",
      }),
    };
  }
  return {
    kind: "materialized-markdown",
    routingContext: page.routingContext,
    pageId: page.pageId,
    successMessage: getIntl().formatMessage({
      id: "lib.pageCopyModel.copiedMarkdown",
      defaultMessage: "Copied content as Markdown",
    }),
    failureMessage: getIntl().formatMessage({
      id: "lib.pageCopyModel.copyMarkdownFailed",
      defaultMessage: "Failed to copy content",
    }),
  };
}
