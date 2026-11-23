import { field, text } from "../orchestration-v2/unknownField.ts";

/** Read search hits from the SDK's structured output or a native server-tool result. */
export function readClaudeWebSearchResults(output: unknown): { title: string; url: string }[] {
  const groups = field(output, "results");
  const hits =
    typeof field(output, "query") === "string" && Array.isArray(groups)
      ? groups.flatMap((group) => {
          const content = field(group, "content");
          return Array.isArray(content) ? content : [];
        })
      : Array.isArray(output)
        ? output.filter((entry) => field(entry, "type") === "web_search_result")
        : [];
  return hits.flatMap((hit) => {
    const title = text(field(hit, "title"));
    const url = text(field(hit, "url"));
    return title && url ? [{ title, url }] : [];
  });
}
