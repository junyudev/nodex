import { unified, type PluggableList } from "unified";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import remend from "remend";
import {
  prepareConversationMarkdownDisplay,
  type MarkdownDisplayDialect,
} from "../../../shared/conversation-markdown-display";
import type { Nodes, Root, RootContent } from "mdast";
import type { Root as HtmlRoot } from "hast";
import {
  createMarkdownCache,
  MARKDOWN_PREFIX_CACHE_MAX_KEYS,
  MARKDOWN_SYNTAX_CACHE_MAX_KEYS,
  MARKDOWN_SYNTAX_CACHE_MAX_KEY_UNITS,
  MARKDOWN_SYNTAX_CACHE_MAX_SOURCE_UNITS,
  type MarkdownCache,
} from "./markdown-cache";
import { postprocessMarkdownSyntax } from "./markdown-postprocess";
import { findMarkdownStablePrefix } from "./markdown-prefix";

export type ImmutableMarkdown<Value> = Value extends readonly (infer Item)[]
  ? readonly ImmutableMarkdown<Item>[]
  : Value extends object
    ? { readonly [Key in keyof Value]: ImmutableMarkdown<Value[Key]> }
    : Value;

export interface MarkdownSyntaxPolicy {
  readonly dialect?: MarkdownDisplayDialect;
  readonly visualizationDirectives?: boolean;
  readonly family: boolean;
  readonly normalizeLists: boolean;
  readonly repairIncomplete: boolean;
  readonly remarkPlugins: PluggableList;
  readonly rehypePlugins: PluggableList;
  /** Only extensions whose transforms are local to a block may use the prefix lane. */
  readonly blockLocal: boolean;
}

export interface MarkdownSyntaxBlock {
  readonly node: ImmutableMarkdown<Root | RootContent>;
  readonly parserSource: string;
  readonly source: string;
}

export interface MarkdownSyntaxTree {
  readonly ast: ImmutableMarkdown<Root>;
  readonly parserSource: string;
  readonly blocks: readonly MarkdownSyntaxBlock[];
}

export type MarkdownFullDocumentReason = "terminal" | "extension" | "references" | "html";

export interface MarkdownSyntaxSnapshot {
  readonly blocks: readonly {
    readonly syntax: MarkdownSyntaxBlock;
    readonly html: ImmutableMarkdown<HtmlRoot>;
  }[];
  readonly fullDocumentReason: MarkdownFullDocumentReason | null;
}

export interface MarkdownSyntaxMeasurements {
  readonly normalizedUnits: number;
  readonly scannedUnits: number;
  readonly parsedUnits: number;
  readonly transformedUnits: number;
  readonly parseCalls: number;
  readonly transformCalls: number;
  readonly fullCacheHits: number;
  readonly prefixCacheHits: number;
}

function freezeTree<Value>(value: Value): ImmutableMarkdown<Value> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(freezeTree);
    Object.freeze(value);
  }
  return value as ImmutableMarkdown<Value>;
}

/** Normalization belongs to cache misses, so a raw-source hit does no second full scan. */
function prepareMarkdownSource(source: string, policy: MarkdownSyntaxPolicy): string {
  if (policy.dialect === "conversation")
    return prepareConversationMarkdownDisplay(source, {
      streaming: policy.repairIncomplete,
      inlineVisualizations: policy.visualizationDirectives ?? false,
    }).source;
  const normalized = source.replace(/\r\n?/g, "\n");
  return policy.repairIncomplete ? remend(normalized) : normalized;
}

function fullDocumentReason(
  source: string,
  policy: MarkdownSyntaxPolicy,
): Exclude<MarkdownFullDocumentReason, "terminal"> | null {
  if (!policy.blockLocal) return "extension";
  return null;
}

function syntaxHasHtml(node: ImmutableMarkdown<Nodes>): boolean {
  return node.type === "html" || ("children" in node && node.children.some(syntaxHasHtml));
}

function syntaxHasReferences(node: ImmutableMarkdown<Nodes>): boolean {
  if (
    node.type === "definition" ||
    node.type === "linkReference" ||
    node.type === "imageReference" ||
    node.type === "footnoteDefinition" ||
    node.type === "footnoteReference"
  )
    return true;
  return "children" in node && node.children.some(syntaxHasReferences);
}

function createSyntaxPartition(policy: MarkdownSyntaxPolicy) {
  const parser = unified().use(remarkParse).use(policy.remarkPlugins);
  return {
    parser,
    syntax: createMarkdownCache<MarkdownSyntaxTree>({
      maxKeys: MARKDOWN_SYNTAX_CACHE_MAX_KEYS,
      maxKeyUnits: MARKDOWN_SYNTAX_CACHE_MAX_KEY_UNITS,
      refreshOnRead: true,
    }),
    transforms: new WeakMap<
      PluggableList,
      {
        processor: ReturnType<typeof createTransformer>;
        html: WeakMap<object, ImmutableMarkdown<HtmlRoot>>;
      }
    >(),
  };
}

function createTransformer(policy: MarkdownSyntaxPolicy) {
  return unified()
    .use(remarkParse)
    .use(policy.remarkPlugins)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(policy.rehypePlugins);
}

/** Typed trees are shared by syntax policy; mounted prefixes never retain runtime capabilities. */
export function createMarkdownSyntaxEngine() {
  const families = [
    new WeakMap<PluggableList, Map<boolean, ReturnType<typeof createSyntaxPartition>>>(),
    new WeakMap<PluggableList, Map<boolean, ReturnType<typeof createSyntaxPartition>>>(),
  ];
  let measurements = {
    normalizedUnits: 0,
    scannedUnits: 0,
    parsedUnits: 0,
    transformedUnits: 0,
    parseCalls: 0,
    transformCalls: 0,
    fullCacheHits: 0,
    prefixCacheHits: 0,
  };
  const partition = (policy: MarkdownSyntaxPolicy) => {
    const family = families[policy.family ? 1 : 0]!;
    let variants = family.get(policy.remarkPlugins);
    if (!variants) {
      variants = new Map();
      family.set(policy.remarkPlugins, variants);
    }
    const previous = variants.get(policy.repairIncomplete);
    if (previous) return previous;
    const value = createSyntaxPartition(policy);
    variants.set(policy.repairIncomplete, value);
    return value;
  };
  const readInput = (
    source: string,
    policy: MarkdownSyntaxPolicy,
    preparedSource?: string,
  ): MarkdownSyntaxTree => {
    const cache = partition(policy);
    const key = `${policy.normalizeLists}:${source}`;
    const cached = cache.syntax.get(key);
    if (cached) {
      measurements.fullCacheHits += 1;
      return cached;
    }
    if (preparedSource === undefined) measurements.normalizedUnits += source.length;
    const parserSource = preparedSource ?? prepareMarkdownSource(source, policy);
    measurements.parsedUnits += parserSource.length;
    measurements.parseCalls += 1;
    const parsed = cache.parser.parse(parserSource);
    postprocessMarkdownSyntax(parsed, parserSource, policy.normalizeLists);
    const ast = freezeTree(parsed);
    const blocks = ast.children.map((node) =>
      Object.freeze({
        node,
        parserSource,
        source: parserSource.slice(node.position?.start.offset ?? 0, node.position?.end.offset),
      }),
    );
    const result = Object.freeze({ ast, parserSource, blocks: Object.freeze(blocks) });
    if (source.length <= MARKDOWN_SYNTAX_CACHE_MAX_SOURCE_UNITS) cache.syntax.set(key, result);
    return result;
  };
  const read = (source: string, policy: MarkdownSyntaxPolicy) => readInput(source, policy);
  const transform = (
    ast: ImmutableMarkdown<Root>,
    source: string,
    units: number,
    identity: object,
    policy: MarkdownSyntaxPolicy,
  ): ImmutableMarkdown<HtmlRoot> => {
    const cache = partition(policy);
    let transforms = cache.transforms.get(policy.rehypePlugins);
    if (!transforms) {
      transforms = { processor: createTransformer(policy), html: new WeakMap() };
      cache.transforms.set(policy.rehypePlugins, transforms);
    }
    const previous = transforms.html.get(identity);
    if (previous) return previous;
    measurements.transformedUnits += units;
    measurements.transformCalls += 1;
    // Public plugins may mutate their input; cached syntax is never handed to them.
    const output = transforms.processor.runSync(structuredClone(ast) as Root, source);
    const html = freezeTree(output);
    transforms.html.set(identity, html);
    return html;
  };
  const readFull = (
    source: string,
    policy: MarkdownSyntaxPolicy,
    reason: MarkdownFullDocumentReason,
  ) => {
    const syntax = read(source, policy);
    const html = transform(
      syntax.ast,
      syntax.parserSource,
      syntax.parserSource.length,
      syntax.ast,
      policy,
    );
    return {
      blocks: [{ syntax: { node: syntax.ast, source, parserSource: syntax.parserSource }, html }],
      fullDocumentReason: reason,
    };
  };
  return {
    read,
    readStreaming(
      source: string,
      policy: MarkdownSyntaxPolicy,
      prefixes: MarkdownCache<readonly MarkdownSyntaxBlock[]>,
    ): MarkdownSyntaxSnapshot {
      measurements.scannedUnits += source.length;
      const reason = fullDocumentReason(source, policy);
      if (reason) return readFull(source, policy, reason);
      // Repair once before splitting: an inline delimiter may depend on a later block.
      measurements.normalizedUnits += source.length;
      const prepared = prepareMarkdownSource(source, policy);
      const preparedPolicy = policy.repairIncomplete
        ? { ...policy, repairIncomplete: false }
        : policy;
      const boundary = findMarkdownStablePrefix(prepared);
      const prefix = prepared.slice(0, boundary);
      let blocks = prefix ? prefixes.get(prefix) : [];
      if (prefix && blocks) measurements.prefixCacheHits += 1;
      if (!blocks) {
        let previousSource = "";
        let previousBlocks: readonly MarkdownSyntaxBlock[] = [];
        for (const [key, value] of prefixes.entries()) {
          if (key.length > previousSource.length && prefix.startsWith(key)) {
            previousSource = key;
            previousBlocks = value;
          }
        }
        const suffix = prefix.slice(previousSource.length);
        blocks = Object.freeze([
          ...previousBlocks,
          ...readInput(suffix, preparedPolicy, suffix).blocks,
        ]);
        if (prefix) prefixes.set(prefix, blocks);
      }
      const tailSource = prepared.slice(boundary);
      const tail =
        boundary === 0
          ? readInput(source, policy, prepared)
          : readInput(tailSource, preparedPolicy, tailSource);
      const tailPolicy = boundary === 0 ? policy : preparedPolicy;
      const allNodes = [...blocks.map((block) => block.node), ...tail.ast.children];
      if (allNodes.some(syntaxHasReferences)) return readFull(source, policy, "references");
      if (allNodes.some(syntaxHasHtml)) return readFull(source, policy, "html");
      return {
        blocks: [
          ...blocks.map((syntax) => ({ syntax, policy: preparedPolicy })),
          ...tail.blocks.map((syntax) => ({ syntax, policy: tailPolicy })),
        ].map(({ syntax, policy: blockPolicy }) => ({
          syntax,
          html: transform(
            syntax.node.type === "root" ? syntax.node : { type: "root", children: [syntax.node] },
            syntax.parserSource,
            syntax.source.length,
            syntax.node,
            blockPolicy,
          ),
        })),
        fullDocumentReason: null,
      };
    },
    readFull,
    getMeasurements(): MarkdownSyntaxMeasurements {
      return { ...measurements };
    },
    resetMeasurements(): void {
      measurements = {
        normalizedUnits: 0,
        scannedUnits: 0,
        parsedUnits: 0,
        transformedUnits: 0,
        parseCalls: 0,
        transformCalls: 0,
        fullCacheHits: 0,
        prefixCacheHits: 0,
      };
    },
  };
}

export function createMarkdownPrefixCache() {
  return createMarkdownCache<readonly MarkdownSyntaxBlock[]>({
    maxKeys: MARKDOWN_PREFIX_CACHE_MAX_KEYS,
    refreshOnRead: false,
  });
}

export const markdownSyntaxEngine = createMarkdownSyntaxEngine();
