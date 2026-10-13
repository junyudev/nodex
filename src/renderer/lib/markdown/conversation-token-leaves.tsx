import { useEffect, useState, type CSSProperties } from "react";
import type { HighlightResult, HighlightOptions } from "@streamdown/code";
import { streamdownCodePlugin } from "./markdown-code-highlighter";
import { NFM_CODE_THEME_PAIR } from "../syntax-highlighting";
import { MarkdownCodeCopyButton } from "./markdown-code-copy-button";
import { MarkdownMermaid } from "./markdown-public-leaves";
import type { ConversationMathToken } from "./conversation-math";

const themes: HighlightOptions["themes"] = [...NFM_CODE_THEME_PAIR];
/** The shared highlighter supplies tokens directly, with no parser or vendor provider around the leaf. */
export function ConversationCode({
  text,
  language,
  incomplete,
}: {
  readonly text: string;
  readonly language: string;
  readonly incomplete: boolean;
}) {
  const [highlighted, setHighlighted] = useState<{
    text: string;
    language: string;
    result: HighlightResult;
  } | null>(null);
  useEffect(() => {
    if (language === "mermaid") return;
    let active = true;
    const accept = (result: HighlightResult) => {
      if (active) setHighlighted({ text, language, result });
    };
    const result = streamdownCodePlugin.highlight(
      { code: text, language: language as HighlightOptions["language"], themes },
      accept,
    );
    if (result) accept(result);
    return () => {
      active = false;
    };
  }, [text, language]);
  if (language === "mermaid") return <MarkdownMermaid source={text} incomplete={incomplete} />;
  const result =
    highlighted?.text === text && highlighted.language === language ? highlighted.result : null;
  return (
    <div
      className="relative my-3 overflow-hidden rounded-lg bg-token-text-code-block-background"
      data-streamdown="code-block"
    >
      <div data-content-search-skip="true">
        <span data-streamdown="code-block-header">{language}</span>
        <div data-streamdown="code-block-actions">
          <MarkdownCodeCopyButton text={text} disabled={incomplete} />
        </div>
      </div>
      <div data-streamdown="code-block-body">
        <pre className="overflow-x-auto">
          <code>
            {result
              ? result.tokens.map((line, lineIndex) => (
                  <span key={lineIndex}>
                    {line.map((token, index) => (
                      <span
                        key={index}
                        style={
                          {
                            "--sdm-c": token.color,
                            "--sdm-tbg": token.bgColor,
                            ...token.htmlStyle,
                          } as CSSProperties
                        }
                      >
                        {token.content}
                      </span>
                    ))}
                    {lineIndex < result.tokens.length - 1 ? "\n" : ""}
                  </span>
                ))
              : text}
          </code>
        </pre>
      </div>
    </div>
  );
}

type Katex = typeof import("katex");
let mathRuntime: Promise<Katex> | null = null;
const loadMath = () => (mathRuntime ??= import("katex"));

/** A lazy math runtime and streaming error suppression have independent lifetimes. */
export function ConversationMath({
  token,
  streaming,
}: {
  readonly token: ConversationMathToken;
  readonly streaming: boolean;
}) {
  const [runtime, setRuntime] = useState<Katex | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    let active = true;
    void loadMath().then(
      (value) => {
        if (active) setRuntime(value);
      },
      () => {
        if (active) setUnavailable(true);
      },
    );
    return () => {
      active = false;
    };
  }, []);
  const props = {
    className: token.display ? "block overflow-x-auto whitespace-pre-wrap" : undefined,
    "data-math-display": token.display,
    "data-math-source": token.text,
  };
  if (unavailable) return <span {...props}>{token.text}</span>;
  if (!runtime) return streaming ? null : <span {...props}>{token.raw}</span>;
  let html: string;
  try {
    html = runtime.renderToString(token.text, {
      displayMode: token.display,
      strict: "ignore",
      trust: false,
      throwOnError: streaming,
      macros: {},
    });
  } catch (error) {
    if (streaming && error instanceof runtime.ParseError) return null;
    return <span {...props}>{token.text}</span>;
  }
  return <span {...props} dangerouslySetInnerHTML={{ __html: html }} />;
}
