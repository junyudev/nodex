import {
  createElement,
  memo,
  useId,
  useLayoutEffect,
  useState,
  type ComponentType,
  type CSSProperties,
  type ReactNode,
} from "react";
import type { Components } from "streamdown";
import { CONVERSATION_MARKDOWN_HIDDEN_DIRECTIVES } from "../../../shared/conversation-markdown-display";
import {
  createConversationDocumentOwner,
  type ConversationRenderNode,
} from "./conversation-document";
import { decodeConversationText } from "./conversation-tokens";
import { ConversationCode, ConversationMath } from "./conversation-token-leaves";
import type { ConversationDirectiveToken } from "./conversation-directives";
import { markdownPublicLeafComponents } from "./markdown-public-leaves";
import { useResolvedReducedMotion } from "../use-reduced-motion";
import { findMarkdownOpenCodeFence } from "./markdown-prefix";

type Owner = ReturnType<typeof createConversationDocumentOwner>;
interface RenderOptions {
  readonly owner: Owner;
  readonly components: Components;
  readonly streaming: boolean;
  readonly animate: boolean;
  readonly adaptive: boolean;
  readonly renderDirective?: (token: ConversationDirectiveToken) => ReactNode | undefined;
}
const hidden = new Set<string>(
  CONVERSATION_MARKDOWN_HIDDEN_DIRECTIVES.filter((name) => name !== "code-comment"),
);

function primitive(
  tag: string,
  components: Components,
  children: ReactNode,
  props: Record<string, unknown> = {},
) {
  const Component = components[tag] ?? markdownPublicLeafComponents[tag] ?? tag;
  return createElement(Component as ComponentType<Record<string, unknown>>, props, children);
}

function TokenText({
  node,
  options,
}: {
  readonly node: ConversationRenderNode;
  readonly options: RenderOptions;
}) {
  const content = node.segments.map((segment) => segment.text).join("");
  if (!options.animate) return content;
  return node.segments.map((segment) => {
    const animate = !options.owner.timeline.isSettled(segment.key);
    return (
      <span
        key={segment.key}
        data-markdown-segment={segment.key}
        data-sd-animate={animate ? "true" : undefined}
        style={
          animate
            ? ({
                "--sd-duration": options.adaptive
                  ? "var(--animation-duration-streaming-text, 200ms)"
                  : "var(--transition-duration-basic, 150ms)",
                "--sd-easing": "cubic-bezier(.37, .55, .86, .88)",
                "--sd-delay": "0ms",
              } as CSSProperties)
            : undefined
        }
        ref={(element) => {
          if (animate && element) options.owner.timeline.attach(element, segment.key, 0);
        }}
        onAnimationEnd={(event) => {
          if (options.owner.timeline.settle(segment.key, event.target === event.currentTarget))
            event.currentTarget.removeAttribute("data-sd-animate");
        }}
      >
        {segment.text}
      </span>
    );
  });
}

function renderNodes(nodes: readonly ConversationRenderNode[], options: RenderOptions): ReactNode {
  const rendered = nodes.map((node) => {
    if (
      !options.animate &&
      node.children.length === 0 &&
      (node.token.type === "text" || node.token.type === "escape")
    )
      return node.segments.map((segment) => segment.text).join("");
    return <TokenNode key={node.key} node={node} options={options} />;
  });
  // A single text child lets React own the host's textContent when a stream settles.
  return rendered.length === 1 ? rendered[0] : rendered;
}

function TokenNode({
  node,
  options,
  incomplete = false,
}: {
  readonly node: ConversationRenderNode;
  readonly options: RenderOptions;
  readonly incomplete?: boolean;
}): ReactNode {
  const token = node.token;
  const children = () => renderNodes(node.children, options);
  switch (token.type) {
    case "space":
    case "def":
      return null;
    case "text":
    case "escape":
      return node.children.length > 0 ? children() : <TokenText node={node} options={options} />;
    case "paragraph":
      return primitive("p", options.components, children());
    case "heading":
      return primitive(`h${token.depth}`, options.components, children());
    case "strong":
      return primitive("strong", options.components, children());
    case "em":
      return primitive("em", options.components, children());
    case "del":
      return primitive("del", options.components, children());
    case "br":
      return <br />;
    case "hr":
      return <hr />;
    case "codespan":
      return primitive("inlineCode", options.components, token.text);
    case "code":
      return (
        <ConversationCode
          text={token.text}
          language={token.lang?.split(/\s/u, 1)[0] || "text"}
          incomplete={incomplete}
        />
      );
    case "math":
      return <ConversationMath token={token} streaming={options.streaming} />;
    case "html":
      return /^<br\s*\/?>$/iu.test(token.text.trim()) ? <br /> : token.text;
    case "link": {
      if (/^(?:javascript|vbscript|data):/iu.test(token.href)) return children();
      return primitive("a", options.components, children(), {
        href: token.href,
        title: token.title,
      });
    }
    case "image":
      return primitive("img", options.components, undefined, {
        src: token.href,
        alt: decodeConversationText(token.text),
        title: token.title,
      });
    case "blockquote":
      return primitive("blockquote", options.components, children());
    case "list":
      return primitive(
        token.ordered ? "ol" : "ul",
        options.components,
        token.items.map((item, index) =>
          primitive(
            "li",
            options.components,
            <>
              {item.task ? (
                <input
                  type="checkbox"
                  checked={item.checked ?? false}
                  disabled
                  aria-label={item.checked ? "Completed task" : "Incomplete task"}
                />
              ) : null}
              {renderNodes(node.items[index] ?? [], options)}
            </>,
            {
              key: node.itemKeys[index],
              className: item.task ? "task-list-item" : undefined,
            },
          ),
        ),
        {
          start: token.ordered ? token.start || 1 : undefined,
          className: token.items.some((item) => item.task) ? "contains-task-list" : undefined,
        },
      );
    case "list_item":
      return children();
    case "table": {
      const columns = token.header.length;
      const cell = (index: number, header: boolean) =>
        primitive(
          header ? "th" : "td",
          options.components,
          renderNodes(node.cells[index] ?? [], options),
          {
            key: `${node.key}:cell:${index}`,
            style: { textAlign: token.align[index % columns] ?? undefined },
          },
        );
      return (
        <div className="my-3 overflow-x-auto">
          <table>
            <thead>
              <tr>{token.header.map((_cell, index) => cell(index, true))}</tr>
            </thead>
            <tbody>
              {token.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((_cell, index) => cell(columns + rowIndex * columns + index, false))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    case "codexDirective": {
      if (hidden.has(token.name)) return null;
      const owned = options.renderDirective?.(token);
      if (owned !== undefined) return owned;
      if (token.name === "github-details" && token.block)
        return (
          <details open={token.attributes.open === "true" || undefined}>
            <summary>{String(token.attributes.summary ?? "Details")}</summary>
            {children()}
          </details>
        );
      return token.raw;
    }
  }
}

// Immutable prefix plans make this a measured render boundary; tail context is never broadcast.
const TokenBlock = memo(
  TokenNode,
  (before, after) =>
    before.node === after.node &&
    before.incomplete === after.incomplete &&
    before.options.owner === after.options.owner &&
    before.options.components === after.options.components &&
    before.options.streaming === after.options.streaming &&
    before.options.animate === after.options.animate &&
    before.options.adaptive === after.options.adaptive &&
    before.options.renderDirective === after.options.renderDirective,
);
export interface ConversationTokenRendererProps {
  readonly source: string;
  readonly sourceIdentity?: string;
  readonly streaming: boolean;
  readonly animate: boolean;
  readonly adaptive: boolean;
  readonly components: Components;
  readonly renderDirective?: RenderOptions["renderDirective"];
  readonly className?: string;
}
export function ConversationTokenRenderer(props: ConversationTokenRendererProps) {
  const lifetime = useId();
  return <ConversationTokenHost key={props.sourceIdentity ?? lifetime} {...props} />;
}
function ConversationTokenHost({
  source,
  streaming,
  animate,
  adaptive,
  components,
  renderDirective,
  className,
}: ConversationTokenRendererProps) {
  const [owner] = useState(() =>
    createConversationDocumentOwner(
      typeof Intl.Segmenter === "function"
        ? new Intl.Segmenter(undefined, { granularity: "word" })
        : null,
    ),
  );
  const reducedMotion = useResolvedReducedMotion();
  const animated = streaming && animate && !reducedMotion;
  const candidate = owner.prepare(source, streaming);
  const options: RenderOptions = {
    owner,
    components,
    streaming,
    animate: animated,
    adaptive,
    renderDirective,
  };
  useLayoutEffect(() => {
    owner.commit(candidate, animated);
  }, [owner, candidate, animated]);
  useLayoutEffect(() => {
    owner.timeline.activate();
    return () => owner.dispose();
  }, [owner]);
  const open = streaming && findMarkdownOpenCodeFence(source);
  const last = candidate.nodes.findLast((node) => node.token.type !== "space");
  return (
    <div className={className}>
      {candidate.nodes.map((node) => (
        <TokenBlock
          key={node.key}
          node={node}
          options={options}
          incomplete={open && node === last && node.token.type === "code"}
        />
      ))}
    </div>
  );
}
