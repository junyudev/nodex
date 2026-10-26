import {
  createContext,
  useContext,
  useId,
  useLayoutEffect,
  useMemo,
  useState,
  Fragment,
  type CSSProperties,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
  type ComponentType,
  createElement,
} from "react";
import { jsx, jsxs } from "react/jsx-runtime";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import type { Element } from "hast";
import { Streamdown, type BlockProps, type Components } from "streamdown";
import {
  createMarkdownDocumentOwner,
  MARKDOWN_FADE_TAG,
  type MarkdownDocumentCandidate,
} from "./markdown-document";
import { type MarkdownSyntaxPolicy } from "./markdown-syntax";
import { MarkdownCodeBlock, markdownPublicLeafComponents } from "./markdown-public-leaves";
import { markdownDocumentPlugins } from "./markdown-document-plugins";
import { CODE_BLOCK_THEME_PAIR } from "../syntax-highlighting";
import { useResolvedReducedMotion } from "../use-reduced-motion";

type DocumentOwner = ReturnType<typeof createMarkdownDocumentOwner>;
interface MarkdownDocumentValue {
  readonly owner: DocumentOwner;
  readonly candidate: MarkdownDocumentCandidate;
  readonly components: Components;
  readonly fadeDelayMs: number;
  readonly duration: string;
}
const DocumentContext = createContext<MarkdownDocumentValue | null>(null);
const DOCUMENT_SLOT = "markdown-document";
const splitDocumentSlot = () => [DOCUMENT_SLOT];
const noAnimation = false;
const codeThemes: [(typeof CODE_BLOCK_THEME_PAIR)[0], (typeof CODE_BLOCK_THEME_PAIR)[1]] = [
  ...CODE_BLOCK_THEME_PAIR,
];

function MarkdownFadeSegment({ children, node }: ComponentProps<"span"> & { node?: Element }) {
  const document = useContext(DocumentContext);
  if (!document || !node) return children;
  const key = document.candidate.keys.get(node);
  if (!key) return children;
  const timeline = document.owner.getTimeline();
  const animate = document.candidate.animate && !timeline.isSettled(key);
  return (
    <span
      data-markdown-segment={key}
      data-sd-animate={animate ? "true" : undefined}
      style={
        animate
          ? ({
              "--sd-duration": document.duration,
              "--sd-easing": "cubic-bezier(.37, .55, .86, .88)",
              "--sd-delay": "0ms",
            } as CSSProperties)
          : undefined
      }
      ref={(element) => {
        if (!animate || !element) return;
        const delay = timeline.attach(element, key, document.fadeDelayMs);
        if (delay !== null) element.style.setProperty("--sd-delay", `${delay}ms`);
      }}
      onAnimationEnd={(event) => {
        if (timeline.settle(key, event.target === event.currentTarget))
          event.currentTarget.removeAttribute("data-sd-animate");
      }}
    >
      {children}
    </span>
  );
}

function MarkdownPre({ node }: ComponentProps<"pre"> & { node?: Element }) {
  const document = useContext(DocumentContext);
  if (!node || !document) return null;
  return <MarkdownCodeBlock node={node} incomplete={node === document.candidate.openCodeFence} />;
}

function MarkdownListItem({
  node,
  style,
  className,
  ...props
}: ComponentProps<"li"> & { node?: Element }) {
  const document = useContext(DocumentContext);
  const Component = document?.components.li ?? "li";
  const key = node && document?.candidate.animationKeys.get(node);
  const timeline = document?.owner.getTimeline();
  const animate = key && document?.candidate.animate && !timeline?.isSettled(key);
  return createElement(Component, {
    ...props,
    node,
    className: [
      className,
      animate
        ? "marker:[animation:sd-fadeIn_var(--sd-duration)_var(--sd-easing)_var(--sd-delay)_both]"
        : undefined,
    ]
      .filter(Boolean)
      .join(" "),
    style: animate
      ? ({
          ...style,
          "--sd-duration": document?.duration,
          "--sd-easing": "cubic-bezier(.37, .55, .86, .88)",
          "--sd-delay": "0ms",
        } as CSSProperties)
      : style,
    onAnimationEnd: (event: React.AnimationEvent<HTMLLIElement>) => {
      if (key) timeline?.settle(key, event.target === event.currentTarget);
      props.onAnimationEnd?.(event);
    },
    ref: (element: HTMLLIElement | null) => {
      if (!element || !animate || !key || !timeline) return;
      const delay = timeline.attach(element, key, document?.fadeDelayMs ?? 0);
      if (delay !== null) element.style.setProperty("--sd-delay", `${delay}ms`);
    },
  });
}

const renderComponents: Components = {
  ...markdownPublicLeafComponents,
  pre: MarkdownPre,
  [MARKDOWN_FADE_TAG]: MarkdownFadeSegment,
};

const primitiveAdapters = new Map<string, ComponentType<Record<string, unknown>>>();
function primitiveAdapter(tagName: string): ComponentType<Record<string, unknown>> {
  const previous = primitiveAdapters.get(tagName);
  if (previous) return previous;
  const Component = ({ node, ...props }: Record<string, unknown>) => {
    void node;
    return createElement(tagName, props, props.children as ReactNode);
  };
  primitiveAdapters.set(tagName, Component);
  return Component;
}

/** A stable public Block consumes the current typed document, never Streamdown's deferred text. */
function TypedMarkdownBlock(_props: BlockProps) {
  const document = useContext(DocumentContext);
  if (!document) return null;
  const components = { ...renderComponents, ...document.components };
  // App inline-code leaves remain distinct from block code handled by the public pre adapter.
  if (components.inlineCode) components.code = components.inlineCode;
  components.li = MarkdownListItem;
  const registerPrimitive = (node: Element): void => {
    if (!components[node.tagName]) components[node.tagName] = primitiveAdapter(node.tagName);
    node.children.forEach((child) => {
      if (child.type === "element") registerPrimitive(child);
    });
  };
  document.candidate.html.children.forEach((node) => {
    if (node.type === "element") registerPrimitive(node);
  });
  const keyedJsx: typeof jsx = (type, props, key) => {
    const node = props && typeof props === "object" && "node" in props ? props.node : undefined;
    const stable = node && typeof node === "object" ? document.candidate.keys.get(node) : undefined;
    return jsx(type, props, stable ?? key);
  };
  const keyedJsxs: typeof jsxs = (type, props, key) => {
    const node = props && typeof props === "object" && "node" in props ? props.node : undefined;
    const stable = node && typeof node === "object" ? document.candidate.keys.get(node) : undefined;
    return jsxs(type, props, stable ?? key);
  };
  return toJsxRuntime(document.candidate.html, {
    Fragment,
    components,
    jsx: keyedJsx,
    jsxs: keyedJsxs,
    passNode: true,
    passKeys: true,
    ignoreInvalidStyle: true,
  }) as ReactElement;
}

export interface MarkdownDocumentRendererProps {
  readonly source: string;
  readonly sourceIdentity?: string;
  readonly streaming: boolean;
  readonly animate: boolean;
  readonly adaptive: boolean;
  readonly policy: MarkdownSyntaxPolicy;
  readonly components: Components;
  readonly className?: string;
}
export function MarkdownDocumentRenderer(props: MarkdownDocumentRendererProps) {
  const lifetime = useId();
  return (
    <MarkdownDocumentHost
      {...props}
      sourceIdentity={props.sourceIdentity ?? lifetime}
      key={props.sourceIdentity ?? lifetime}
    />
  );
}
function MarkdownDocumentHost({
  source,
  sourceIdentity,
  streaming,
  animate,
  adaptive,
  policy,
  components,
  className,
}: MarkdownDocumentRendererProps & { sourceIdentity: string }) {
  const reducedMotion = useResolvedReducedMotion();
  const [owner] = useState(() => {
    let segmenter: Intl.Segmenter | null = null;
    try {
      segmenter = new Intl.Segmenter(undefined, { granularity: "word" });
    } catch {
      /* Full text remains available without Intl.Segmenter. */
    }
    return createMarkdownDocumentOwner(segmenter);
  });
  const shouldAnimate = streaming && animate && !reducedMotion;
  const candidate = useMemo(
    () => owner.prepare({ source, sourceIdentity, streaming, animate: shouldAnimate, policy }),
    [owner, source, sourceIdentity, streaming, shouldAnimate, policy],
  );
  useLayoutEffect(() => {
    owner.commit(candidate);
  }, [owner, candidate]);
  useLayoutEffect(() => () => owner.dispose(), [owner]);
  const value = useMemo(
    () => ({
      owner,
      candidate,
      components,
      fadeDelayMs: 0,
      duration: adaptive
        ? "var(--animation-duration-streaming-text, 200ms)"
        : "var(--transition-duration-basic, 150ms)",
    }),
    [owner, candidate, components, adaptive],
  );
  return (
    <DocumentContext.Provider value={value}>
      <Streamdown
        mode="streaming"
        parseIncompleteMarkdown={false}
        animated={noAnimation}
        isAnimating={shouldAnimate}
        plugins={markdownDocumentPlugins}
        shikiTheme={codeThemes}
        BlockComponent={TypedMarkdownBlock}
        parseMarkdownIntoBlocksFn={splitDocumentSlot}
        lineNumbers={false}
        controls={{ table: false, code: { copy: true, download: false }, mermaid: true }}
        className={className}
      >
        {DOCUMENT_SLOT}
      </Streamdown>
    </DocumentContext.Provider>
  );
}
