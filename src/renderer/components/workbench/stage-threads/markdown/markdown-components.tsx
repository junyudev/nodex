import { useEffect, useId, useState } from "react";
import type { ReactNode } from "react";
import mermaid from "mermaid";
import { getHighlighter, isSupportedLanguage } from "../../../../lib/shiki";
import { FileLinkAnchor } from "../../../shared/file-link-anchor";

interface CodeProps {
  node?: unknown;
  inline?: boolean;
  className?: string;
  children?: ReactNode;
}

interface PreProps {
  children?: ReactNode;
}

interface DetailsProps {
  children?: ReactNode;
  open?: boolean;
}

interface SummaryProps {
  children?: ReactNode;
}

interface AnchorProps {
  href?: string;
  children?: ReactNode;
}

interface ImageProps {
  src?: string;
  alt?: string;
  className?: string;
}

let mermaidInitialized = false;

function ensureMermaidInit(): void {
  if (mermaidInitialized) return;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: "default",
    suppressErrorRendering: true,
  });
  mermaidInitialized = true;
}

function sanitizeMermaidSvg(svg: string): string | null {
  if (typeof DOMParser === "undefined") return null;

  const parser = new DOMParser();
  const doc = parser.parseFromString(svg, "image/svg+xml");
  if (doc.querySelector("parsererror")) return null;

  for (const blocked of ["script", "foreignObject", "iframe", "object", "embed"]) {
    for (const node of doc.querySelectorAll(blocked)) {
      node.remove();
    }
  }

  for (const node of doc.querySelectorAll("*")) {
    for (const attr of [...node.attributes]) {
      const key = attr.name.toLowerCase();
      const value = attr.value.trim().toLowerCase();

      if (key.startsWith("on")) {
        node.removeAttribute(attr.name);
        continue;
      }

      if ((key === "href" || key === "xlink:href") && value.startsWith("javascript:")) {
        node.removeAttribute(attr.name);
      }
    }
  }

  const root = doc.documentElement;
  if (root.tagName.toLowerCase() !== "svg") return null;
  return root.outerHTML;
}

function MermaidBlock({ chart }: { chart: string }) {
  const id = useId();
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    ensureMermaidInit();

    const renderChart = async () => {
      try {
        await mermaid.parse(chart, { suppressErrors: false });
        const renderResult = await mermaid.render(`codex-mermaid-${id}`, chart);
        if (cancelled) return;
        const sanitized = sanitizeMermaidSvg(renderResult.svg);
        if (!sanitized) {
          setError("Could not safely render diagram.");
          return;
        }
        setSvg(sanitized);
      } catch (renderError) {
        if (cancelled) return;
        const message = renderError instanceof Error ? renderError.message : "Invalid Mermaid diagram.";
        setError(message);
      }
    };

    void renderChart();

    return () => {
      cancelled = true;
    };
  }, [chart, id]);

  if (error) {
    return (
      <div className="rounded-md border border-(--destructive)/30 bg-(--destructive)/10 px-3 py-2 text-sm text-(--destructive)">
        Mermaid Error: {error}
      </div>
    );
  }

  if (!svg) {
    return (
      <div className="rounded-md border border-(--border) bg-(--background-secondary) px-3 py-2 text-sm text-(--foreground-tertiary)">
        Rendering diagram...
      </div>
    );
  }

  return (
    <div className="my-2 overflow-x-auto rounded-md border border-(--border) bg-(--background-secondary) p-3">
      {/* SECURITY AUDIT: Mermaid SVG is sanitized before rendering by sanitizeMermaidSvg. */}
      <div className="min-w-fit" dangerouslySetInnerHTML={{ __html: svg }} />
    </div>
  );
}

function HighlightedCodeBlock({ code, language }: { code: string; language: string }) {
  const [highlightedHtml, setHighlightedHtml] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const lang = language.toLowerCase();
    if (!lang || !isSupportedLanguage(lang)) return;

    getHighlighter().then(async (hl) => {
      if (cancelled) return;
      const loadedLangs = hl.getLoadedLanguages();
      if (!loadedLangs.includes(lang as never)) {
        await hl.loadLanguage(lang as never);
      }
      if (cancelled) return;
      const rendered = hl.codeToHtml(code, {
        lang,
        themes: { light: "github-light", dark: "github-dark" },
      });
      setHighlightedHtml(rendered);
    });

    return () => {
      cancelled = true;
    };
  }, [code, language]);

  if (!highlightedHtml) {
    return (
      <pre className="nfm-code-block my-2 overflow-x-auto rounded-md p-4 text-sm">
        <code>{code}</code>
      </pre>
    );
  }

  return (
    <div
      className="nfm-code-block my-2 overflow-x-auto rounded-md text-sm [&_code]:bg-transparent [&_pre]:rounded-md! [&_pre]:p-4"
      // SECURITY AUDIT: Shiki escapes source tokens before returning HTML.
      dangerouslySetInnerHTML={{ __html: highlightedHtml }}
    />
  );
}

export const markdownComponents = {
  pre: ({ children }: PreProps) => <>{children}</>,

  img: ({ src, alt, className }: ImageProps) => {
    if (!src) return null;

    return (
      <img
        src={src}
        alt={alt ?? ""}
        className={`my-2 inline-block max-w-full rounded-lg ${className ?? ""}`.trim()}
        loading="lazy"
      />
    );
  },

  a: ({ href, children }: AnchorProps) => (
    <FileLinkAnchor href={href} showLocalFileTooltip>
      {children}
    </FileLinkAnchor>
  ),

  details: ({ children, open }: DetailsProps) => (
    <details open={open} className="my-2 rounded-md border border-(--border) bg-(--background-secondary) px-2 py-1 text-sm">
      {children}
    </details>
  ),

  summary: ({ children }: SummaryProps) => (
    <summary className="cursor-pointer py-1 pl-1 font-medium select-none">{children}</summary>
  ),

  code: ({ inline, className, children, ...props }: CodeProps) => {
    const languageMatch = /language-([^\s]+)/.exec(className ?? "");
    const language = languageMatch ? languageMatch[1] : "";

    const childString =
      typeof children === "string" ? children : Array.isArray(children) ? children.join("") : "";

    const isInline = typeof inline === "boolean" ? inline : !childString.includes("\n");

    if (!isInline && language === "mermaid") {
      return <MermaidBlock chart={childString} />;
    }

    if (!isInline && language) {
      const highlightLanguage = language === "shell-session" ? "shell" : language;
      return <HighlightedCodeBlock code={childString} language={highlightLanguage} />;
    }

    if (!isInline) {
      return (
        <pre>
          <code className={className} {...props}>
            {children}
          </code>
        </pre>
      );
    }

    return (
      <code className={className} {...props}>
        {children}
      </code>
    );
  },
};
