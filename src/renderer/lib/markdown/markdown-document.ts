import type { Element, ElementContent, Root as HtmlRoot, RootContent } from "hast";
import type { PluggableList } from "unified";
import {
  createMarkdownPrefixCache,
  markdownSyntaxEngine,
  type ImmutableMarkdown,
  type MarkdownSyntaxPolicy,
  type MarkdownSyntaxSnapshot,
} from "./markdown-syntax";
import {
  createMarkdownSegmentOwner,
  createMarkdownSegmentTimeline,
  markdownTextSegmentCache,
  type MarkdownSegmentCandidate,
  type MarkdownSegmenter,
} from "./markdown-segments";
import {
  createMarkdownElementKeyOwner,
  type MarkdownElementKeyCandidate,
} from "./markdown-element-keys";
import { findMarkdownOpenCodeFence } from "./markdown-prefix";

export const MARKDOWN_FADE_TAG = "nodex-markdown-segment";
interface HtmlPlan {
  readonly html: HtmlRoot;
  readonly textNodes: readonly { readonly node: Element; readonly text: string }[];
}
export interface MarkdownDocumentCandidate {
  readonly sourceIdentity: string;
  readonly syntax: MarkdownSyntaxSnapshot;
  readonly html: HtmlRoot;
  readonly keys: WeakMap<object, string>;
  readonly elementKeys: MarkdownElementKeyCandidate;
  readonly animationKeys: WeakMap<object, string>;
  readonly segments: MarkdownSegmentCandidate | null;
  readonly animate: boolean;
  readonly openCodeFence: Element | null;
}
const UNSEGMENTED = new Set(["code", "pre", "svg", "math", "script", "style", "textarea"]);

/** Mounted document state never enters the shared syntax caches. */
export function createMarkdownDocumentOwner(
  segmenter: MarkdownSegmenter | null,
  engine = markdownSyntaxEngine,
  now?: () => number,
) {
  const prefixes = new WeakMap<
    PluggableList,
    Map<string, ReturnType<typeof createMarkdownPrefixCache>>
  >();
  const plans = new WeakMap<object, HtmlPlan>();
  let sourceIdentity: string | null = null;
  let segments = createMarkdownSegmentOwner();
  let timeline = createMarkdownSegmentTimeline(now);
  let committedKeys: readonly string[] = [];
  let elementKeys = createMarkdownElementKeyOwner();
  const plan = (root: ImmutableMarkdown<HtmlRoot>): HtmlPlan => {
    const previous = plans.get(root);
    if (previous) return previous;
    const textNodes: { node: Element; text: string }[] = [];
    const visit = (
      node: ImmutableMarkdown<RootContent>,
      segmentText: boolean,
      decorated: boolean,
    ): RootContent[] => {
      if (node.type === "text" && segmentText && node.value.trim()) {
        return markdownTextSegmentCache.read(node.value, decorated, segmenter).map((text) => {
          const element: Element = {
            type: "element",
            tagName: MARKDOWN_FADE_TAG,
            properties: {},
            children: [{ type: "text", value: text }],
          };
          textNodes.push({ node: element, text });
          return element;
        });
      }
      if (node.type !== "element") return [node as RootContent];
      const classes = node.properties.className;
      const math =
        Array.isArray(classes) && classes.some((name) => String(name).startsWith("katex"));
      const eligible = segmentText && !UNSEGMENTED.has(node.tagName) && !math;
      return [
        {
          type: "element",
          tagName: node.tagName,
          position: node.position,
          properties: structuredClone(node.properties) as Element["properties"],
          children: node.children.flatMap((child) =>
            visit(child, eligible, decorated && node.tagName !== "a"),
          ) as ElementContent[],
        },
      ];
    };
    const value = {
      html: {
        type: "root",
        children: root.children.flatMap((node) => visit(node, true, true)),
      } as HtmlRoot,
      textNodes,
    };
    plans.set(root, value);
    return value;
  };
  return {
    prepare(input: {
      readonly source: string;
      readonly sourceIdentity: string;
      readonly streaming: boolean;
      readonly animate: boolean;
      readonly policy: MarkdownSyntaxPolicy;
    }): MarkdownDocumentCandidate {
      const variant = `${input.policy.family}:${input.policy.normalizeLists}:${input.policy.repairIncomplete}:${input.policy.blockLocal}`;
      let variants = prefixes.get(input.policy.remarkPlugins);
      if (!variants) {
        variants = new Map();
        prefixes.set(input.policy.remarkPlugins, variants);
      }
      let prefix = variants.get(variant);
      if (!prefix) {
        prefix = createMarkdownPrefixCache();
        variants.set(variant, prefix);
      }
      const syntax = input.streaming
        ? engine.readStreaming(input.source, input.policy, prefix)
        : engine.readFull(input.source, input.policy, "terminal");
      const blocks = syntax.blocks.map((block) =>
        input.animate ? plan(block.html) : { html: block.html as HtmlRoot, textNodes: [] },
      );
      const text = blocks.flatMap((block) => block.textNodes);
      // A new native leaf receives an independent candidate without mutating the mounted owner.
      const candidate = input.animate
        ? (sourceIdentity !== null && sourceIdentity !== input.sourceIdentity
            ? createMarkdownSegmentOwner()
            : segments
          ).prepare(text.map((node) => node.text))
        : null;
      const keys = new WeakMap<object, string>();
      text.forEach((node, index) => keys.set(node.node, candidate!.segments[index]!.key));
      const children = blocks.flatMap((block, index) =>
        index === 0
          ? block.html.children
          : [{ type: "text", value: "\n" } as const, ...block.html.children],
      );
      const animationKeys = new WeakMap<object, string>();
      const widgetOccurrences = new Map<string, number>();
      const visitKeys = (
        node: RootContent,
        occurrences: Map<string, number>,
      ): string | undefined => {
        if (node.type !== "element") return undefined;
        const childOccurrences = new Map<string, number>();
        const textKey =
          keys.get(node) ??
          node.children
            .map((child) => visitKeys(child, childOccurrences))
            .find((key) => key !== undefined);
        if (textKey) animationKeys.set(node, textKey);
        if (node.tagName === "nodex-visualization") {
          const locator = JSON.stringify([node.properties.file, node.properties.threadid]);
          const ordinal = occurrences.get(locator) ?? 0;
          occurrences.set(locator, ordinal + 1);
          keys.set(node, `visualization:${locator}:${ordinal}`);
        }
        return textKey;
      };
      children.forEach((node) => visitKeys(node, widgetOccurrences));
      const lastElement = children.findLast((node): node is Element => node.type === "element");
      const openCodeFence =
        input.streaming && lastElement?.tagName === "pre" && findMarkdownOpenCodeFence(input.source)
          ? lastElement
          : null;
      const html: HtmlRoot = { type: "root", children };
      const keyCandidate = (
        sourceIdentity !== null && sourceIdentity !== input.sourceIdentity
          ? createMarkdownElementKeyOwner()
          : elementKeys
      ).prepare(html, keys);
      return {
        sourceIdentity: input.sourceIdentity,
        syntax,
        html,
        keys: keyCandidate.keys,
        elementKeys: keyCandidate,
        animationKeys,
        segments: candidate,
        animate: input.animate,
        openCodeFence,
      };
    },
    commit(candidate: MarkdownDocumentCandidate): void {
      if (sourceIdentity !== null && sourceIdentity !== candidate.sourceIdentity) {
        timeline.dispose();
        timeline = createMarkdownSegmentTimeline(now);
        segments = createMarkdownSegmentOwner();
        committedKeys = [];
        elementKeys = createMarkdownElementKeyOwner();
      }
      sourceIdentity = candidate.sourceIdentity;
      elementKeys.commit(candidate.elementKeys);
      if (candidate.segments) {
        segments.commit(candidate.segments);
        committedKeys = candidate.segments.segments.map((value) => value.key);
      }
      timeline.activate();
      timeline.commit(committedKeys, candidate.animate);
    },
    getTimeline: () => timeline,
    dispose: () => timeline.dispose(),
  };
}
