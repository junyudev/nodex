import {
  OrchestrationV2WebSearchResult,
  type OrchestrationV2TurnItem,
} from "@nodex/runtime-contracts";
import type { V2ItemCompletedNotification__ThreadItem } from "effect-codex-app-server/schema";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { field, text } from "../unknownField.ts";

export type CodexWebSearchItem = Extract<
  V2ItemCompletedNotification__ThreadItem,
  { readonly type: "webSearch" }
>;

type WebSearchFields = Pick<
  Extract<OrchestrationV2TurnItem, { type: "web_search" }>,
  "action" | "patterns" | "results"
>;

const decodeResult = Schema.decodeUnknownOption(OrchestrationV2WebSearchResult);

function readResult(value: unknown): readonly OrchestrationV2WebSearchResult[] {
  const type = field(value, "type");
  const title = text(field(value, "title"));
  if (type !== "text_result" && (type !== undefined || title === undefined)) return [];
  const url = field(value, "url");
  if (typeof url !== "string") return [];
  const snippet = field(value, "snippet");
  return Option.toArray(
    decodeResult({
      ...(type === "text_result" ? { type } : {}),
      ...(title === undefined ? {} : { title }),
      url,
      ...(typeof snippet === "string" ? { snippet } : {}),
    }),
  );
}

/** Live items, reconciled turns and imports share the same web-search projection. */
export function codexWebSearchFields({
  query,
  action,
  results,
}: Pick<CodexWebSearchItem, "query" | "action"> & { readonly results?: unknown }): WebSearchFields {
  const queries =
    action?.type === "search"
      ? [...(action.queries ?? []), action.query]
      : action?.type === "findInPage"
        ? [action.pattern, action.url]
        : action?.type === "openPage"
          ? [action.url]
          : [];
  const patterns = [...queries, query].flatMap((value) => text(value) ?? []);
  const hits = Array.isArray(results) ? results.flatMap(readResult) : [];
  return {
    ...(action == null ? {} : { action }),
    ...(patterns.length ? { patterns } : {}),
    ...(hits.length ? { results: hits } : {}),
  };
}
