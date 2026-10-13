import type { Element, Root, RootContent } from "hast";

interface ElementIdentity {
  readonly key: string;
  readonly seed: string;
  readonly children: readonly ElementIdentity[];
}
export interface MarkdownElementKeyCandidate {
  readonly keys: WeakMap<object, string>;
  readonly roots: readonly ElementIdentity[];
  readonly nextId: number;
}
function text(node: RootContent): string {
  if (node.type === "text") return node.value;
  return node.type === "element" ? node.children.map(text).join("") : "";
}
function semanticSeed(node: Element): string {
  if (node.tagName === "pre") return "pre:fenced-code";
  const firstWord = text(node).trim().match(/^\S+/u)?.[0]?.slice(0, 80) ?? "";
  if (node.tagName === "nodex-file-markdown-image")
    return `${node.tagName}:${String(node.properties.filesrc ?? "")}:${String(node.properties.filesrcset ?? "")}:${String(node.properties.alt ?? "")}`;
  if (node.tagName === "a" || node.tagName === "img")
    return `${node.tagName}:${String(node.properties.href ?? node.properties.src ?? "")}:${firstWord || String(node.properties.alt ?? "")}`;
  const child = node.children.find((value): value is Element => value.type === "element");
  return `${node.tagName}:${firstWord || (child ? semanticSeed(child) : "")}`;
}

/** Semantic sibling occurrences survive prefix/full parsing; render preparation owns no IDs. */
export function createMarkdownElementKeyOwner() {
  const seeds = new WeakMap<Element, string>();
  const readSeed = (node: Element) => {
    const previous = seeds.get(node);
    if (previous !== undefined) return previous;
    const value = semanticSeed(node);
    seeds.set(node, value);
    return value;
  };
  let committed: MarkdownElementKeyCandidate = { keys: new WeakMap(), roots: [], nextId: 0 };
  return {
    prepare(root: Root, external: WeakMap<object, string>): MarkdownElementKeyCandidate {
      let nextId = committed.nextId;
      const keys = new WeakMap<object, string>();
      const visit = (
        nodes: readonly RootContent[],
        previous: readonly ElementIdentity[],
      ): ElementIdentity[] => {
        const unused = new Set(previous.map((_value, index) => index));
        const bySeed = new Map<string, number[]>();
        const byKey = new Map<string, number[]>();
        for (let index = previous.length - 1; index >= 0; index -= 1) {
          const value = previous[index]!;
          for (const [map, key] of [
            [bySeed, value.seed],
            [byKey, value.key],
          ] as const) {
            const indexes = map.get(key) ?? [];
            indexes.push(index);
            map.set(key, indexes);
          }
        }
        const take = (map: Map<string, number[]>, key: string): number => {
          const candidates = map.get(key);
          let candidate = candidates?.pop();
          while (candidate !== undefined && !unused.has(candidate)) candidate = candidates?.pop();
          return candidate ?? -1;
        };
        return nodes
          .filter((node): node is Element => node.type === "element")
          .map((node, index) => {
            const seed = readSeed(node);
            const externalKey = external.get(node);
            const indexed = previous[index];
            const match = externalKey
              ? take(byKey, externalKey)
              : indexed &&
                  unused.has(index) &&
                  (indexed.seed === seed ||
                    (indexed.seed.length > 0 && seed.startsWith(indexed.seed)))
                ? index
                : take(bySeed, seed);
            if (match >= 0) unused.delete(match);
            const old = match >= 0 ? previous[match] : undefined;
            const key = externalKey ?? old?.key ?? `markdown-node-${nextId++}`;
            keys.set(node, key);
            return { key, seed, children: visit(node.children, old?.children ?? []) };
          });
      };
      return { keys, roots: visit(root.children, committed.roots), nextId };
    },
    commit(candidate: MarkdownElementKeyCandidate): void {
      committed = candidate;
    },
  };
}
