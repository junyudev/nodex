import {
  conversationTokenChildren,
  conversationTokenEngine,
  decodeConversationText,
  type ConversationToken,
} from "./conversation-tokens";
import {
  createMarkdownSegmentTimeline,
  markdownTextSegmentCache,
  type MarkdownSegmenter,
} from "./markdown-segments";

export interface ConversationRenderNode {
  readonly token: ConversationToken;
  readonly key: string;
  readonly children: readonly ConversationRenderNode[];
  readonly items: readonly (readonly ConversationRenderNode[])[];
  readonly itemKeys: readonly string[];
  readonly cells: readonly (readonly ConversationRenderNode[])[];
  readonly segments: readonly { readonly key: string; readonly text: string }[];
}
interface Identity {
  readonly token: ConversationToken;
  readonly key: string;
  readonly seed: string;
  readonly children: readonly Identity[];
  readonly items: readonly Identity[];
  readonly cells: readonly (readonly Identity[])[];
}

function text(token: ConversationToken): string {
  return "text" in token && typeof token.text === "string" ? token.text : "";
}
function seed(token: ConversationToken): string {
  if (token.type === "code" || token.type === "blockquote" || token.type === "list")
    return token.type;
  if (token.type === "image" || token.type === "link")
    return `${token.type}:${token.href}:${text(token).slice(0, 80)}`;
  if (token.type === "codexDirective")
    return `${token.name}:${String(token.attributes.file ?? token.attributes.path ?? token.attributes.id ?? "")}`;
  const child = conversationTokenChildren(token)[0];
  return `${token.type}:${text(token).trim().match(/^\S+/u)?.[0]?.slice(0, 80) ?? (child ? seed(child) : "")}`;
}

/** Shared tokens are read-only; keys and animation settlement belong to one mounted source. */
export function createConversationDocumentOwner(
  segmenter: MarkdownSegmenter | null,
  engine = conversationTokenEngine,
) {
  const prefix = { source: "", length: 0, document: null as ReturnType<typeof engine.read> | null };
  const plans = new WeakMap<Identity, ConversationRenderNode>();
  const timeline = createMarkdownSegmentTimeline();
  let committed: readonly Identity[] = [];
  let nextId = 0;
  const plan = (token: ConversationToken, identity: Identity): ConversationRenderNode => {
    const key = identity.key;
    const previous = plans.get(identity);
    if (previous) return previous;
    const children = conversationTokenChildren(token).map((child, index) =>
      plan(child, identity.children[index]!),
    );
    const items =
      token.type === "list"
        ? token.items.map((item, index) =>
            item.tokens.map((child, childIndex) =>
              plan(child as ConversationToken, identity.items[index]!.children[childIndex]!),
            ),
          )
        : [];
    const cells =
      token.type === "table"
        ? [...token.header, ...token.rows.flat()].map((cell, index) =>
            cell.tokens.map((child, childIndex) =>
              plan(child as ConversationToken, identity.cells[index]![childIndex]!),
            ),
          )
        : [];
    const content =
      token.type === "text" || token.type === "escape" ? decodeConversationText(text(token)) : "";
    const segments =
      content && children.length === 0
        ? markdownTextSegmentCache
            .read(content, true, segmenter)
            .map((value, index) => ({ key: `${key}:word:${index}`, text: value }))
        : [];
    const value = {
      token,
      key,
      children,
      items,
      itemKeys: identity.items.map((item) => item.key),
      cells,
      segments,
    };
    plans.set(identity, value);
    return value;
  };
  return {
    prepare(source: string, streaming: boolean) {
      const document = streaming
        ? engine.readStreaming(source, prefix)
        : engine.read(source, false);
      let candidateNextId = nextId;
      const matchSiblings = (
        tokens: readonly ConversationToken[],
        previous: readonly Identity[],
      ): Identity[] => {
        const unused = new Set(previous.map((_identity, index) => index));
        const equal = new Map<string, number[]>();
        const unchanged = new Map<string, Map<string, number[]>>();
        for (let index = previous.length - 1; index >= 0; index -= 1) {
          const identity = previous[index]!;
          const indexes = equal.get(identity.seed) ?? [];
          indexes.push(index);
          equal.set(identity.seed, indexes);
          const payloads = unchanged.get(identity.token.type) ?? new Map<string, number[]>();
          const candidates = payloads.get(identity.token.raw) ?? [];
          candidates.push(index);
          payloads.set(identity.token.raw, candidates);
          unchanged.set(identity.token.type, payloads);
        }
        // Reserve unchanged siblings before allowing a revised block to reuse a positional key.
        // Otherwise an insertion can take the key and focused controls of the following block.
        const reserved = tokens.map((token) => {
          const candidate = unchanged.get(token.type)?.get(token.raw)?.pop();
          if (candidate !== undefined) unused.delete(candidate);
          return candidate;
        });
        return tokens.map((token, index) => {
          const value = seed(token);
          const indexed = previous[index];
          let match =
            reserved[index] ??
            (indexed &&
            unused.has(index) &&
            (indexed.seed === value || value.startsWith(indexed.seed))
              ? index
              : undefined);
          const matches = equal.get(value);
          for (;;) {
            if (match !== undefined) break;
            const candidate = matches?.pop();
            if (candidate === undefined) break;
            if (unused.has(candidate)) match = candidate;
          }
          if (match !== undefined) unused.delete(match);
          const old = match === undefined ? undefined : previous[match];
          const key = old?.key ?? `conversation-node-${candidateNextId++}`;
          const children = matchSiblings(conversationTokenChildren(token), old?.children ?? []);
          const items = token.type === "list" ? matchSiblings(token.items, old?.items ?? []) : [];
          const cells =
            token.type === "table"
              ? [...token.header, ...token.rows.flat()].map((cell, cellIndex) =>
                  matchSiblings(cell.tokens as ConversationToken[], old?.cells[cellIndex] ?? []),
                )
              : [];
          if (
            old?.token === token &&
            children.every((child, childIndex) => child === old.children[childIndex]) &&
            items.every((item, itemIndex) => item === old.items[itemIndex]) &&
            cells.every((cell, cellIndex) =>
              cell.every((child, childIndex) => child === old.cells[cellIndex]?.[childIndex]),
            )
          )
            return old;
          return { token, seed: value, key, children, items, cells };
        });
      };
      const identities = matchSiblings(document.tokens, committed);
      const nodes = document.tokens.map((token, index) => plan(token, identities[index]!));
      return { document, nodes, identities, nextId: candidateNextId };
    },
    commit(
      candidate: {
        readonly identities: readonly Identity[];
        readonly nodes: readonly ConversationRenderNode[];
        readonly nextId: number;
      },
      animate: boolean,
    ) {
      committed = candidate.identities;
      nextId = candidate.nextId;
      const keys: string[] = [];
      const visit = (node: ConversationRenderNode) => {
        keys.push(...node.segments.map((segment) => segment.key));
        node.children.forEach(visit);
        node.items.flat().forEach(visit);
        node.cells.flat().forEach(visit);
      };
      candidate.nodes.forEach(visit);
      timeline.commit(keys, animate);
    },
    timeline,
    dispose() {
      timeline.dispose();
    },
  };
}
