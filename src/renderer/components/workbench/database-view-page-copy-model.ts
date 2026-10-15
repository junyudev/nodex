import { buildPageDeepLink } from "@/lib/page-deeplink";
import type { DatabaseViewPageTarget } from "./database-view-page-actions";

export type DatabaseViewPageCopyActionId =
  | "copy-id"
  | "copy-deeplink"
  | "copy-title"
  | "copy-markdown";

export type DatabaseViewPageCopyRequest =
  | {
      readonly kind: "value";
      readonly value: string;
      readonly successMessage: string;
      readonly failureMessage: string;
    }
  | {
      readonly kind: "materialized-markdown";
      readonly routingContext: DatabaseViewPageTarget["routingContext"];
      readonly pageId: string;
      readonly successMessage: string;
      readonly failureMessage: string;
    };

export function isDatabaseViewPageCopyActionId(
  actionId: string,
): actionId is DatabaseViewPageCopyActionId {
  return (
    actionId === "copy-id" ||
    actionId === "copy-deeplink" ||
    actionId === "copy-title" ||
    actionId === "copy-markdown"
  );
}

/** Resolves copy intent without coupling product payload rules to menu lifecycle. */
export function resolveDatabaseViewPageCopyRequest(input: {
  readonly actionId: DatabaseViewPageCopyActionId;
  readonly page: DatabaseViewPageTarget;
  readonly presentedTitle: string;
}): DatabaseViewPageCopyRequest | null {
  const { actionId, page, presentedTitle } = input;
  if (actionId === "copy-id") {
    if (!page.pageKey) return null;
    return {
      kind: "value",
      value: page.pageKey,
      successMessage: "Copied ID",
      failureMessage: "Failed to copy ID",
    };
  }
  if (actionId === "copy-deeplink") {
    return {
      kind: "value",
      value: buildPageDeepLink({ pageId: page.pageId }),
      successMessage: "Copied deeplink",
      failureMessage: "Failed to copy deeplink",
    };
  }
  if (actionId === "copy-title") {
    return {
      kind: "value",
      value: presentedTitle.trim() || "Untitled Page",
      successMessage: "Copied title",
      failureMessage: "Failed to copy title",
    };
  }
  return {
    kind: "materialized-markdown",
    routingContext: page.routingContext,
    pageId: page.pageId,
    successMessage: "Copied content as Markdown",
    failureMessage: "Failed to copy content",
  };
}
