import { createHash } from "node:crypto";
import { searchKernel } from "@nodex/search-kernel/node";
import { compareMessageSearchRank, scoreMessageSearch } from "@nodex/agent-runtime/palette-search";
import { phraseBonus, rankQuality } from "@nodex/agent-runtime/orchestration/SessionSearchText";
import type { ChatSearchMatch, ChatTextRange } from "../../shared/chat-search";
import type { PageSearchTextPart } from "../../shared/types";
import type { ChatCatalogItem } from "./ChatCatalogProjection";
import { chatSearchSubject, chatWireEntry, singleLine } from "./ChatSearchRanking";

type FieldKind = "title" | "branch" | "project" | "pull_request" | "reference" | "prompt";

function searchDocument(chat: ChatCatalogItem) {
  const fields: { kind: FieldKind; text: string }[] = [];
  const add = (kind: FieldKind, text: string | null) => {
    if (text) fields.push({ kind, text });
  };
  add("title", chat.title);
  add("branch", chat.branch);
  add("project", chat.projectName);
  add("reference", chat.sessionId);
  for (const pr of chat.pullRequests) {
    add("pull_request", `#${pr.number}`);
    add("pull_request", pr.title);
    add("reference", pr.url);
    add("reference", pr.repository);
  }
  add("prompt", singleLine(chat.preview));
  return { id: chat.sessionId, fields };
}

function highlightedRanges(parts: readonly PageSearchTextPart[]): ChatTextRange[] {
  let end = 0;
  return parts.flatMap((part) => {
    const start = end;
    end += part.text.length;
    return part.highlighted ? [{ start, end }] : [];
  });
}

export function prepareChatMetadataIndex() {
  const index = new (searchKernel().ChatMetadataSearchIndex)();
  let documents = new Map<string, string>();
  return {
    update(entries: readonly ChatCatalogItem[]) {
      const next = new Map<string, string>();
      const upserts = entries.flatMap((entry) => {
        const document = searchDocument(entry);
        const signature = createHash("sha256")
          .update(JSON.stringify(document.fields))
          .digest("base64url");
        next.set(document.id, signature);
        return documents.get(document.id) === signature ? [] : [document];
      });
      const removals = [...documents.keys()].filter((id) => !next.has(id));
      index.applyDelta(upserts, removals);
      documents = next;
    },
    candidates(query: string, entries: readonly ChatCatalogItem[]) {
      const ids = new Set(index.candidates(query));
      return entries.filter(({ sessionId }) => ids.has(sessionId));
    },
    instant(
      query: string,
      entries: readonly ChatCatalogItem[],
      now: number,
      limit: number,
      placement: (a: ChatCatalogItem, b: ChatCatalogItem) => number,
    ) {
      const rows = new Map(entries.map((entry) => [entry.sessionId, entry]));
      const facts = index.strongMatches(query);
      const ranked = facts
        .flatMap(([id, textRank, ordered]) => {
          const entry = rows.get(id);
          if (!entry) return [];
          const subject = chatSearchSubject(entry);
          const wordQuality = rankQuality(textRank);
          const quality = wordQuality + (ordered ? phraseBonus : 0);
          return [{ entry, rank: scoreMessageSearch({ wordQuality, quality }, subject, now) }];
        })
        .sort(
          (a, b) =>
            placement(a.entry, b.entry) ||
            compareMessageSearchRank(a.rank, b.rank) ||
            a.entry.sessionId.localeCompare(b.entry.sessionId),
        );
      const visible = ranked.slice(0, limit);
      const evidence = index.evidence(
        query,
        visible.map(({ entry }) => entry.sessionId),
      );
      const matches = visible.map(({ entry, rank }, rowIndex): ChatSearchMatch => {
        const { title, hint } = evidence[rowIndex]!;
        return {
          chat: chatWireEntry(entry),
          titleRanges: highlightedRanges(title),
          hint: hint
            ? { label: hint.label, text: hint.text, ranges: highlightedRanges(hint.parts) }
            : null,
          excerpt: null,
          rank,
        };
      });
      return { matches, truncated: ranked.length > limit };
    },
    close: () => index.free(),
  };
}
