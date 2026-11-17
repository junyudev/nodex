import { splitSearchText } from "@nodex/agent-runtime/palette-search";
import type {
  ChatMatchHint,
  ChatSearchInput,
  ChatSearchMatch,
  ChatTextRange,
} from "../../shared/chat-search";
import type { FindPhase, FindResponse } from "../../shared/find";
import { findContent, useFind } from "./find";
import type { CommandPaletteHighlightSegment } from "./command-palette-highlight";

const NO_MATCHES: readonly ChatSearchMatch[] = [];

function requestFor(input: ChatSearchInput) {
  return {
    query: input.query,
    kinds: ["chat"] as const,
    place: { kind: "everywhere" as const },
    limit: input.limit,
    startedChatsOnly: input.startedOnly,
    preferredProjectId: input.preferredProjectId,
  };
}

function chatMatches(result: FindResponse | null) {
  return result?.hits.flatMap((hit) => (hit.kind === "chat" ? [hit.chatMatch] : [])) ?? NO_MATCHES;
}

export async function searchChats(input: ChatSearchInput, phase: FindPhase = "instant") {
  const result = await findContent(requestFor(input), phase);
  return { matches: chatMatches(result) };
}

export function completeChatSearch(input: ChatSearchInput) {
  return searchChats(input, "complete");
}

export function useChatSearch(input: ChatSearchInput & { enabled: boolean }) {
  const find = useFind(requestFor(input), { enabled: input.enabled });
  const awaitingCatalog =
    find.pending &&
    find.response?.coverage.some(
      (source) => source.source === "chat_catalog" && source.state === "pending",
    );
  const settled = find.settled && !awaitingCatalog;
  return {
    query: settled ? input.query.trim() : (find.previous?.query ?? ""),
    matches: chatMatches(find.response ?? find.previous?.response ?? null),
    answered: settled || find.previous !== null,
    settled,
    pending: find.pending,
  };
}

/** `text` cut at its matched ranges; null when nothing matched. */
export function chatHighlightSegments(
  text: string,
  ranges: readonly ChatTextRange[],
): CommandPaletteHighlightSegment[] | null {
  if (ranges.length === 0) return null;
  return splitSearchText(text, ranges).map((part) => ({
    text: part.text,
    highlight: part.highlighted,
  }));
}

/**
 * The hint's match inside `field` when the hint explains a match in that field. A branch hint
 * omits the worktree prefix, so its ranges are offset into the full branch.
 */
export function chatFieldHighlightSegments(
  field: string | null,
  hint: ChatMatchHint | null,
  label: "Branch" | "Project",
): CommandPaletteHighlightSegment[] | null {
  if (!field || hint?.label !== label || !field.endsWith(hint.text)) return null;
  const offset = field.length - hint.text.length;
  return chatHighlightSegments(
    field,
    hint.ranges.map((range) => ({ start: range.start + offset, end: range.end + offset })),
  );
}
