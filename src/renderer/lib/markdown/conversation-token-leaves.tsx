import { useEffect, useState } from "react";
import { ReadonlyCodeBlock } from "@/components/shared/readonly-code-block";
import { MarkdownMermaid } from "./markdown-public-leaves";
import type { ConversationMathToken } from "./conversation-math";

export function ConversationCode({
  text,
  language,
  incomplete,
}: {
  readonly text: string;
  readonly language: string;
  readonly incomplete: boolean;
}) {
  if (language === "mermaid") return <MarkdownMermaid source={text} incomplete={incomplete} />;
  return <ReadonlyCodeBlock code={text} language={language} incomplete={incomplete} />;
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
